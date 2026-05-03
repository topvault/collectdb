import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ZodError, type ZodTypeAny } from 'zod';
import { parseDocument } from 'yaml';

import { CollectibleTypeSchema, RegionSchema, SeriesSchema } from '../schema/Schema.js';
import { getSeriesIdFromFilePath } from './lib/series-path.js';

type ValidationTarget = {
    filePath: string;
    kind: 'collectible-type' | 'region' | 'series-items';
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

type ValidationCollection = {
    targets: ValidationTarget[];
    failures: ValidationFailure[];
};

const rootArg = process.argv[2] ?? 'data';
const rootPath = path.resolve(process.cwd(), rootArg);
const skippedDirectoryNames = new Set(['test-source']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shouldSkipDirectory(directoryPath: string): boolean {
    return directoryPath.split(path.sep).some(segment => skippedDirectoryNames.has(segment));
}

function hasYamlExtension(fileName: string): boolean {
    return fileName.endsWith('.yaml') || fileName.endsWith('.yml');
}

function getBaseName(fileName: string): string {
    return fileName.replace(/\.(yaml|yml)$/u, '');
}

function findYamlFileName(entries: Dirent<string>[], baseName: string): string | undefined {
    return entries.find(entry => entry.isFile() && (entry.name === `${baseName}.yaml` || entry.name === `${baseName}.yml`))?.name;
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await stat(filePath);
        return true;
    } catch {
        return false;
    }
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
    const generations = (parsed as { generations?: unknown }).generations;
    if (!generations || typeof generations !== 'object') {
        return referencedSeries;
    }

    for (const [generationKey, generation] of Object.entries(generations as Record<string, unknown>)) {
        if (!generation || typeof generation !== 'object') {
            continue;
        }

        const series = (generation as { series?: unknown }).series;
        if (!series) {
            continue;
        }

        if (Array.isArray(series)) {
            for (const seriesKey of series) {
                if (typeof seriesKey === 'string' && seriesKey.length > 0) {
                    referencedSeries.add(`${generationKey}:${seriesKey}`);
                }
            }
            continue;
        }

        if (typeof series !== 'object') {
            continue;
        }

        for (const seriesKey of Object.keys(series as Record<string, unknown>)) {
            referencedSeries.add(`${generationKey}:${seriesKey}`);
        }
    }

    return referencedSeries;
}

async function isRegionDirectory(directoryPath: string): Promise<boolean> {
    return (await fileExists(path.join(directoryPath, '_region.yaml'))) || (await fileExists(path.join(directoryPath, '_region.yml')));
}

async function getRegionDirectoryNames(entries: Dirent<string>[], directoryPath: string): Promise<string[]> {
    const regionNames: string[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) {
            continue;
        }

        const entryPath = path.join(directoryPath, entry.name);
        if (await isRegionDirectory(entryPath)) {
            regionNames.push(entry.name);
        }
    }

    return regionNames.sort((left, right) => left.localeCompare(right));
}

async function collectRegionValidationTargets(
    directoryPath: string,
    regionPath = directoryPath,
    referencedSeries?: Set<string> | null
): Promise<ValidationTarget[]> {
    if (shouldSkipDirectory(directoryPath)) {
        return [];
    }

    const entries = await readdir(directoryPath, { withFileTypes: true });
    const targets: ValidationTarget[] = [];
    const regionCatalogEntry = entries.find(entry => entry.isFile() && (entry.name === '_region.yaml' || entry.name === '_region.yml'));
    const nextReferencedSeries =
        referencedSeries ?? (regionCatalogEntry ? await collectReferencedSeries(directoryPath, regionCatalogEntry.name) : null);

    for (const entry of entries) {
        if (entry.name.startsWith('.')) {
            continue;
        }

        const entryPath = path.join(directoryPath, entry.name);

        if (entry.isDirectory()) {
            if (entry.name.startsWith('_')) {
                continue;
            }

            const nested = await collectRegionValidationTargets(entryPath, regionPath, nextReferencedSeries);
            targets.push(...nested);
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        if (!hasYamlExtension(entry.name)) {
            continue;
        }

        if (entry.name === '_region.yaml' || entry.name === '_region.yml') {
            targets.push({ filePath: entryPath, kind: 'region', schema: RegionSchema, isOrphan: false });
            continue;
        }

        if (entry.name.startsWith('_')) {
            continue;
        }

        const seriesId = getSeriesIdFromFilePath(regionPath, entryPath);
        const isReferenced = seriesId ? (nextReferencedSeries ? nextReferencedSeries.has(seriesId) : true) : true;

        targets.push({
            filePath: entryPath,
            kind: 'series-items',
            schema: isReferenced ? SeriesSchema : undefined,
            isOrphan: !isReferenced,
        });
    }

    return targets;
}

async function collectCollectibleTypeValidation(directoryPath: string): Promise<ValidationCollection> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const targets: ValidationTarget[] = [];
    const failures: ValidationFailure[] = [];
    const typeFileName = findYamlFileName(entries, '_type');

    if (!typeFileName) {
        failures.push({
            filePath: path.join(directoryPath, '_type.yaml'),
            message: 'Missing collectible type metadata file.',
        });
    } else {
        targets.push({
            filePath: path.join(directoryPath, typeFileName),
            kind: 'collectible-type',
            schema: CollectibleTypeSchema,
            isOrphan: false,
        });
    }

    const regionNames = await getRegionDirectoryNames(entries, directoryPath);
    for (const regionName of regionNames) {
        targets.push(...(await collectRegionValidationTargets(path.join(directoryPath, regionName))));
    }

    return { targets, failures };
}

async function collectValidationTargets(directoryPath: string): Promise<ValidationCollection> {
    if (shouldSkipDirectory(directoryPath)) {
        return { targets: [], failures: [] };
    }

    const entries = await readdir(directoryPath, { withFileTypes: true });
    const regionCatalogEntry = findYamlFileName(entries, '_region');
    if (regionCatalogEntry) {
        return {
            targets: await collectRegionValidationTargets(directoryPath),
            failures: [],
        };
    }

    const regionDirectoryNames = await getRegionDirectoryNames(entries, directoryPath);
    const isCollectibleTypeDirectory = findYamlFileName(entries, '_type') !== undefined || regionDirectoryNames.length > 0;

    if (isCollectibleTypeDirectory) {
        return collectCollectibleTypeValidation(directoryPath);
    }

    const targets: ValidationTarget[] = [];
    const failures: ValidationFailure[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
            continue;
        }

        const nested = await collectValidationTargets(path.join(directoryPath, entry.name));
        targets.push(...nested.targets);
        failures.push(...nested.failures);
    }

    return { targets, failures };
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

function collectInvalidItemIntegrationEditionKeys(parsed: unknown): string[] {
    if (!isRecord(parsed) || !isRecord(parsed.items)) {
        return [];
    }

    const failures: string[] = [];

    for (const [itemKey, itemValue] of Object.entries(parsed.items)) {
        if (!isRecord(itemValue)) {
            continue;
        }

        const editions = itemValue.editions;
        const integrations = itemValue.integrations;
        if (!isRecord(editions) || !isRecord(integrations)) {
            continue;
        }

        const editionKeys = Object.keys(editions);
        const editionKeySet = new Set(editionKeys);

        for (const [integrationKey, integrationValue] of Object.entries(integrations)) {
            if (!isRecord(integrationValue)) {
                continue;
            }

            const invalidKeys = Object.keys(integrationValue).filter(key => !editionKeySet.has(key));
            if (invalidKeys.length === 0) {
                continue;
            }

            const editionsLabel = editionKeys.length > 0 ? editionKeys.join(', ') : '<none>';
            failures.push(
                `items.${itemKey}.integrations.${integrationKey}: contains keys not defined in editions: ${invalidKeys.join(', ')} (editions: ${editionsLabel})`
            );
        }
    }

    return failures;
}

async function collectCollectibleTypeRegionIssues(filePath: string, parsed: unknown): Promise<string[]> {
    if (!isRecord(parsed) || !Array.isArray(parsed.regions)) {
        return [];
    }

    const entries = await readdir(path.dirname(filePath), { withFileTypes: true });
    const actualRegionNames = await getRegionDirectoryNames(entries, path.dirname(filePath));
    const declaredRegionNames = parsed.regions
        .filter((regionName): regionName is string => typeof regionName === 'string')
        .sort((left, right) => left.localeCompare(right));
    const failures: string[] = [];
    const missingRegionNames = actualRegionNames.filter(regionName => !declaredRegionNames.includes(regionName));
    const unknownRegionNames = declaredRegionNames.filter(regionName => !actualRegionNames.includes(regionName));

    if (missingRegionNames.length > 0) {
        failures.push(`regions: missing entries for directories: ${missingRegionNames.join(', ')}`);
    }

    if (unknownRegionNames.length > 0) {
        failures.push(`regions: contains entries with no matching directory: ${unknownRegionNames.join(', ')}`);
    }

    return failures;
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
                        message: 'Orphaned YAML file is not referenced by _region.yaml.',
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
                    message: 'Orphaned YAML file is not referenced by _region.yaml; skipping schema validation.',
                },
            ],
        };
    }

    const parsed = document.toJS();
    const result = target.schema.safeParse(parsed);

    if (result.success) {
        const semanticFailures = [
            ...(target.kind === 'collectible-type' ? await collectCollectibleTypeRegionIssues(target.filePath, parsed) : []),
            ...(target.kind === 'series-items' ? collectInvalidItemIntegrationEditionKeys(parsed) : []),
        ].map(message => ({
            filePath: target.filePath,
            message,
        }));

        if (semanticFailures.length === 0) {
            return { failures: [], warnings: [] };
        }

        return { failures: semanticFailures, warnings: [] };
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
    const collection = await collectValidationTargets(rootPath);
    const targets = collection.targets;
    const failures: ValidationFailure[] = [...collection.failures];
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