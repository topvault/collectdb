import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { Document, YAMLMap } from 'yaml';
import { parseDocument } from 'yaml';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import type { RegionDescriptor, SeriesDescriptor } from '../schema/Schema.js';
import { writeFormattedYaml } from './lib/write-formatted-yaml.js';

const argv = await yargs(hideBin(process.argv))
    .command('* [collectibleType] [region] [seriesId]', '')
    .positional('collectibleType', {
        describe: 'Collectible type directory under data, for example pokemon-card',
        type: 'string',
    })
    .positional('region', {
        describe: 'Region directory under the collectible type, for example english',
        type: 'string',
    })
    .positional('seriesId', {
        describe: 'Optional generation and series key to limit processing, for example base:base-set',
        type: 'string',
    })
    .option('check', {
        describe: 'Check for missing or invalid index values without writing updates',
        type: 'boolean',
        default: false,
    })
    .parse();

const { check: checkOnly, collectibleType, region, seriesId } = argv;
const skippedDirectoryNames = new Set(['test-source']);

type ProcessingTarget = {
    collectibleType: string;
    region: string;
};

type ProcessingSummary = {
    filesUpdated: number;
    indexesAdded: number;
    missingIndexes: number;
    recordsChecked: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReferenceItem(value: unknown): boolean {
    return isRecord(value) && 'referenceOf' in value;
}

function resolveYamlFile(directoryPath: string, baseName: string): string {
    const yamlPath = path.join(directoryPath, `${baseName}.yaml`);
    if (fs.existsSync(yamlPath)) {
        return yamlPath;
    }

    const ymlPath = path.join(directoryPath, `${baseName}.yml`);
    if (fs.existsSync(ymlPath)) {
        return ymlPath;
    }

    throw new Error(`Could not find ${baseName}.yaml under ${directoryPath}`);
}

function parseYamlFile<T>(filePath: string): { yamlDoc: Document; parsed: T } {
    const source = fs.readFileSync(filePath, 'utf8');
    const yamlDoc = parseDocument(source, {
        prettyErrors: false,
        strict: true,
        uniqueKeys: true,
    });

    if (yamlDoc.errors.length > 0) {
        throw new Error(`${filePath}: ${yamlDoc.errors.map(error => error.message).join('; ')}`);
    }

    return {
        yamlDoc,
        parsed: yamlDoc.toJS() as T,
    };
}

function hasSeriesCatalog(regionPath: string): boolean {
    return fs.existsSync(path.join(regionPath, '_region.yaml')) || fs.existsSync(path.join(regionPath, '_region.yml'));
}

function getListedSeriesIds(regionData: RegionDescriptor): Set<string> {
    const listedSeriesIds = new Set<string>();

    if (!regionData.generations || !isRecord(regionData.generations)) {
        return listedSeriesIds;
    }

    for (const [generationKey, generation] of Object.entries(regionData.generations)) {
        if (!generation.series) {
            continue;
        }

        if (Array.isArray(generation.series)) {
            for (const seriesKey of generation.series) {
                listedSeriesIds.add(`${generationKey}:${seriesKey}`);
            }
            continue;
        }

        if (!isRecord(generation.series)) {
            continue;
        }

        for (const seriesKey of Object.keys(generation.series)) {
            listedSeriesIds.add(`${generationKey}:${seriesKey}`);
        }
    }

    return listedSeriesIds;
}

function getProcessingTargets(targetCollectibleType?: string, targetRegion?: string): ProcessingTarget[] {
    if (targetRegion && !targetCollectibleType) {
        throw new Error('A region requires a collectible type.');
    }

    if (targetCollectibleType && targetRegion) {
        return [{ collectibleType: targetCollectibleType, region: targetRegion }];
    }

    const dataRoot = path.resolve('data');

    if (targetCollectibleType) {
        const collectibleTypePath = path.join(dataRoot, targetCollectibleType);
        if (!fs.existsSync(collectibleTypePath) || !fs.statSync(collectibleTypePath).isDirectory()) {
            throw new Error(`Cannot find collectible type directory: ${collectibleTypePath}`);
        }

        return fs
            .readdirSync(collectibleTypePath)
            .filter(entry => {
                const fullPath = path.join(collectibleTypePath, entry);
                return fs.statSync(fullPath).isDirectory() && !entry.startsWith('.') && hasSeriesCatalog(fullPath);
            })
            .sort((left, right) => left.localeCompare(right))
            .map(regionName => ({ collectibleType: targetCollectibleType, region: regionName }));
    }

    return fs
        .readdirSync(dataRoot)
        .filter(entry => {
            const fullPath = path.join(dataRoot, entry);
            return fs.statSync(fullPath).isDirectory() && !entry.startsWith('.') && !skippedDirectoryNames.has(entry);
        })
        .sort((left, right) => left.localeCompare(right))
        .flatMap(collectibleTypeName => {
            const collectibleTypePath = path.join(dataRoot, collectibleTypeName);

            return fs
                .readdirSync(collectibleTypePath)
                .filter(entry => {
                    const fullPath = path.join(collectibleTypePath, entry);
                    return fs.statSync(fullPath).isDirectory() && !entry.startsWith('.') && hasSeriesCatalog(fullPath);
                })
                .sort((left, right) => left.localeCompare(right))
                .map(regionName => ({
                    collectibleType: collectibleTypeName,
                    region: regionName,
                }));
        });
}

function inferIndexFromItemKey(itemKey: string): string {
    const keyParts = itemKey.split('-');
    const suffix = keyParts[keyParts.length - 1] ?? '';

    return /\d+[a-zA-Z]?$/.test(suffix) ? suffix : '';
}

function normalizeIndexValue(value: unknown): string | undefined {
    if (typeof value === 'number') {
        return String(value);
    }

    if (typeof value === 'string') {
        return value;
    }

    return undefined;
}

function toYamlIndexValue(indexValue: string): number | string {
    if (/^(0|[1-9]\d*)$/u.test(indexValue)) {
        return Number.parseInt(indexValue, 10);
    }

    return indexValue;
}

function validateExistingIndex(indexValue: string, location: string): void {
    if (indexValue === '') {
        throw new Error(`${location}: index must not be empty.`);
    }
}

function backfillEntries(
    yamlDoc: Document,
    sectionPath: (string | number)[],
    entries: Record<string, unknown>,
    seriesRef: string,
    missingIndexes: string[]
): { updated: boolean; indexesAdded: number; missingIndexes: number; recordsChecked: number } {
    let updated = false;
    let indexesAdded = 0;
    let missingIndexCount = 0;
    let recordsChecked = 0;

    for (const [itemKey, itemValue] of Object.entries(entries)) {
        if (!isRecord(itemValue) || isReferenceItem(itemValue)) {
            continue;
        }

        recordsChecked += 1;
        const location = `${seriesRef} ${[...sectionPath, itemKey, 'index'].join('.')}`;
        const explicitIndex = normalizeIndexValue(itemValue.index);

        if (explicitIndex !== undefined) {
            validateExistingIndex(explicitIndex, location);
            continue;
        }

        const inferredIndex = inferIndexFromItemKey(itemKey);
        if (inferredIndex === '') {
            continue;
        }

        if (checkOnly) {
            missingIndexes.push(`${location}: missing index "${inferredIndex}".`);
            missingIndexCount += 1;
            continue;
        }

        const itemNode = yamlDoc.getIn([...sectionPath, itemKey], true) as YAMLMap;
        itemNode.set('index', toYamlIndexValue(inferredIndex));
        updated = true;
        indexesAdded += 1;
    }

    return { updated, indexesAdded, missingIndexes: missingIndexCount, recordsChecked };
}

async function processSeriesFile(seriesFilePath: string, seriesRef: string): Promise<ProcessingSummary> {
    const { yamlDoc, parsed } = parseYamlFile<SeriesDescriptor>(seriesFilePath);
    const missingIndexes: string[] = [];
    let updated = false;
    let indexesAdded = 0;
    let missingIndexCount = 0;
    let recordsChecked = 0;

    const itemResult = backfillEntries(yamlDoc, ['items'], parsed.items, seriesRef, missingIndexes);
    updated ||= itemResult.updated;
    indexesAdded += itemResult.indexesAdded;
    missingIndexCount += itemResult.missingIndexes;
    recordsChecked += itemResult.recordsChecked;

    if (parsed.products) {
        const productResult = backfillEntries(yamlDoc, ['products'], parsed.products, seriesRef, missingIndexes);
        updated ||= productResult.updated;
        indexesAdded += productResult.indexesAdded;
        missingIndexCount += productResult.missingIndexes;
        recordsChecked += productResult.recordsChecked;
    }

    if (parsed.additional) {
        for (const [groupKey, groupValue] of Object.entries(parsed.additional)) {
            const additionalResult = backfillEntries(yamlDoc, ['additional', groupKey, 'items'], groupValue.items, seriesRef, missingIndexes);
            updated ||= additionalResult.updated;
            indexesAdded += additionalResult.indexesAdded;
            missingIndexCount += additionalResult.missingIndexes;
            recordsChecked += additionalResult.recordsChecked;
        }
    }

    if (checkOnly) {
        for (const message of missingIndexes) {
            console.error(message);
        }

        return {
            filesUpdated: 0,
            indexesAdded,
            missingIndexes: missingIndexCount,
            recordsChecked,
        };
    }

    if (updated) {
        await writeFormattedYaml(seriesFilePath, yamlDoc);
    }

    return {
        filesUpdated: updated ? 1 : 0,
        indexesAdded,
        missingIndexes: 0,
        recordsChecked,
    };
}

async function main(): Promise<void> {
    const targets = getProcessingTargets(collectibleType, region);
    const requestedSeriesId = seriesId ?? null;
    const summary: ProcessingSummary = {
        filesUpdated: 0,
        indexesAdded: 0,
        missingIndexes: 0,
        recordsChecked: 0,
    };

    for (const target of targets) {
        const regionPath = path.resolve('data', target.collectibleType, target.region);
        const regionCatalogPath = resolveYamlFile(regionPath, '_region');
        const { parsed: regionData } = parseYamlFile<RegionDescriptor>(regionCatalogPath);
        const listedSeriesIds = [...getListedSeriesIds(regionData)].sort((left, right) => left.localeCompare(right));

        if (requestedSeriesId && !listedSeriesIds.includes(requestedSeriesId)) {
            throw new Error(`Series '${requestedSeriesId}' is not listed in ${regionCatalogPath}`);
        }

        for (const currentSeriesId of listedSeriesIds) {
            if (requestedSeriesId && currentSeriesId !== requestedSeriesId) {
                continue;
            }

            const seriesFilePath = resolveYamlFile(regionPath, currentSeriesId);
            const result = await processSeriesFile(seriesFilePath, `${target.collectibleType}/${target.region}/${currentSeriesId}`);
            summary.filesUpdated += result.filesUpdated;
            summary.indexesAdded += result.indexesAdded;
            summary.missingIndexes += result.missingIndexes;
            summary.recordsChecked += result.recordsChecked;
        }
    }

    if (checkOnly) {
        if (summary.missingIndexes > 0) {
            console.error(`Index check failed: ${summary.missingIndexes} missing indexes across ${summary.recordsChecked} records.`);
            process.exitCode = 1;
            return;
        }

        console.log(`Index check passed for ${summary.recordsChecked} records.`);
        return;
    }

    console.log(`Added ${summary.indexesAdded} missing indexes across ${summary.filesUpdated} files.`);
}

await main();