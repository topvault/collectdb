import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { validate as validateUuid, v4 as uuidv4 } from 'uuid';
import type { Document, YAMLMap } from 'yaml';
import { parseDocument } from 'yaml';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import type {
    AdditionalItem,
    DiscreteItem,
    RegionDescriptor,
    ReferenceItem,
    SeriesDescriptor,
    Variant,
} from '../schema/Schema.js';
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
        describe: 'Check for missing or colliding IDs without writing updates',
        type: 'boolean',
        default: false,
    })
    .parse();

type EditionIdMap = Record<string, string | null>;
type SnagVariant = Omit<Variant, 'id'> & { id?: string };
type SnagDiscreteItem = Omit<DiscreteItem, 'editions' | 'variants'> & {
    id?: string;
    editions?: EditionIdMap;
    variants?: Record<string, SnagVariant>;
};
type SnagItem = SnagDiscreteItem | ReferenceItem;
type SnagAdditionalItem = Omit<AdditionalItem, 'id' | 'variants'> & {
    id?: string;
    variants?: Record<string, SnagVariant>;
};
type SnagAdditionalEntry = SnagAdditionalItem | ReferenceItem;

interface SnagYamlData {
    editions?: SeriesDescriptor['editions'];
    items?: Record<string, SnagItem>;
    products?: Record<string, SnagItem>;
    additional?: Record<string, { items: Record<string, SnagAdditionalEntry> }>;
}

const observedIds = new Set<string>();

function recordObservedId(id: string, location: string): void {
    if (!validateUuid(id)) {
        console.error(`Invalid UUID found for ${id} at ${location}.`);
        process.exit(1);
    }

    if (observedIds.has(id)) {
        console.error(`ID collision found for ${id} at ${location}.`);
        process.exit(1);
    }

    observedIds.add(id);
}

function snagId(location: string, checkOnly: boolean): string {
    if (checkOnly) {
        console.error(`Missing ID at ${location}.`);
        process.exit(1);
    }

    return uuidv4();
}

function isReferenceItem(item: SnagItem | SnagAdditionalEntry): item is ReferenceItem {
    return 'referenceOf' in item;
}

function normalizeEditionMap(editions: EditionIdMap | undefined, defaults: string[]): EditionIdMap {
    if (!editions) {
        return defaults.reduce<EditionIdMap>((acc, editionKey) => {
            acc[editionKey] = null;
            return acc;
        }, {});
    }

    return editions;
}

interface AddIdsResult {
    updated: boolean;
    idsObserved: number;
    idsAdded: number;
}

interface ReadYamlFileResult {
    seriesObserved: number;
    idsObserved: number;
    idsAdded: number;
}

interface ProcessingTarget {
    collectibleType: string;
    region: string;
}

const skippedDirectoryNames = new Set(['test-source']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRegionFilePath(collectibleType: string, region: string): string {
    return path.resolve('data', collectibleType, region, '_region.yaml');
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

function getProcessingTargets(collectibleType?: string, region?: string): ProcessingTarget[] {
    if (region && !collectibleType) {
        throw new Error('A region requires a collectible type.');
    }

    if (collectibleType && region) {
        return [{ collectibleType, region }];
    }

    const dataRoot = path.resolve('data');

    if (collectibleType) {
        const collectibleTypePath = path.join(dataRoot, collectibleType);
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
            .map(regionName => ({ collectibleType, region: regionName }));
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

function addVariantIds(
    yamlDoc: Document,
    nodePath: (string | number)[],
    variants: Record<string, SnagVariant>,
    seriesRef: string,
    locationPrefix: string,
    checkOnly: boolean
): { updated: boolean; idsObserved: number; idsAdded: number } {
    let updated = false;
    let idsObserved = 0;
    let idsAdded = 0;

    for (const variantKey of Object.keys(variants)) {
        const location = `${seriesRef} ${locationPrefix}.variants.${variantKey}.id`;
        const variant = variants[variantKey];

        if (variant.id) {
            recordObservedId(variant.id, location);
            idsObserved += 1;
            continue;
        }

        variant.id = snagId(location, checkOnly);
        recordObservedId(variant.id, location);
        idsObserved += 1;
        idsAdded += 1;

        const variantNode = yamlDoc.getIn([...nodePath, 'variants', variantKey], true) as YAMLMap;
        variantNode.set('id', variant.id);
        updated = true;
    }

    return { updated, idsObserved, idsAdded };
}

function processEditionEntries(
    yamlDoc: Document,
    entries: Record<string, SnagItem>,
    sectionKey: 'items' | 'products',
    seriesRef: string,
    editions: string[],
    checkOnly: boolean
): { updated: boolean; idsObserved: number; idsAdded: number } {
    let updated = false;
    let idsObserved = 0;
    let idsAdded = 0;
    const validEditions = new Set(editions);

    for (const entryKey of Object.keys(entries)) {
        const entry = entries[entryKey];
        const entryNode = yamlDoc.getIn([sectionKey, entryKey], true) as YAMLMap;

        if ('id' in entry) {
            if (!checkOnly) {
                delete entry.id;
                entryNode.delete('id');
                updated = true;
            }
        }

        if (isReferenceItem(entry)) {
            continue;
        }

        const locationPrefix = `${sectionKey}.${entryKey}`;
        if (Array.isArray(entry.editions)) {
            console.error(
                `Legacy editions array found at ${seriesRef} ${locationPrefix}.editions. Use an object map with empty-string values instead.`
            );
            process.exit(1);
        }

        const normalizedEditions = normalizeEditionMap(entry.editions, editions);
        let updatedEditions = false;

        for (const editionKey of Object.keys(normalizedEditions)) {
            if (!validEditions.has(editionKey)) {
                console.log(`Edition ${editionKey} in ${seriesRef} ${locationPrefix} is not defined in series.`, Object.keys(normalizedEditions), editions);
                process.exit(1);
            }

            const location = `${seriesRef} ${locationPrefix}.editions.${editionKey}`;
            const existingId = normalizedEditions[editionKey];

            if (existingId) {
                recordObservedId(existingId, location);
                idsObserved += 1;
                continue;
            }

            normalizedEditions[editionKey] = snagId(location, checkOnly);
            recordObservedId(normalizedEditions[editionKey] as string, location);
            idsObserved += 1;
            idsAdded += 1;
            updatedEditions = true;
        }

        if (updatedEditions) {
            entry.editions = normalizedEditions;
            entryNode.set('editions', normalizedEditions);
            updated = true;
        }

        if (!entry.variants) {
            continue;
        }

        const variantResult = addVariantIds(yamlDoc, [sectionKey, entryKey], entry.variants, seriesRef, locationPrefix, checkOnly);
        updated = variantResult.updated || updated;
        idsObserved += variantResult.idsObserved;
        idsAdded += variantResult.idsAdded;
    }

    return { updated, idsObserved, idsAdded };
}

function processAdditionalEntries(
    yamlDoc: Document,
    groups: NonNullable<SnagYamlData['additional']>,
    seriesRef: string,
    checkOnly: boolean
): { updated: boolean; idsObserved: number; idsAdded: number } {
    let updated = false;
    let idsObserved = 0;
    let idsAdded = 0;

    for (const groupKey of Object.keys(groups)) {
        for (const itemKey of Object.keys(groups[groupKey].items)) {
            const item = groups[groupKey].items[itemKey];

            if (isReferenceItem(item)) {
                continue;
            }

            const locationPrefix = `additional.${groupKey}.items.${itemKey}`;
            const itemLocation = `${seriesRef} ${locationPrefix}.id`;

            if (!item.id) {
                item.id = snagId(itemLocation, checkOnly);
                recordObservedId(item.id, itemLocation);
                idsObserved += 1;
                idsAdded += 1;

                const itemNode = yamlDoc.getIn(['additional', groupKey, 'items', itemKey], true) as YAMLMap;
                itemNode.set('id', item.id);
                updated = true;
            } else {
                recordObservedId(item.id, itemLocation);
                idsObserved += 1;
            }

            if (!item.variants) {
                continue;
            }

            const variantResult = addVariantIds(
                yamlDoc,
                ['additional', groupKey, 'items', itemKey],
                item.variants,
                seriesRef,
                locationPrefix,
                checkOnly
            );
            updated = variantResult.updated || updated;
            idsObserved += variantResult.idsObserved;
            idsAdded += variantResult.idsAdded;
        }
    }

    return { updated, idsObserved, idsAdded };
}

function addIds(yamlDoc: Document, seriesRef: string, seriesEditions: SeriesDescriptor['editions'] | undefined, checkOnly: boolean): AddIdsResult {
    let updated = false;
    let idsObserved = 0;
    let idsAdded = 0;

    const yamlData = yamlDoc.toJS() as SnagYamlData;
    const editions = seriesEditions ? Object.keys(seriesEditions) : ['unlimited'];

    if (yamlData.items) {
        const itemResult = processEditionEntries(yamlDoc, yamlData.items, 'items', seriesRef, editions, checkOnly);
        updated = itemResult.updated || updated;
        idsObserved += itemResult.idsObserved;
        idsAdded += itemResult.idsAdded;
    }

    if (yamlData.products) {
        const productResult = processEditionEntries(yamlDoc, yamlData.products, 'products', seriesRef, editions, checkOnly);
        updated = productResult.updated || updated;
        idsObserved += productResult.idsObserved;
        idsAdded += productResult.idsAdded;
    }

    if (yamlData.additional) {
        const additionalResult = processAdditionalEntries(yamlDoc, yamlData.additional, seriesRef, checkOnly);
        updated = additionalResult.updated || updated;
        idsObserved += additionalResult.idsObserved;
        idsAdded += additionalResult.idsAdded;
    }

    return { updated, idsObserved, idsAdded };
}

async function readYamlFile(filePath: string, checkOnly: boolean): Promise<ReadYamlFileResult> {
    const leaf = path.basename(filePath, '.yaml');

    const fileContent = fs.readFileSync(filePath, 'utf8');
    const yamlDoc = parseDocument(fileContent);
    const yamlData = yamlDoc.toJS() as SnagYamlData;
    const result = addIds(yamlDoc, leaf, yamlData.editions, checkOnly);
    if (result.updated) {
        await writeFormattedYaml(filePath, yamlDoc);
        console.log(`Updated ${leaf}: added ${result.idsAdded} IDs.`);
    }

    return {
        seriesObserved: 1,
        idsObserved: result.idsObserved,
        idsAdded: result.idsAdded,
    };
}

async function recurseDir(
    dirPath: string,
    listedSeriesIds: Set<string>,
    checkOnly: boolean,
    singleSeriesId?: string
): Promise<ReadYamlFileResult> {
    const totals: ReadYamlFileResult = {
        seriesObserved: 0,
        idsObserved: 0,
        idsAdded: 0,
    };
    const entries = fs.readdirSync(dirPath);

    for (const entry of entries) {
        if (entry.startsWith('_')) {
            continue;
        }

        const fullPath = path.join(dirPath, entry);
        const stats = fs.statSync(fullPath);

        if (stats.isDirectory()) {
            const nested = await recurseDir(fullPath, listedSeriesIds, checkOnly, singleSeriesId);
            totals.seriesObserved += nested.seriesObserved;
            totals.idsObserved += nested.idsObserved;
            totals.idsAdded += nested.idsAdded;
            continue;
        }

        if (path.extname(fullPath) !== '.yaml') {
            continue;
        }

        if (singleSeriesId && path.basename(fullPath, '.yaml') !== singleSeriesId) {
            continue;
        }

        if (!listedSeriesIds.has(path.basename(fullPath, '.yaml'))) {
            continue;
        }

        const result = await readYamlFile(fullPath, checkOnly);
        totals.seriesObserved += result.seriesObserved;
        totals.idsObserved += result.idsObserved;
        totals.idsAdded += result.idsAdded;
    }

    return totals;
}

async function main(): Promise<void> {
    const { check: checkOnly, collectibleType, region, seriesId: singleSeriesId } = argv;

    if (singleSeriesId && (!collectibleType || !region)) {
        throw new Error('A seriesId requires both collectibleType and region.');
    }

    const targets = getProcessingTargets(collectibleType, region);
    if (targets.length === 0) {
        throw new Error('No collectible type regions found to process.');
    }

    const totals: ReadYamlFileResult = {
        seriesObserved: 0,
        idsObserved: 0,
        idsAdded: 0,
    };

    for (const target of targets) {
        observedIds.clear();

        const regionFile = getRegionFilePath(target.collectibleType, target.region);
        if (!fs.existsSync(regionFile)) {
            throw new Error(`Cannot find series catalog: ${regionFile}`);
        }

        if (targets.length > 1) {
            console.log(`Checking ${target.collectibleType}/${target.region}`);
        }

        const regionData = fs.readFileSync(regionFile, 'utf8');
        const regionDoc = parseDocument(regionData);
        const listedSeriesIds = getListedSeriesIds(regionDoc.toJS() as RegionDescriptor);

        if (singleSeriesId && !listedSeriesIds.has(singleSeriesId)) {
            throw new Error(`Series '${singleSeriesId}' is not listed in ${regionFile}`);
        }

        const fileDir = path.dirname(regionFile);
        const targetTotals = await recurseDir(fileDir, listedSeriesIds, checkOnly, singleSeriesId);
        totals.seriesObserved += targetTotals.seriesObserved;
        totals.idsObserved += targetTotals.idsObserved;
        totals.idsAdded += targetTotals.idsAdded;
    }

    console.log(`Checked ${totals.seriesObserved} series and ${totals.idsObserved} IDs.`);
}

await main();