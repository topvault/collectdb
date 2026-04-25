import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { ZodError, type ZodTypeAny } from 'zod';
import { parseDocument } from 'yaml';

import { GenerationMapSchema, SeriesItemsSchema } from '../schema/Schema.js';

type ValidationTarget = {
    filePath: string;
    schema?: ZodTypeAny;
    isOrphan: boolean;
};

type ValidationFailure = {
    filePath: string;
    message: string;
};

type ValidationWarning = {
    filePath: string;
    message: string;
};

type ValidationResult = {
    failures: ValidationFailure[];
    warnings: ValidationWarning[];
};

const rootArg = process.argv[2] ?? 'data';
const rootPath = path.resolve(process.cwd(), rootArg);
const skippedDirectoryNames = new Set(['test-source']);

function shouldSkipDirectory(directoryPath: string): boolean {
    return directoryPath.split(path.sep).some(segment => skippedDirectoryNames.has(segment));
}

function hasYamlExtension(fileName: string): boolean {
    return fileName.endsWith('.yaml') || fileName.endsWith('.yml');
}

function getBaseName(fileName: string): string {
    return fileName.replace(/\.(yaml|yml)$/u, '');
}

async function collectReferencedSeries(directoryPath: string, fileName: string): Promise<Set<string> | null> {
    const source = await readFile(path.join(directoryPath, fileName), 'utf8');
    const document = parseDocument(source, {
        prettyErrors: false,
        strict: true,
        uniqueKeys: true,
    });

    if (document.errors.length > 0) {
        return null;
    }

    const parsed = document.toJS();
    if (!parsed || typeof parsed !== 'object') {
        return new Set();
    }

    const referencedSeries = new Set<string>();

    for (const [generationKey, generation] of Object.entries(parsed as Record<string, unknown>)) {
        if (!generation || typeof generation !== 'object') {
            continue;
        }

        const series = (generation as { series?: unknown }).series;
        if (!series || typeof series !== 'object') {
            continue;
        }

        for (const seriesKey of Object.keys(series as Record<string, unknown>)) {
            referencedSeries.add(`${generationKey}:${seriesKey}`);
        }
    }

    return referencedSeries;
}

async function collectValidationTargets(directoryPath: string): Promise<ValidationTarget[]> {
    if (shouldSkipDirectory(directoryPath)) {
        return [];
    }

    const entries = await readdir(directoryPath, { withFileTypes: true });
    const targets: ValidationTarget[] = [];
    const seriesCatalogEntry = entries.find(entry => entry.isFile() && (entry.name === '_series.yaml' || entry.name === '_series.yml'));
    const referencedSeries = seriesCatalogEntry ? await collectReferencedSeries(directoryPath, seriesCatalogEntry.name) : null;

    for (const entry of entries) {
        if (entry.name.startsWith('.')) {
            continue;
        }

        const entryPath = path.join(directoryPath, entry.name);

        if (entry.isDirectory()) {
            if (entry.name.startsWith('_')) {
                continue;
            }

            targets.push(...(await collectValidationTargets(entryPath)));
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        if (!hasYamlExtension(entry.name)) {
            continue;
        }

        if (entry.name === '_series.yaml' || entry.name === '_series.yml') {
            targets.push({ filePath: entryPath, schema: GenerationMapSchema, isOrphan: false });
            continue;
        }

        if (entry.name.startsWith('_')) {
            continue;
        }

        const isReferenced = referencedSeries ? referencedSeries.has(getBaseName(entry.name)) : true;

        targets.push({
            filePath: entryPath,
            schema: isReferenced ? SeriesItemsSchema : undefined,
            isOrphan: !isReferenced,
        });
    }

    return targets;
}

function formatZodError(error: ZodError): string[] {
    return error.issues.map(issue => {
        const issuePath = issue.path.length > 0 ? issue.path.join('.') : '<root>';
        return `${issuePath}: ${issue.message}`;
    });
}

function formatYamlError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

async function validateFile(target: ValidationTarget): Promise<ValidationResult> {
    const source = await readFile(target.filePath, 'utf8');
    const document = parseDocument(source, {
        prettyErrors: false,
        strict: true,
        uniqueKeys: true,
    });

    if (document.errors.length > 0) {
        const messages = document.errors.map(error => ({
            filePath: target.filePath,
            message: formatYamlError(error),
        }));

        if (target.isOrphan) {
            return {
                failures: [],
                warnings: [
                    {
                        filePath: target.filePath,
                        message: 'Orphaned YAML file is not referenced by _series.yaml.',
                    },
                    ...messages,
                ],
            };
        }

        return { failures: messages, warnings: [] };
    }

    if (target.isOrphan || !target.schema) {
        return {
            failures: [],
            warnings: [
                {
                    filePath: target.filePath,
                    message: 'Orphaned YAML file is not referenced by _series.yaml; skipping schema validation.',
                },
            ],
        };
    }

    const parsed = document.toJS();
    const result = target.schema.safeParse(parsed);

    if (result.success) {
        return { failures: [], warnings: [] };
    }

    return {
        failures: formatZodError(result.error).map(message => ({
            filePath: target.filePath,
            message,
        })),
        warnings: [],
    };
}

function printGroupedMessages(
    issues: Array<ValidationFailure | ValidationWarning>,
    write: (message?: string) => void
): void {
    const groupedIssues = new Map<string, string[]>();

    for (const issue of issues) {
        const relativePath = path.relative(process.cwd(), issue.filePath);
        const messages = groupedIssues.get(relativePath) ?? [];
        messages.push(issue.message);
        groupedIssues.set(relativePath, messages);
    }

    for (const [filePath, messages] of groupedIssues) {
        write(filePath);

        for (const message of messages) {
            write(`  - ${message}`);
        }
    }
}

async function main(): Promise<void> {
    const targets = await collectValidationTargets(rootPath);
    const failures: ValidationFailure[] = [];
    const warnings: ValidationWarning[] = [];

    for (const target of targets) {
        const result = await validateFile(target);
        failures.push(...result.failures);
        warnings.push(...result.warnings);
    }

    if (warnings.length > 0) {
        printGroupedMessages(warnings, message => console.warn(message));
    }

    if (failures.length === 0) {
        const warningSuffix = warnings.length > 0 ? ` with ${warnings.length} warnings` : '';
        console.log(`Validated ${targets.length} YAML files in ${path.relative(process.cwd(), rootPath) || '.'}${warningSuffix}.`);
        return;
    }

    printGroupedMessages(failures, message => console.error(message));

    console.error(`Validation failed for ${new Set(failures.map(failure => failure.filePath)).size} files (${failures.length} issues).`);
    process.exitCode = 1;
}

await main();