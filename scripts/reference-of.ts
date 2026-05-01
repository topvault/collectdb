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
    RegionDescriptor,
    ReferenceItem,
    ReferenceOf,
    SeriesDescriptor,
} from '../schema/Schema.js';
import { writeFormattedYaml } from './lib/write-formatted-yaml.js';

const argv = await yargs(hideBin(process.argv))
    .command('* [collectibleType] [region]', '')
    .positional('collectibleType', {
        describe: 'Collectible type directory under data, for example pokemon-card',
        type: 'string',
    })
    .positional('region', {
        describe: 'Region directory under the collectible type, for example english',
        type: 'string',
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
type SeriesItemsInput = Omit<SeriesDescriptor, 'items' | 'products' | 'additional'> & {
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
const skippedDirectoryNames = new Set(['test-source']);

interface ProcessingTarget {
    collectibleType: string;
    region: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
    const leaf = path.basename(filePath).replace(/\.(yaml|yml)$/u, '');
    const [generationKey, seriesKey] = leaf.split(':');
    return { generationKey, seriesKey };
}

interface ReadSeriesFilesResult {
    filesChecked: number;
    filesNeedingUpdate: number;
}

function getRegionFilePath(collectibleTypeValue: string, regionValue: string): string {
    return path.resolve('data', collectibleTypeValue, regionValue, '_region.yaml');
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

function getProcessingTargets(collectibleTypeValue?: string, regionValue?: string): ProcessingTarget[] {
    if (regionValue && !collectibleTypeValue) {
        throw new Error('A region requires a collectible type.');
    }

    if (collectibleTypeValue && regionValue) {
        return [{ collectibleType: collectibleTypeValue, region: regionValue }];
    }

    const dataRoot = path.resolve('data');

    if (collectibleTypeValue) {
        const collectibleTypePath = path.join(dataRoot, collectibleTypeValue);
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
            .map(regionName => ({ collectibleType: collectibleTypeValue, region: regionName }));
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

function resetState(): void {
    for (const key of Object.keys(generations)) {
        delete generations[key];
    }

    for (const key of Object.keys(idIndex)) {
        delete idIndex[key];
    }

    for (const key of Object.keys(loadedFiles)) {
        delete loadedFiles[key];
    }
}

async function readSeriesFiles(dirPath: string, listedSeriesIds: Set<string>, checkOnlyMode: boolean): Promise<ReadSeriesFilesResult> {
    const entries = fs.readdirSync(dirPath);
    let filesChecked = 0;
    let filesNeedingUpdate = 0;

    for (const entry of entries) {
        if (entry.startsWith('_')) {
            continue;
        }

        const fullPath = path.join(dirPath, entry);
        if (!['.yaml', '.yml'].includes(path.extname(fullPath))) {
            continue;
        }

        const seriesId = path.basename(fullPath).replace(/\.(yaml|yml)$/u, '');
        if (!listedSeriesIds.has(seriesId)) {
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
            await writeFormattedYaml(fullPath, yamlDoc);
        }
    }

    return { filesChecked, filesNeedingUpdate };
}

async function main(): Promise<void> {
    const targets = getProcessingTargets(collectibleType, region);
    if (targets.length === 0) {
        throw new Error('No collectible type regions found to process.');
    }

    let filesNeedingUpdate = 0;

    for (const target of targets) {
        resetState();

        const regionFile = getRegionFilePath(target.collectibleType, target.region);
        if (!fs.existsSync(regionFile)) {
            throw new Error(`Cannot find series catalog: ${regionFile}`);
        }

        if (targets.length > 1) {
            console.log(`Checking ${target.collectibleType}/${target.region}`);
        }

        const regionDoc = readYamlFile(resolveYamlFile(path.dirname(regionFile), '_region'));
        const listedSeriesIds = getListedSeriesIds(regionDoc.toJS() as RegionDescriptor);

        const fileDir = path.dirname(regionFile);
        const stats = fs.statSync(fileDir);
        if (!stats.isDirectory()) {
            throw new Error('Cannot find directory of series files');
        }

        const result = await readSeriesFiles(fileDir, listedSeriesIds, checkOnly);
        filesNeedingUpdate += result.filesNeedingUpdate;
    }

    if (checkOnly && filesNeedingUpdate > 0) {
        console.error(`${filesNeedingUpdate} files would be updated.`);
        process.exitCode = 1;
    }
}

await main();