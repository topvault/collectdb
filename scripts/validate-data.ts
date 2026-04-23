import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { ZodError, type ZodTypeAny } from 'zod';
import { parseDocument } from 'yaml';

import { GenerationMapSchema, SeriesItemsSchema } from '../schema/Schema.js';

type ValidationTarget = {
    filePath: string;
    schema: ZodTypeAny;
};

type ValidationFailure = {
    filePath: string;
    message: string;
};

const rootArg = process.argv[2] ?? 'data';
const rootPath = path.resolve(process.cwd(), rootArg);

async function collectValidationTargets(directoryPath: string): Promise<ValidationTarget[]> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const targets: ValidationTarget[] = [];

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

        if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) {
            continue;
        }

        if (entry.name === '_series.yaml') {
            targets.push({ filePath: entryPath, schema: GenerationMapSchema });
            continue;
        }

        if (entry.name.startsWith('_')) {
            continue;
        }

        targets.push({ filePath: entryPath, schema: SeriesItemsSchema });
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

async function validateFile(target: ValidationTarget): Promise<ValidationFailure[]> {
    const source = await readFile(target.filePath, 'utf8');
    const document = parseDocument(source, {
        prettyErrors: false,
        strict: true,
        uniqueKeys: true,
    });

    if (document.errors.length > 0) {
        return document.errors.map(error => ({
            filePath: target.filePath,
            message: formatYamlError(error),
        }));
    }

    const parsed = document.toJS();
    const result = target.schema.safeParse(parsed);

    if (result.success) {
        return [];
    }

    return formatZodError(result.error).map(message => ({
        filePath: target.filePath,
        message,
    }));
}

async function main(): Promise<void> {
    const targets = await collectValidationTargets(rootPath);
    const failures: ValidationFailure[] = [];

    for (const target of targets) {
        failures.push(...(await validateFile(target)));
    }

    if (failures.length === 0) {
        console.log(`Validated ${targets.length} YAML files in ${path.relative(process.cwd(), rootPath) || '.'}.`);
        return;
    }

    const groupedFailures = new Map<string, string[]>();

    for (const failure of failures) {
        const relativePath = path.relative(process.cwd(), failure.filePath);
        const messages = groupedFailures.get(relativePath) ?? [];
        messages.push(failure.message);
        groupedFailures.set(relativePath, messages);
    }

    for (const [filePath, messages] of groupedFailures) {
        console.error(filePath);

        for (const message of messages) {
            console.error(`  - ${message}`);
        }
    }

    console.error(`Validation failed for ${groupedFailures.size} files (${failures.length} issues).`);
    process.exitCode = 1;
}

await main();