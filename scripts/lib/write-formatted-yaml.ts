import { writeFile } from 'node:fs/promises';

import prettier, { type Options } from 'prettier';
import type { Document } from 'yaml';

let resolvedPrettierConfigPromise: Promise<Options | null> | null = null;

async function getPrettierConfig(filePath: string): Promise<Options | null> {
    resolvedPrettierConfigPromise ??= prettier.resolveConfig(filePath);
    return resolvedPrettierConfigPromise;
}

export async function writeFormattedYaml(filePath: string, yamlDoc: Document): Promise<void> {
    const prettierConfig = (await getPrettierConfig(filePath)) ?? {};
    const formatted = await prettier.format(String(yamlDoc), {
        ...prettierConfig,
        filepath: filePath,
    });

    await writeFile(filePath, formatted, 'utf8');
}