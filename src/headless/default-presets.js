/**
 * Reads built-in default preset JSON files from `config/default-presets/`.
 *
 * On first user initialization these files are copied into the user's
 * preset directory so they appear in `/preset` listings immediately.
 */

import fs from 'node:fs';
import path from 'node:path';

import { serverDirectory } from '../server-directory.js';

const DEFAULT_PRESETS_DIR = path.resolve(serverDirectory, 'config', 'default-presets');

/**
 * Scan `config/default-presets/` and return an array of
 * `{ apiId, name, preset }` objects — one per JSON file found.
 *
 * Returns an empty array when the directory does not exist or is empty.
 */
export function loadDefaultPresets(apiId = 'openai') {
    if (!fs.existsSync(DEFAULT_PRESETS_DIR)) {
        return [];
    }

    const files = fs.readdirSync(DEFAULT_PRESETS_DIR)
        .filter(f => path.extname(f).toLowerCase() === '.json')
        .sort();

    const results = [];
    for (const file of files) {
        const filePath = path.join(DEFAULT_PRESETS_DIR, file);
        const preset = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        results.push({
            apiId,
            name: path.basename(file, '.json'),
            preset,
        });
    }

    return results;
}
