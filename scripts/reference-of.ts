import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { Document, YAMLMap } from 'yaml';
import { parseDocument } from 'yaml';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import type {
    AdditionalGroup,
    AdditionalItem,
    DiscreteItem,
    ReferenceItem,
    ReferenceOf,
    SeriesItems,
} from '../schema/Schema.js';

const argv = await yargs(hideBin(process.argv))
    .command('* <collectibleType> <region>', '')
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
    .option('check', {
        describe: 'Check for reference normalization changes without writing updates',
        type: 'boolean',
        default: false,
    })
    .parse();

const { check: checkOnly, collectibleType, region } = argv;

type ReferenceInput = string | ReferenceOf;
type DiscreteItemInput = Omit<DiscreteItem, 'variantOf'> & { variantOf?: ReferenceInput };
type ReferenceItemInput = Omit<ReferenceItem, 'referenceOf'> & { referenceOf: ReferenceInput };
type SeriesItemInput = DiscreteItemInput | ReferenceItemInput;
type AdditionalItemInput = Omit<AdditionalItem, 'variantOf'> & { variantOf?: ReferenceInput };
type AdditionalEntryInput = AdditionalItemInput | ReferenceItemInput;
type AdditionalGroupInput = Omit<AdditionalGroup, 'items'> & { items: Record<string, AdditionalEntryInput> };
type SeriesItemsInput = Omit<SeriesItems, 'items' | 'products' | 'additional'> & {
    items: Record<string, SeriesItemInput>;
    products?: Record<string, SeriesItemInput>;
    additional?: Record<string, AdditionalGroupInput>;
};

type IdIndexEntry = {
    generation: string;
    series: string;
    item: string;
    group?: string;
    edition?: string;
};

const generations: Record<string, Record<string, SeriesItemsInput>> = {};
const idIndex: Partial<Record<string, IdIndexEntry>> = {};
const loadedFiles: Record<string, Document> = {};

function isReferenceItem(item: SeriesItemInput | AdditionalEntryInput): item is ReferenceItemInput {
    return 'referenceOf' in item;
}

function getReferenceOf(item: SeriesItemInput | AdditionalEntryInput): ReferenceInput | undefined {
    return 'referenceOf' in item ? item.referenceOf : undefined;
}

function getVariantOf(item: SeriesItemInput | AdditionalEntryInput): ReferenceInput | undefined {
    return 'variantOf' in item ? item.variantOf : undefined;
}

function indexItemEditions(itemData: DiscreteItemInput, generationKey: string, seriesKey: string, itemKey: string, groupKey?: string): void {
    for (const [editionKey, editionId] of Object.entries(itemData.editions)) {
        idIndex[editionId] = {
            generation: generationKey,
            series: seriesKey,
            item: itemKey,
            edition: editionKey,
            ...(groupKey ? { group: groupKey } : {}),
        };
    }
}

function indexItem(
    itemKey: string,
    itemData: SeriesItemInput | AdditionalEntryInput,
    generationKey: string,
    seriesKey: string,
    groupKey?: string
): void {
    if (isReferenceItem(itemData)) {
        return;
    }

    if ('id' in itemData && itemData.id) {
        idIndex[itemData.id] = {
            generation: generationKey,
            series: seriesKey,
            item: itemKey,
            ...(groupKey ? { group: groupKey } : {}),
        };
    }

    if ('editions' in itemData) {
        indexItemEditions(itemData, generationKey, seriesKey, itemKey, groupKey);
    }
}

function indexAdditionalGroups(series: SeriesItemsInput, generationKey: string, seriesKey: string): void {
    if (!series.additional) {
        return;
    }

    for (const [groupKey, groupData] of Object.entries(series.additional)) {
        for (const [itemKey, itemData] of Object.entries(groupData.items)) {
            indexItem(itemKey, itemData, generationKey, seriesKey, groupKey);
        }
    }
}

function indexSeries(seriesKey: string, series: SeriesItemsInput, generationKey: string): void {
    for (const [itemKey, itemData] of Object.entries(series.items)) {
        indexItem(itemKey, itemData, generationKey, seriesKey);
    }

    indexAdditionalGroups(series, generationKey, seriesKey);
}

function buildIdIndex(): void {
    for (const [generationKey, generation] of Object.entries(generations)) {
        for (const [seriesKey, series] of Object.entries(generation)) {
            indexSeries(seriesKey, series, generationKey);
        }
    }
}

function findReferenceFromId(id: string): ReferenceOf | null {
    const ref = idIndex[id];
    if (!ref) {
        return null;
    }

    return {
        id,
        generation: ref.generation,
        series: ref.series,
        item: ref.item,
        ...(ref.group ? { group: ref.group } : {}),
        ...(ref.edition ? { edition: ref.edition } : {}),
    };
}

function findId(generationKey: string, seriesKey: string, reference: ReferenceOf): string {
    reference.generation ??= generationKey;
    reference.series ??= seriesKey;
    reference.edition ??= 'unlimited';

    if (!(reference.generation in generations)) {
        throw new Error(`Unknown generation: ${reference.generation}`);
    }

    const generation = generations[reference.generation];
    if (!(reference.series in generation)) {
        throw new Error(`Unknown series: ${reference.series}`);
    }

    const series = generation[reference.series];
    let item: DiscreteItemInput | AdditionalItemInput;

    if (reference.group) {
        if (!series.additional || !(reference.group in series.additional)) {
            console.error(reference);
            throw new Error(`Unknown group: ${reference.group} in series ${reference.series}`);
        }

        const group = series.additional[reference.group];
        if (!(reference.item in group.items)) {
            console.error(reference);
            throw new Error(`Item: ${reference.item} not found in group ${reference.group}`);
        }

        const groupItem = group.items[reference.item];
        if (isReferenceItem(groupItem)) {
            console.error(reference);
            throw new Error('Cannot resolve reference through a referenceOf item');
        }

        item = groupItem;
    } else {
        if (!(reference.item in series.items)) {
            console.error(reference);
            throw new Error(`Item: ${reference.item} not found in series ${reference.series}`);
        }

        const seriesItem = series.items[reference.item];
        if (isReferenceItem(seriesItem)) {
            console.error(reference);
            throw new Error('Cannot resolve reference through a referenceOf item');
        }

        item = seriesItem;
    }

    if ('editions' in item && reference.edition) {
        return item.editions[reference.edition];
    }

    if (!('id' in item) || !item.id) {
        console.error(reference);
        throw new Error('Item requires edition id snag');
    }

    return item.id;
}

function fillReference(
    yamlDoc: Document,
    yamlPath: (string | number)[],
    refData: ReferenceInput,
    generationKey: string,
    seriesKey: string
): boolean {
    if (typeof refData === 'string') {
        const fullRef = findReferenceFromId(refData);
        if (!fullRef) {
            return false;
        }

        yamlDoc.setIn(yamlPath, fullRef);
        return true;
    }

    if (!refData.id || refData.id === '') {
        const id = findId(generationKey, seriesKey, refData);
        const refNode = yamlDoc.getIn(yamlPath, true) as YAMLMap;
        refNode.set('id', id);
        return true;
    }

    if (refData.generation && refData.series && refData.item) {
        return false;
    }

    const fullRef = findReferenceFromId(refData.id);
    if (!fullRef) {
        return false;
    }

    const refNode = yamlDoc.getIn(yamlPath, true) as YAMLMap;
    if (!refData.generation) {
        refNode.set('generation', fullRef.generation);
    }
    if (!refData.series) {
        refNode.set('series', fullRef.series);
    }
    if (!refData.item) {
        refNode.set('item', fullRef.item);
    }
    if (fullRef.group && !refData.group) {
        refNode.set('group', fullRef.group);
    }
    if (fullRef.edition && !refData.edition) {
        refNode.set('edition', fullRef.edition);
    }

    return true;
}

function setIds(yamlDoc: Document, generationKey: string, seriesKey: string): boolean {
    let updated = false;
    const yamlData = yamlDoc.toJS() as SeriesItemsInput;

    for (const [itemKey, itemData] of Object.entries(yamlData.items)) {
        const referenceOf = getReferenceOf(itemData);
        if (referenceOf) {
            updated = fillReference(yamlDoc, ['items', itemKey, 'referenceOf'], referenceOf, generationKey, seriesKey) || updated;
        }

        const variantOf = getVariantOf(itemData);
        if (variantOf) {
            updated = fillReference(yamlDoc, ['items', itemKey, 'variantOf'], variantOf, generationKey, seriesKey) || updated;
        }
    }

    if (yamlData.products) {
        for (const [productKey, productData] of Object.entries(yamlData.products)) {
            const referenceOf = getReferenceOf(productData);
            if (referenceOf) {
                updated =
                    fillReference(yamlDoc, ['products', productKey, 'referenceOf'], referenceOf, generationKey, seriesKey) || updated;
            }

            const variantOf = getVariantOf(productData);
            if (variantOf) {
                updated = fillReference(yamlDoc, ['products', productKey, 'variantOf'], variantOf, generationKey, seriesKey) || updated;
            }
        }
    }

    if (yamlData.additional) {
        for (const [groupKey, groupData] of Object.entries(yamlData.additional)) {
            for (const [itemKey, itemData] of Object.entries(groupData.items)) {
                const referenceOf = getReferenceOf(itemData);
                if (referenceOf) {
                    updated =
                        fillReference(
                            yamlDoc,
                            ['additional', groupKey, 'items', itemKey, 'referenceOf'],
                            referenceOf,
                            generationKey,
                            seriesKey
                        ) || updated;
                }

                const variantOf = getVariantOf(itemData);
                if (variantOf) {
                    updated =
                        fillReference(
                            yamlDoc,
                            ['additional', groupKey, 'items', itemKey, 'variantOf'],
                            variantOf,
                            generationKey,
                            seriesKey
                        ) || updated;
                }
            }
        }
    }

    return updated;
}

function readYamlFile(filePath: string): Document {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    return parseDocument(fileContent);
}

function getKeys(filePath: string): { generationKey: string; seriesKey: string } {
    const leaf = path.basename(filePath, '.yaml');
    const [generationKey, seriesKey] = leaf.split(':');
    return { generationKey, seriesKey };
}

interface ReadSeriesFilesResult {
    filesChecked: number;
    filesNeedingUpdate: number;
}

function getSeriesFilePath(collectibleTypeValue: string, regionValue: string): string {
    return path.resolve('data', collectibleTypeValue, regionValue, '_series.yaml');
}

function readSeriesFiles(dirPath: string, checkOnlyMode: boolean): ReadSeriesFilesResult {
    const entries = fs.readdirSync(dirPath);
    let filesChecked = 0;
    let filesNeedingUpdate = 0;

    for (const entry of entries) {
        if (entry.startsWith('_')) {
            continue;
        }

        const fullPath = path.join(dirPath, entry);
        if (path.extname(fullPath) !== '.yaml') {
            continue;
        }

        const yamlDoc = readYamlFile(fullPath);
        const { generationKey, seriesKey } = getKeys(fullPath);
        const yamlData = yamlDoc.toJS() as SeriesItemsInput;

        if (!yamlData) {
            continue;
        }

        loadedFiles[fullPath] = yamlDoc;
        generations[generationKey] ??= {};
        generations[generationKey][seriesKey] = yamlData;
    }

    buildIdIndex();

    for (const [fullPath, yamlDoc] of Object.entries(loadedFiles)) {
        filesChecked += 1;
        const { generationKey, seriesKey } = getKeys(fullPath);

        if (!setIds(yamlDoc, generationKey, seriesKey)) {
            continue;
        }

        filesNeedingUpdate += 1;
        console.log(checkOnlyMode ? 'Would update file:' : 'Updating file:', fullPath, generationKey, seriesKey);
        if (!checkOnlyMode) {
            fs.writeFileSync(fullPath, String(yamlDoc), 'utf8');
        }
    }

    return { filesChecked, filesNeedingUpdate };
}

async function main(): Promise<void> {
    const seriesFile = getSeriesFilePath(collectibleType, region);
    if (!fs.existsSync(seriesFile)) {
        throw new Error(`Cannot find series catalog: ${seriesFile}`);
    }

    const fileDir = path.dirname(seriesFile);
    const stats = fs.statSync(fileDir);
    if (!stats.isDirectory()) {
        throw new Error('Cannot find directory of series files');
    }

    const result = readSeriesFiles(fileDir, checkOnly);
    if (checkOnly && result.filesNeedingUpdate > 0) {
        console.error(`${result.filesNeedingUpdate} files would be updated.`);
        process.exitCode = 1;
    }
}

await main();