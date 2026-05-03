import path from 'node:path';

function stripYamlExtension(filePath: string): string {
    return filePath.replace(/\.(yaml|yml)$/u, '');
}

export function getSeriesId(generationKey: string, seriesKey: string): string {
    return `${generationKey}:${seriesKey}`;
}

export function parseSeriesId(seriesId: string): { generationKey: string; seriesKey: string } {
    const separatorIndex = seriesId.indexOf(':');
    if (separatorIndex <= 0 || separatorIndex === seriesId.length - 1) {
        throw new Error(`Invalid series id: ${seriesId}`);
    }

    return {
        generationKey: seriesId.slice(0, separatorIndex),
        seriesKey: seriesId.slice(separatorIndex + 1),
    };
}

export function getSeriesFileCandidates(regionPath: string, seriesId: string): string[] {
    const { generationKey, seriesKey } = parseSeriesId(seriesId);

    return [
        path.join(regionPath, generationKey, `${seriesKey}.yaml`),
        path.join(regionPath, generationKey, `${seriesKey}.yml`),
        path.join(regionPath, `${seriesId}.yaml`),
        path.join(regionPath, `${seriesId}.yml`),
    ];
}

export function getSeriesIdFromFilePath(regionPath: string, filePath: string): string | null {
    const relativePath = path.relative(regionPath, filePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return null;
    }

    const withoutExtension = stripYamlExtension(relativePath);
    const segments = withoutExtension.split(path.sep);

    if (segments.length === 1) {
        return segments[0] ?? null;
    }

    if (segments.length === 2) {
        const [generationKey, seriesKey] = segments;
        if (!generationKey || !seriesKey) {
            return null;
        }

        return getSeriesId(generationKey, seriesKey);
    }

    return null;
}