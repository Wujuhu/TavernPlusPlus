import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { DEFAULT_AVATAR_PATH, DEFAULT_USER, USER_DIRECTORY_TEMPLATE } from '../constants.js';
import { parse, read as readCharacterCardMetadata, write } from '../character-card-parser.js';
import { serverDirectory } from '../server-directory.js';
import { applyTextMacros } from './macros.js';
import { loadDefaultPresets } from './default-presets.js';

const CHARACTER_EXTENSION = '.png';
const CHAT_EXTENSION = '.jsonl';
const PRESET_LOCATIONS = Object.freeze({
    kobold: { directoryKey: 'koboldAI_Settings', extension: '.json' },
    koboldhorde: { directoryKey: 'koboldAI_Settings', extension: '.json' },
    novel: { directoryKey: 'novelAI_Settings', extension: '.json' },
    textgenerationwebui: { directoryKey: 'textGen_Settings', extension: '.json' },
    openai: { directoryKey: 'openAI_Settings', extension: '.json' },
    instruct: { directoryKey: 'instruct', extension: '.json' },
    context: { directoryKey: 'context', extension: '.json' },
    sysprompt: { directoryKey: 'sysprompt', extension: '.json' },
    reasoning: { directoryKey: 'reasoning', extension: '.json' },
});
const MODEL_PROFILES_FILE = 'model-profiles.json';

function safeName(value, fallback = 'item') {
    const sanitized = sanitize(String(value || fallback)).trim();
    return sanitized || fallback;
}

function slugify(value, fallback = 'item') {
    const normalized = safeName(value, fallback)
        .replace(/\s+/g, '-')
        .replace(/[^\p{L}\p{N}_.-]/gu, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    return normalized || fallback;
}

function ensureUnderRoot(root, target) {
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(target);
    if (resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
        return resolvedTarget;
    }

    throw new Error('Resolved path escapes the headless data root.');
}

function getHeadlessDirectories(dataRoot, handle) {
    const directories = structuredClone(USER_DIRECTORY_TEMPLATE);
    for (const key in directories) {
        directories[key] = path.join(dataRoot, handle, USER_DIRECTORY_TEMPLATE[key]);
    }
    return directories;
}

function getDefaultAvatarBuffer() {
    const avatarPath = path.resolve(serverDirectory, DEFAULT_AVATAR_PATH);
    return fs.readFileSync(avatarPath);
}

function makeCharacterCard(input) {
    if (input && input.spec && input.data) {
        return input;
    }

    const name = safeName(input?.name, 'Assistant');
    const tags = Array.isArray(input?.tags)
        ? input.tags
        : String(input?.tags || '').split(',').map(tag => tag.trim()).filter(Boolean);

    return {
        name,
        description: input?.description || '',
        personality: input?.personality || '',
        scenario: input?.scenario || '',
        first_mes: input?.first_mes || input?.firstMessage || '',
        mes_example: input?.mes_example || '',
        creatorcomment: input?.creator_notes || input?.creatorcomment || '',
        avatar: 'none',
        chat: input?.chat || `${name} - ${new Date().toISOString()}`,
        talkativeness: Number(input?.talkativeness ?? 0.5),
        fav: Boolean(input?.fav),
        tags,
        create_date: input?.create_date || new Date().toISOString(),
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: input?.description || '',
            personality: input?.personality || '',
            scenario: input?.scenario || '',
            first_mes: input?.first_mes || input?.firstMessage || '',
            mes_example: input?.mes_example || '',
            creator_notes: input?.creator_notes || input?.creatorcomment || '',
            system_prompt: input?.system_prompt || '',
            post_history_instructions: input?.post_history_instructions || '',
            tags,
            creator: input?.creator || '',
            character_version: input?.character_version || '',
            alternate_greetings: Array.isArray(input?.alternate_greetings) ? input.alternate_greetings : [],
            extensions: {
                talkativeness: Number(input?.talkativeness ?? 0.5),
                fav: Boolean(input?.fav),
                world: input?.world || '',
            },
        },
    };
}

function toCharacterView(card, fileName) {
    const data = card?.data || {};
    return {
        id: path.basename(fileName, CHARACTER_EXTENSION),
        avatar: fileName,
        name: card?.name || data.name || path.basename(fileName, CHARACTER_EXTENSION),
        description: card?.description || data.description || '',
        personality: card?.personality || data.personality || '',
        scenario: card?.scenario || data.scenario || '',
        first_mes: card?.first_mes || data.first_mes || '',
        mes_example: card?.mes_example || data.mes_example || '',
        tags: card?.tags || data.tags || [],
        spec: card?.spec || 'chara_card_v2',
        spec_version: card?.spec_version || '2.0',
        data,
        raw: card,
    };
}

function encodeChatId(relativePath) {
    return Buffer.from(relativePath, 'utf8').toString('base64url');
}

function decodeChatId(id) {
    return Buffer.from(String(id), 'base64url').toString('utf8');
}

function serializeJsonl(items) {
    return `${items.map(item => JSON.stringify(item)).join('\n')}\n`;
}

function parseJsonl(content) {
    return content
        .split(/\r?\n/)
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
}

function makeMessage(input) {
    return {
        name: input.name || (input.is_user ? 'User' : 'Assistant'),
        is_user: Boolean(input.is_user),
        send_date: input.send_date || new Date().toISOString(),
        mes: String(input.mes ?? input.content ?? ''),
        extra: {
            ...(input.extra || {}),
            headless: {
                ...(input.extra?.headless || {}),
                id: input.extra?.headless?.id || input.id || crypto.randomUUID(),
            },
        },
    };
}

async function getUniquePath(directory, baseName, extension) {
    await fs.promises.mkdir(directory, { recursive: true });
    const cleanBase = slugify(baseName);
    let suffix = 0;

    while (true) {
        const name = suffix === 0 ? cleanBase : `${cleanBase}-${suffix}`;
        const filePath = path.join(directory, `${name}${extension}`);
        if (!fs.existsSync(filePath)) {
            return filePath;
        }
        suffix++;
    }
}

function getPresetLocation(directories, apiId = 'openai') {
    const location = PRESET_LOCATIONS[apiId];
    if (!location) {
        throw new Error(`Unsupported preset apiId: ${apiId}`);
    }

    return {
        apiId,
        folder: directories[location.directoryKey],
        extension: location.extension,
    };
}

function getHeadlessMetaDirectory(context) {
    return path.join(context.user.directories.root, 'headless');
}

async function readJsonFile(filePath, fallback) {
    if (!fs.existsSync(filePath)) {
        return fallback;
    }

    return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
}

async function writeJsonFile(filePath, value) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    writeFileAtomicSync(filePath, JSON.stringify(value, null, 4));
}

function getModelProfilesPath(context) {
    return path.join(getHeadlessMetaDirectory(context), MODEL_PROFILES_FILE);
}

function normalizeModelProfile(input, existing = {}) {
    const now = new Date().toISOString();
    const name = safeName(input?.name || existing.name, 'model');
    const id = existing.id || slugify(input?.id || name, 'model');
    const provider = input?.provider || existing.provider || 'openai';

    return {
        id,
        name,
        provider,
        baseUrl: input?.baseUrl ?? input?.openAiBaseUrl ?? existing.baseUrl ?? '',
        apiKey: input?.apiKey ?? input?.openAiApiKey ?? existing.apiKey ?? '',
        model: input?.model ?? input?.openAiModel ?? existing.model ?? 'gpt-4o-mini',
        parameters: input?.parameters ?? existing.parameters ?? {},
        createdAt: existing.createdAt || now,
        updatedAt: now,
    };
}

function toPublicModelProfile(profile, includeSecret = false) {
    return {
        id: profile.id,
        name: profile.name,
        provider: profile.provider,
        baseUrl: profile.baseUrl,
        model: profile.model,
        parameters: profile.parameters || {},
        hasApiKey: Boolean(profile.apiKey),
        apiKey: includeSecret ? profile.apiKey : undefined,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
    };
}

export function createHeadlessContext(config) {
    const userHandle = config.userHandle || DEFAULT_USER.handle;
    const directories = getHeadlessDirectories(config.dataRoot, userHandle);
    return {
        dataRoot: config.dataRoot,
        user: {
            profile: { ...DEFAULT_USER, handle: userHandle },
            directories,
        },
    };
}

export async function ensureHeadlessData(context) {
    await fs.promises.mkdir(context.dataRoot, { recursive: true });
    for (const directory of Object.values(context.user.directories)) {
        await fs.promises.mkdir(directory, { recursive: true });
    }

    await seedDefaultPresets(context);
}

async function seedDefaultPresets(context) {
    for (const entry of loadDefaultPresets()) {
        const location = getPresetLocation(context.user.directories, entry.apiId || 'openai');
        const filePath = path.join(location.folder, `${safeName(entry.name)}${location.extension}`);
        if (!fs.existsSync(filePath)) {
            writeFileAtomicSync(filePath, JSON.stringify(entry.preset, null, 4));
            console.log(`Seeded default preset: ${entry.apiId}:${entry.name}`);
        }
    }
}

export async function listCharacters(context) {
    const files = await fs.promises.readdir(context.user.directories.characters, { withFileTypes: true });
    const characters = [];

    for (const file of files.filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === CHARACTER_EXTENSION)) {
        characters.push(await readCharacter(context, path.basename(file.name, CHARACTER_EXTENSION)));
    }

    return characters.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createCharacter(context, input) {
    const card = makeCharacterCard(input);
    const filePath = await getUniquePath(context.user.directories.characters, input?.id || card.name, CHARACTER_EXTENSION);
    const output = write(getDefaultAvatarBuffer(), JSON.stringify(card));

    writeFileAtomicSync(filePath, output);
    return toCharacterView(card, path.basename(filePath));
}

export async function importCharacterCard(context, input) {
    const buffer = Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer);
    const metadata = JSON.parse(readCharacterCardMetadata(buffer));
    const cardName = metadata?.data?.name || metadata?.name || path.basename(input.filename || 'character', CHARACTER_EXTENSION);
    const baseName = slugify(input.id || cardName);
    const directPath = path.join(context.user.directories.characters, `${baseName}${CHARACTER_EXTENSION}`);
    await fs.promises.mkdir(context.user.directories.characters, { recursive: true });
    const updated = fs.existsSync(directPath);

    writeFileAtomicSync(directPath, buffer);
    const view = toCharacterView(metadata, path.basename(directPath));
    view.updated = updated;
    return view;
}

export async function readCharacter(context, id) {
    const fileName = `${safeName(id)}${CHARACTER_EXTENSION}`;
    const filePath = ensureUnderRoot(context.user.directories.characters, path.join(context.user.directories.characters, fileName));

    if (!fs.existsSync(filePath)) {
        throw new Error(`Character not found: ${id}`);
    }

    const card = JSON.parse(await parse(filePath, 'png'));
    return toCharacterView(card, path.basename(filePath));
}

export async function listWorldbooks(context) {
    const files = await fs.promises.readdir(context.user.directories.worlds, { withFileTypes: true });
    const result = [];

    for (const file of files.filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.json')) {
        const id = path.basename(file.name, '.json');
        const data = JSON.parse(await fs.promises.readFile(path.join(context.user.directories.worlds, file.name), 'utf8'));
        result.push({ id, name: data.name || id, entries: data.entries || {}, data });
    }

    return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readWorldbook(context, id) {
    const fileName = `${safeName(id)}.json`;
    const filePath = ensureUnderRoot(context.user.directories.worlds, path.join(context.user.directories.worlds, fileName));
    if (!fs.existsSync(filePath)) {
        throw new Error(`Worldbook not found: ${id}`);
    }

    const data = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    return { id: path.basename(fileName, '.json'), name: data.name || path.basename(fileName, '.json'), data };
}

export async function createWorldbook(context, input) {
    const name = safeName(input?.name, 'worldbook');
    const data = input?.data || { name, entries: input?.entries || {} };
    if (!data.entries) {
        data.entries = {};
    }

    const filePath = await getUniquePath(context.user.directories.worlds, input?.id || name, '.json');
    writeFileAtomicSync(filePath, JSON.stringify(data, null, 4));
    return { id: path.basename(filePath, '.json'), name: data.name || name, data };
}

export async function listPresets(context, apiId = undefined) {
    const apiIds = apiId ? [apiId] : Object.keys(PRESET_LOCATIONS);
    const presets = [];

    for (const id of apiIds) {
        const location = getPresetLocation(context.user.directories, id);
        const files = await fs.promises.readdir(location.folder, { withFileTypes: true });
        for (const file of files.filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === location.extension)) {
            const name = path.basename(file.name, location.extension);
            const preset = JSON.parse(await fs.promises.readFile(path.join(location.folder, file.name), 'utf8'));
            presets.push({ id: `${id}:${name}`, apiId: id, name, preset });
        }
    }

    return presets.sort((a, b) => a.id.localeCompare(b.id));
}

export async function readPreset(context, id) {
    const [apiId, name] = String(id).includes(':') ? String(id).split(':', 2) : ['openai', String(id)];
    const location = getPresetLocation(context.user.directories, apiId);
    const filePath = path.join(location.folder, `${safeName(name)}${location.extension}`);

    if (!fs.existsSync(filePath)) {
        throw new Error(`Preset not found: ${id}`);
    }

    const preset = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    return { id: `${apiId}:${safeName(name)}`, apiId, name: safeName(name), preset };
}

export async function createPreset(context, input) {
    const apiId = input?.apiId || 'openai';
    const name = safeName(input?.name, 'preset');
    const location = getPresetLocation(context.user.directories, apiId);
    const filePath = path.join(location.folder, `${name}${location.extension}`);
    const updated = fs.existsSync(filePath);

    writeFileAtomicSync(filePath, JSON.stringify(input?.preset || {}, null, 4));
    return { id: `${apiId}:${name}`, apiId, name, preset: input?.preset || {}, updated };
}

export async function importPresetJson(context, input) {
    const raw = input.data ?? input.text ?? input.buffer?.toString('utf8') ?? '{}';
    const preset = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const fallbackName = input.filename ? path.basename(input.filename, path.extname(input.filename)) : 'preset';

    return createPreset(context, {
        apiId: input.apiId || 'openai',
        name: input.name || preset.name || fallbackName,
        preset,
    });
}

export async function listModelProfiles(context, options = {}) {
    const profiles = await readJsonFile(getModelProfilesPath(context), []);
    return profiles.map(profile => toPublicModelProfile(profile, Boolean(options.includeSecret)));
}

export async function readModelProfile(context, id, options = {}) {
    const profiles = await readJsonFile(getModelProfilesPath(context), []);
    const profile = profiles.find(item => item.id === id);

    if (!profile) {
        throw new Error(`Model profile not found: ${id}`);
    }

    return toPublicModelProfile(profile, Boolean(options.includeSecret));
}

export async function createModelProfile(context, input) {
    const profiles = await readJsonFile(getModelProfilesPath(context), []);
    const targetName = safeName(input?.name || 'model');
    const existingIndex = profiles.findIndex(p => p.name === targetName);

    if (existingIndex !== -1) {
        profiles[existingIndex] = normalizeModelProfile(input, profiles[existingIndex]);
        await writeJsonFile(getModelProfilesPath(context), profiles);
        const result = toPublicModelProfile(profiles[existingIndex]);
        result.updated = true;
        return result;
    }

    const profile = normalizeModelProfile(input);
    profiles.push(profile);
    await writeJsonFile(getModelProfilesPath(context), profiles);
    const result = toPublicModelProfile(profile);
    result.updated = false;
    return result;
}

export async function updateModelProfile(context, id, input) {
    const profiles = await readJsonFile(getModelProfilesPath(context), []);
    const index = profiles.findIndex(item => item.id === id);

    if (index === -1) {
        throw new Error(`Model profile not found: ${id}`);
    }

    profiles[index] = normalizeModelProfile(input, profiles[index]);
    await writeJsonFile(getModelProfilesPath(context), profiles);
    return toPublicModelProfile(profiles[index]);
}

export async function createChat(context, input = {}) {
    const characterId = slugify(input.characterId || 'headless');
    const characterName = input.characterName || input.characterId || 'Assistant';
    const userName = input.userName || 'User';
    const title = input.title || `${characterName} - ${new Date().toISOString()}`;
    const directory = path.join(context.user.directories.chats, characterId);
    const filePath = await getUniquePath(directory, title, CHAT_EXTENSION);
    const header = {
        chat_metadata: {
            ...(input.metadata || {}),
            headless: {
                id: crypto.randomUUID(),
                characterId,
                title,
            },
        },
        user_name: userName,
        character_name: characterName,
    };
    const records = [header];
    const firstMessage = input.firstMes ?? input.first_mes;

    if (firstMessage) {
        records.push(makeMessage({
            name: characterName,
            is_user: false,
            mes: applyTextMacros(firstMessage, { charName: characterName, userName }),
        }));
    }

    writeFileAtomicSync(filePath, serializeJsonl(records));
    return readChat(context, encodeChatId(path.relative(context.user.directories.chats, filePath)));
}

export async function listChats(context) {
    const chats = [];

    async function walk(directory) {
        const entries = await fs.promises.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            const filePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await walk(filePath);
            } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === CHAT_EXTENSION) {
                const relativePath = path.relative(context.user.directories.chats, filePath);
                const chat = await readChat(context, encodeChatId(relativePath));
                chats.push({
                    id: chat.id,
                    title: chat.title,
                    characterId: chat.characterId,
                    messageCount: chat.messages.length,
                    updatedAt: chat.updatedAt,
                });
            }
        }
    }

    await walk(context.user.directories.chats);
    return chats.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function readChat(context, id) {
    const relativePath = decodeChatId(id);
    const filePath = ensureUnderRoot(context.user.directories.chats, path.join(context.user.directories.chats, relativePath));

    if (!fs.existsSync(filePath)) {
        throw new Error(`Chat not found: ${id}`);
    }

    const lines = parseJsonl(await fs.promises.readFile(filePath, 'utf8'));
    const stat = await fs.promises.stat(filePath);
    const header = lines[0] || {};
    const messages = lines.slice(1);
    const metadata = header.chat_metadata || {};

    return {
        id,
        title: metadata.headless?.title || path.basename(filePath, CHAT_EXTENSION),
        characterId: metadata.headless?.characterId || path.basename(path.dirname(filePath)),
        file: relativePath,
        header,
        messages,
        updatedAt: stat.mtimeMs,
    };
}

export async function appendChatMessage(context, chatId, input) {
    const chat = await readChat(context, chatId);
    const filePath = ensureUnderRoot(context.user.directories.chats, path.join(context.user.directories.chats, chat.file));
    const message = makeMessage(input);

    writeFileAtomicSync(filePath, serializeJsonl([chat.header, ...chat.messages, message]));
    return message;
}

export async function rewriteChatMessages(context, chatId, messages) {
    const chat = await readChat(context, chatId);
    const filePath = ensureUnderRoot(context.user.directories.chats, path.join(context.user.directories.chats, chat.file));

    writeFileAtomicSync(filePath, serializeJsonl([chat.header, ...messages]));
    return readChat(context, chatId);
}

export async function removeLastAssistantMessage(context, chatId) {
    const chat = await readChat(context, chatId);
    const messages = [...chat.messages];

    for (let index = messages.length - 1; index >= 0; index--) {
        if (!messages[index].is_user) {
            const removed = messages.splice(index, 1)[0];
            await rewriteChatMessages(context, chatId, messages);
            return removed;
        }
    }

    return null;
}
