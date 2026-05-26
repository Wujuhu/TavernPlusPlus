import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_USER_HANDLE = 'default-user';
const COPY_DIRECTORIES = Object.freeze([
    'characters',
    'worlds',
    'chats',
    'OpenAI Settings',
    'TextGen Settings',
    'KoboldAI Settings',
    'NovelAI Settings',
    'instruct',
    'context',
    'sysprompt',
    'reasoning',
]);

function getArgValue(argv, name) {
    const exact = `--${name}`;
    const prefixed = `${exact}=`;

    for (let index = 0; index < argv.length; index++) {
        if (argv[index] === exact) {
            return argv[index + 1];
        }
        if (argv[index].startsWith(prefixed)) {
            return argv[index].slice(prefixed.length);
        }
    }

    return undefined;
}

function ensureInsideRoot(root, target) {
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(target);
    if (resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
        return resolvedTarget;
    }

    throw new Error(`Path escapes root: ${target}`);
}

function getUserRoot(dataRoot, userHandle) {
    return path.join(dataRoot, userHandle);
}

/**
 * Copies selected SillyTavern user data into the headless data root.
 * @param {object} options Copy options
 * @param {string} options.sourceDataRoot Source data root
 * @param {string} options.targetDataRoot Target data root
 * @param {string} [options.userHandle] User handle
 * @param {boolean} [options.overwrite] Replace existing files
 * @returns {Promise<object[]>} Copy report
 */
export async function copyHeadlessData(options) {
    const userHandle = options.userHandle || DEFAULT_USER_HANDLE;
    const sourceDataRoot = path.resolve(options.sourceDataRoot);
    const targetDataRoot = path.resolve(options.targetDataRoot);
    const sourceUserRoot = getUserRoot(sourceDataRoot, userHandle);
    const targetUserRoot = getUserRoot(targetDataRoot, userHandle);
    const copied = [];

    await fs.promises.mkdir(targetUserRoot, { recursive: true });

    for (const directory of COPY_DIRECTORIES) {
        const source = ensureInsideRoot(sourceUserRoot, path.join(sourceUserRoot, directory));
        const target = ensureInsideRoot(targetUserRoot, path.join(targetUserRoot, directory));

        if (!fs.existsSync(source)) {
            copied.push({ directory, copied: false, reason: 'missing-source' });
            continue;
        }

        await fs.promises.cp(source, target, {
            recursive: true,
            force: Boolean(options.overwrite),
            errorOnExist: !options.overwrite,
        });
        copied.push({ directory, copied: true });
    }

    return copied;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const sourceDataRoot = getArgValue(process.argv, 'source') || './data';
    const targetDataRoot = getArgValue(process.argv, 'target') || './data-headless';
    const userHandle = getArgValue(process.argv, 'user') || DEFAULT_USER_HANDLE;
    const overwrite = process.argv.includes('--overwrite');

    try {
        const report = await copyHeadlessData({ sourceDataRoot, targetDataRoot, userHandle, overwrite });
        console.log(JSON.stringify({ ok: true, report }, null, 2));
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}
