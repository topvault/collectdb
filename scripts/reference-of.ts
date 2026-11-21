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
import { CheckCache } from './lib/check-cache.js';
import { getSeriesIdFromFilePath, parseSeriesId } from './lib/series-path.js';
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

/** An ID a series file defines: [id, item, edition, group], with '' where there is none. */
type IndexTuple = [string, string, string, string];

// What a series file that needs no changes contributes, so the file is not parsed again: the IDs it
// defines, and the IDs its references point at that no file defined when it was checked. If one of
// those IDs turns up later the reference can be filled in, so the file is read again.
type ReferenceSummary = {
    index: IndexTuple[];
    unresolved: string[];
};

const cache = new CheckCache<ReferenceSummary>('reference-of');

/** The series read so far, by generation and series key. Series are read when first needed. */
const generations: Record<string, Record<string, SeriesItemsInput | null>> = {};
/** Every series of the region, by series ID, and the file it is in. */
const seriesFiles = new Map<string, string>();
const idIndex: Partial<Record<string, IdIndexEntry>> = {};
/** IDs of references the file being checked has that no file defines. */
let unresolvedIds: string[] = [];
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

function collectIndex(series: SeriesItemsInput): IndexTuple[] {
    const tuples: IndexTuple[] = [];
    const add = (itemKey: string, itemData: SeriesItemInput | AdditionalEntryInput, groupKey = ''): void => {
        if (isReferenceItem(itemData)) {
            return;
        }

        if ('id' in itemData && itemData.id) {
            tuples.push([itemData.id, itemKey, '', groupKey]);
        }

        if ('editions' in itemData) {
            for (const [editionKey, editionId] of Object.entries(itemData.editions)) {
                tuples.push([editionId, itemKey, editionKey, groupKey]);
            }
        }
    };

    for (const [itemKey, itemData] of Object.entries(series.items)) {
        add(itemKey, itemData);
    }

    for (const [groupKey, groupData] of Object.entries(series.additional ?? {})) {
        for (const [itemKey, itemData] of Object.entries(groupData.items)) {
            add(itemKey, itemData, groupKey);
        }
    }

    return tuples;
}

function addToIndex(tuples: IndexTuple[], generationKey: string, seriesKey: string): void {
    for (const [id, item, edition, group] of tuples) {
        idIndex[id] = {
            generation: generationKey,
            series: seriesKey,
            item,
            ...(edition ? { edition } : {}),
            ...(group ? { group } : {}),
        };
    }
}

/** A series of the region, read from its file the first time it is asked for. */
function getSeries(generationKey: string, seriesKey: string): SeriesItemsInput | null {
    const loaded = generations[generationKey]?.[seriesKey];
    if (loaded !== undefined) {
        return loaded;
    }

    const filePath = seriesFiles.get(`${generationKey}:${seriesKey}`);
    const series = filePath ? (readYamlFile(filePath).toJS() as SeriesItemsInput | null) : null;
    generations[generationKey] ??= {};
    generations[generationKey][seriesKey] = series;
    return series;
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

    const generationPrefix = `${reference.generation}:`;
    if (![...seriesFiles.keys()].some(seriesId => seriesId.startsWith(generationPrefix))) {
        throw new Error(`Unknown generation: ${reference.generation}`);
    }

    const series = getSeries(reference.generation, reference.series);
    if (!series) {
        throw new Error(`Unknown series: ${reference.series}`);
    }

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
            unresolvedIds.push(refData);
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
        unresolvedIds.push(refData.id);
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

function getKeys(regionPath: string, filePath: string): { generationKey: string; seriesKey: string } {
    const seriesId = getSeriesIdFromFilePath(regionPath, filePath);
    if (!seriesId) {
        throw new Error(`Could not determine series id for ${filePath}`);
    }

    return parseSeriesId(seriesId);
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

    seriesFiles.clear();
}

/** The listed series files under a directory, in directory order. */
function listSeriesFiles(regionPath: string, dirPath: string, listedSeriesIds: Set<string>): string[] {
    const files: string[] = [];

    for (const entry of fs.readdirSync(dirPath)) {
        if (entry.startsWith('_')) {
            continue;
        }

        const fullPath = path.join(dirPath, entry);
        if (fs.statSync(fullPath).isDirectory()) {
            files.push(...listSeriesFiles(regionPath, fullPath, listedSeriesIds));
            continue;
        }

        if (!['.yaml', '.yml'].includes(path.extname(fullPath))) {
            continue;
        }

        const seriesId = getSeriesIdFromFilePath(regionPath, fullPath);
        if (seriesId && listedSeriesIds.has(seriesId)) {
            files.push(fullPath);
        }
    }

    return files;
}

interface SeriesFile {
    fullPath: string;
    source: string;
    generationKey: string;
    seriesKey: string;
    index: IndexTuple[];
}

async function readSeriesFiles(regionPath: string, listedSeriesIds: Set<string>, checkOnlyMode: boolean): Promise<ReadSeriesFilesResult> {
    const toCheck: (SeriesFile & { yamlDoc: Document })[] = [];
    const fromCache: (SeriesFile & { unresolved: string[] })[] = [];

    // Index every ID of the region first, since a reference can point at any series in it.
    for (const fullPath of listSeriesFiles(regionPath, regionPath, listedSeriesIds)) {
        const { generationKey, seriesKey } = getKeys(regionPath, fullPath);
        seriesFiles.set(`${generationKey}:${seriesKey}`, fullPath);

        const source = fs.readFileSync(fullPath, 'utf8');
        const summary = cache.get(fullPath, source);
        if (summary) {
            addToIndex(summary.index, generationKey, seriesKey);
            fromCache.push({ fullPath, source, generationKey, seriesKey, ...summary });
            continue;
        }

        const yamlDoc = parseDocument(source);
        const yamlData = yamlDoc.toJS() as SeriesItemsInput | null;
        generations[generationKey] ??= {};
        generations[generationKey][seriesKey] = yamlData;
        if (!yamlData) {
            continue;
        }

        const index = collectIndex(yamlData);
        addToIndex(index, generationKey, seriesKey);
        toCheck.push({ fullPath, source, generationKey, seriesKey, index, yamlDoc });
    }

    let filesChecked = 0;
    for (const entry of fromCache) {
        if (entry.unresolved.some(id => idIndex[id])) {
            toCheck.push({ ...entry, yamlDoc: parseDocument(entry.source) });
        } else {
            filesChecked += 1;
        }
    }

    let filesNeedingUpdate = 0;
    for (const { fullPath, source, generationKey, seriesKey, index, yamlDoc } of toCheck) {
        filesChecked += 1;
        unresolvedIds = [];

        if (!setIds(yamlDoc, generationKey, seriesKey)) {
            cache.set(fullPath, source, { index, unresolved: [...new Set(unresolvedIds)] });
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

    let filesChecked = 0;
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
        filesChecked += result.filesChecked;
        filesNeedingUpdate += result.filesNeedingUpdate;
    }

    cache.save();
    console.log(`Checked ${filesChecked} series files (${cache.describe()}).`);

    if (checkOnly && filesNeedingUpdate > 0) {
        console.error(`${filesNeedingUpdate} files would be updated.`);
        process.exitCode = 1;
    }
}

await main();