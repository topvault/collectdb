// A cache of what a checker learned from each data file, keyed by the file's path and a hash of its
// contents, so a run only parses the files that changed since the last one. Each checker stores its
// own small summary per file (the IDs it saw, the references it could not resolve) and still runs its
// checks across files against the summaries.
//
// The cache lives in .cache/checks/<name>.json. It is thrown away whenever the checker code, the
// schema or the installed packages change, because a summary written by older code may not match
// what the new code would find. Set COLLECTDB_CHECK_CACHE=off to run without it.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const CACHE_DIR = path.resolve('.cache', 'checks');
/** Bump to discard every cache written by an older layout of this file. */
const FORMAT = 1;

type CacheFile<T> = {
    version: string;
    entries: Record<string, { hash: string; value: T }>;
};

function hashText(text: string): string {
    return createHash('sha1').update(text).digest('hex');
}

function listFiles(directory: string): string[] {
    if (!fs.existsSync(directory)) {
        return [];
    }

    return fs
        .readdirSync(directory, { withFileTypes: true, recursive: true })
        .filter(entry => entry.isFile())
        .map(entry => path.join(entry.parentPath, entry.name))
        .sort();
}

/** A hash of everything that decides what a checker reports: its code, the schema and the package lock. */
function checkerVersion(name: string): string {
    const hash = createHash('sha1').update(`${FORMAT}\0${name}\0`);
    for (const filePath of [...listFiles('scripts'), ...listFiles('schema'), 'package-lock.json']) {
        if (fs.existsSync(filePath)) {
            hash.update(filePath).update('\0').update(fs.readFileSync(filePath)).update('\0');
        }
    }
    return hash.digest('hex');
}

export class CheckCache<T> {
    private readonly filePath: string;
    private readonly enabled: boolean;
    private readonly version: string;
    private readonly previous: CacheFile<T>['entries'];
    private readonly current = new Map<string, { hash: string; value: T }>();
    hits = 0;
    misses = 0;

    constructor(name: string) {
        this.filePath = path.join(CACHE_DIR, `${name}.json`);
        this.enabled = process.env.COLLECTDB_CHECK_CACHE !== 'off';
        this.version = this.enabled ? checkerVersion(name) : '';
        this.previous = this.enabled ? this.load() : {};
    }

    private load(): CacheFile<T>['entries'] {
        try {
            const file = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as CacheFile<T>;
            return file.version === this.version ? file.entries : {};
        } catch {
            return {};
        }
    }

    private key(filePath: string): string {
        return path.relative(process.cwd(), path.resolve(filePath));
    }

    /** The summary stored for this file, when its contents have not changed since. */
    get(filePath: string, source: string): T | undefined {
        if (!this.enabled) {
            return undefined;
        }

        const key = this.key(filePath);
        const entry = this.previous[key];
        const hash = hashText(source);
        if (entry && entry.hash === hash) {
            this.current.set(key, entry);
            this.hits += 1;
            return entry.value;
        }

        this.misses += 1;
        return undefined;
    }

    set(filePath: string, source: string, value: T): void {
        if (this.enabled) {
            this.current.set(this.key(filePath), { hash: hashText(source), value });
        }
    }

    /**
     * Writes the summaries used or made this run. Ones from earlier runs are kept while their file
     * still exists, so checking one region does not drop the rest.
     */
    save(): void {
        if (!this.enabled) {
            return;
        }

        const entries: CacheFile<T>['entries'] = {};
        for (const [key, entry] of Object.entries(this.previous)) {
            if (!this.current.has(key) && fs.existsSync(key)) {
                entries[key] = entry;
            }
        }
        for (const [key, entry] of this.current) {
            entries[key] = entry;
        }

        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const temporary = `${this.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({ version: this.version, entries } satisfies CacheFile<T>));
        fs.renameSync(temporary, this.filePath);
    }

    /** "1,234 of 4,564 files from cache", for a checker's closing line. */
    describe(): string {
        if (!this.enabled) {
            return 'cache off';
        }
        return `${this.hits.toLocaleString('en-US')} of ${(this.hits + this.misses).toLocaleString('en-US')} files from cache`;
    }
}
