import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { v4 as uuidv4 } from 'uuid';
import type { Document, YAMLMap } from 'yaml';
import { parseDocument } from 'yaml';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import type {
    AdditionalItem,
    DiscreteItem,
    GenerationMap,
    ReferenceItem,
    SeriesDescriptor,
    Variant,
} from '../schema/Schema.js';

const argv = await yargs(hideBin(process.argv))
    .command('* <collectibleType> <region> [seriesId]', '')
    .positional('collectibleType', {
        describe: 'Collectible type directory under data, for example pokemon-card',
        type: 'string',
        demandOption: true,
    })
    .positional('region', {
        describe: 'Region directory under the collectible type, for example english',
        type: 'string',
        demandOption: true,
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
    editions?: string[] | EditionIdMap;
    variants?: Record<string, SnagVariant>;
};
type SnagItem = SnagDiscreteItem | ReferenceItem;
type SnagAdditionalItem = Omit<AdditionalItem, 'id' | 'variants'> & {
    id?: string;
    variants?: Record<string, SnagVariant>;
};
type SnagAdditionalEntry = SnagAdditionalItem | ReferenceItem;

interface SnagYamlData {
    items?: Record<string, SnagItem>;
    products?: Record<string, SnagItem>;
    additional?: Record<string, { items: Record<string, SnagAdditionalEntry> }>;
}

type GetSeriesFunc = (seriesId: string) => SeriesDescriptor | null;

const observedIds = new Set<string>();

function recordObservedId(id: string, location: string): void {
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

function normalizeEditionMap(editions: string[] | EditionIdMap, defaults: string[]): EditionIdMap {
    if (Array.isArray(editions)) {
        return editions.reduce<EditionIdMap>((acc, editionKey) => {
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

function getSeriesFilePath(collectibleType: string, region: string): string {
    return path.resolve('data', collectibleType, region, '_series.yaml');
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
    series: SeriesDescriptor,
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
        const normalizedEditions = normalizeEditionMap(entry.editions ?? editions, editions);
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
    series: SeriesDescriptor,
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

function addIds(yamlDoc: Document, seriesRef: string, series: SeriesDescriptor, checkOnly: boolean): AddIdsResult {
    let updated = false;
    let idsObserved = 0;
    let idsAdded = 0;

    const yamlData = yamlDoc.toJS() as SnagYamlData;
    const editions = series.editions ? Object.keys(series.editions) : ['unlimited'];

    if (yamlData.items) {
        const itemResult = processEditionEntries(yamlDoc, yamlData.items, 'items', seriesRef, series, editions, checkOnly);
        updated = itemResult.updated || updated;
        idsObserved += itemResult.idsObserved;
        idsAdded += itemResult.idsAdded;
    }

    if (yamlData.products) {
        const productResult = processEditionEntries(yamlDoc, yamlData.products, 'products', seriesRef, series, editions, checkOnly);
        updated = productResult.updated || updated;
        idsObserved += productResult.idsObserved;
        idsAdded += productResult.idsAdded;
    }

    if (yamlData.additional) {
        const additionalResult = processAdditionalEntries(yamlDoc, yamlData.additional, seriesRef, series, checkOnly);
        updated = additionalResult.updated || updated;
        idsObserved += additionalResult.idsObserved;
        idsAdded += additionalResult.idsAdded;
    }

    return { updated, idsObserved, idsAdded };
}

function readYamlFile(filePath: string, getSeries: GetSeriesFunc, checkOnly: boolean): ReadYamlFileResult {
    const leaf = path.basename(filePath, '.yaml');
    const series = getSeries(leaf);
    if (!series) {
        console.error(`Series not found for ${leaf}.`);
        return { seriesObserved: 0, idsObserved: 0, idsAdded: 0 };
    }

    const fileContent = fs.readFileSync(filePath, 'utf8');
    const yamlDoc = parseDocument(fileContent);
    const result = addIds(yamlDoc, leaf, series, checkOnly);
    if (result.updated) {
        fs.writeFileSync(filePath, String(yamlDoc), 'utf8');
        console.log(`Updated ${leaf}: added ${result.idsAdded} IDs.`);
    }

    return {
        seriesObserved: 1,
        idsObserved: result.idsObserved,
        idsAdded: result.idsAdded,
    };
}

function recurseDir(dirPath: string, getSeries: GetSeriesFunc, checkOnly: boolean, singleSeriesId?: string): ReadYamlFileResult {
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
            const nested = recurseDir(fullPath, getSeries, checkOnly);
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

        const result = readYamlFile(fullPath, getSeries, checkOnly);
        totals.seriesObserved += result.seriesObserved;
        totals.idsObserved += result.idsObserved;
        totals.idsAdded += result.idsAdded;
    }

    return totals;
}

async function main(): Promise<void> {
    const { check: checkOnly, collectibleType, region, seriesId: singleSeriesId } = argv;
    const seriesFile = getSeriesFilePath(collectibleType, region);

    if (!fs.existsSync(seriesFile)) {
        throw new Error(`Cannot find series catalog: ${seriesFile}`);
    }

    const seriesData = fs.readFileSync(seriesFile, 'utf8');
    const seriesDoc = parseDocument(seriesData);
    const seriesYaml = seriesDoc.toJS() as GenerationMap;

    const getSeries: GetSeriesFunc = seriesId => {
        const [generationKey, seriesKey] = seriesId.split(':');
        if (!(generationKey in seriesYaml)) {
            return null;
        }

        const generation = seriesYaml[generationKey];
        if (!(seriesKey in generation.series)) {
            return null;
        }

        if (singleSeriesId && seriesId !== singleSeriesId) {
            return null;
        }

        return generation.series[seriesKey];
    };

    const fileDir = path.dirname(seriesFile);
    const totals = recurseDir(fileDir, getSeries, checkOnly, singleSeriesId);
    console.log(`Checked ${totals.seriesObserved} series and ${totals.idsObserved} IDs.`);
}

await main();