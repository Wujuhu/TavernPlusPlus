import path from 'node:path';

import { HeadlessClient } from './headless-client.js';
import { JsonStateStore } from './store.js';
import { TelegramApi } from './telegram-api.js';

export const TELEGRAM_BOT_COMMANDS = Object.freeze([
    { command: 'start', description: 'Start Headless Tavern gateway' },
    { command: 'help', description: 'Show Headless Tavern commands' },
    { command: 'status', description: 'Show selected character, preset, model, and chat' },
    { command: 'setmodel', description: 'Save and select a model API profile' },
    { command: 'models', description: 'List saved model API profiles' },
    { command: 'model', description: 'Switch model API profile by ID' },
    { command: 'characters', description: 'List imported character cards' },
    { command: 'character', description: 'Switch character by ID' },
    { command: 'presets', description: 'List imported JSON presets' },
    { command: 'preset', description: 'Switch preset by ID' },
    { command: 'newchat', description: 'Start a new chat on the next message' },
]);

function getChatId(message) {
    return message?.chat?.id;
}

function getMessageKind(message) {
    if (message?.document) return 'document';
    if (message?.photo) return 'photo';
    if (message?.text) return 'text';
    return 'other';
}

function getDocumentName(document) {
    return document?.file_name || 'upload.bin';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTelegramError(error) {
    const message = String(error?.message || error || 'Unknown error.').replace(/\s+/g, ' ').trim();
    const text = `Operation failed: ${message}`;
    return text.length > 3500 ? `${text.slice(0, 3497)}...` : text;
}

function isPng(name, mimeType = '') {
    return mimeType === 'image/png' || path.extname(name).toLowerCase() === '.png';
}

function isJson(name, mimeType = '') {
    return mimeType === 'application/json' || path.extname(name).toLowerCase() === '.json';
}

function parseSetModel(text) {
    const rest = text.replace(/^\/setmodel(?:@\w+)?\s*/i, '');
    const parts = rest.includes('|')
        ? rest.split('|').map(part => part.trim()).filter(Boolean)
        : rest.split(/\s+/).filter(Boolean);

    if (parts.length < 4) {
        return null;
    }

    return {
        name: parts[0],
        baseUrl: parts[1],
        apiKey: parts[2],
        model: parts.slice(3).join(' '),
    };
}

function formatList(items, formatter) {
    if (!items.length) {
        return 'No data yet.';
    }

    return items.map(formatter).join('\n');
}

function formatSelectionHelp(usage, items, formatter) {
    return [
        usage,
        '',
        formatList(items, (item, index) => `${index + 1}. ${formatter(item)}`),
    ].join('\n');
}

function parseCommand(text) {
    const parts = text.trim().split(/\s+/);
    const command = (parts.shift() || '').toLowerCase().split('@')[0];
    const arg = parts.join(' ').trim();
    return { command, arg };
}

function resolveSelection(items, arg) {
    if (!arg) {
        return null;
    }

    const index = Number(arg);
    if (Number.isInteger(index) && index >= 1 && index <= items.length) {
        return items[index - 1];
    }

    return items.find(item => item.id === arg || item.name === arg) || null;
}

export class TelegramGateway {
    constructor({ config, telegram, headless, store }) {
        this.config = config;
        this.telegram = telegram;
        this.headless = headless;
        this.store = store;
        this.running = false;
    }

    static async create(config, overrides = {}) {
        const store = overrides.store || new JsonStateStore(config.statePath);
        await store.load();

        return new TelegramGateway({
            config,
            store,
            telegram: overrides.telegram || new TelegramApi({ token: config.token }),
            headless: overrides.headless || new HeadlessClient({
                baseUrl: config.headlessBaseUrl,
                token: config.headlessToken,
            }),
        });
    }

    async start() {
        if (!this.config.enabled) {
            console.warn('Telegram gateway is disabled. Set telegram.botToken in config/headless-gateway.config.json to enable it.');
            return;
        }

        if (this.config.registerCommands !== false) {
            await this.telegram.setMyCommands(TELEGRAM_BOT_COMMANDS);
            console.log('Telegram bot commands registered.');
        }

        this.running = true;
        this.#poll().catch(error => {
            console.error('Telegram gateway stopped after an error:', error);
            this.running = false;
        });
        console.log('Telegram gateway started.');
    }

    stop() {
        this.running = false;
    }

    async #poll() {
        while (this.running) {
            try {
                const updates = await this.telegram.getUpdates({
                    offset: this.store.getOffset(),
                    timeout: this.config.pollTimeoutSeconds,
                });

                for (const update of updates) {
                    await this.handleUpdate(update);
                    this.store.setOffset(update.update_id + 1);
                }
            } catch (error) {
                if (!this.running) {
                    return;
                }
                console.warn(`Telegram polling failed; retrying in 3s: ${error.message || error}`);
                await sleep(3000);
            }
        }
    }

    async handleUpdate(update) {
        const message = update.message;
        const chatId = getChatId(message);

        if (!chatId || !message) {
            return;
        }

        try {
            console.log(`Telegram update ${update.update_id}: chat=${chatId} type=${getMessageKind(message)}`);

            if (message.document) {
                await this.#handleDocument(chatId, message.document);
                return;
            }

            if (message.photo) {
                await this.#handlePhoto(chatId);
                return;
            }

            const text = String(message.text || '').trim();
            if (!text) {
                return;
            }

            if (text.startsWith('/')) {
                await this.#handleCommand(chatId, text);
                return;
            }

            await this.#handleConversation(chatId, text);
        } catch (error) {
            console.error(`Telegram update ${update.update_id} failed:`, error);
            await this.telegram.sendMessage(chatId, formatTelegramError(error));
        }
    }

    async #handleCommand(chatId, text) {
        const { command, arg } = parseCommand(text);
        console.log(`Telegram command: chat=${chatId} command=${command}`);

        switch (command) {
            case '/start':
            case '/help':
                await this.telegram.sendMessage(chatId, [
                    'Headless Tavern gateway is connected.',
                    'Send a PNG SillyTavern character card as a file/document to import and select it.',
                    'Send a JSON preset as a file/document to import and select it.',
                    '/setmodel name BaseURL APIKey model',
                    '/models lists model profiles; /model ID switches model',
                    '/characters lists characters; /character ID switches character',
                    '/presets lists presets; /preset ID switches preset',
                    '/newchat starts a new chat; /status shows current config',
                ].join('\n'));
                return;
            case '/status':
                await this.#sendStatus(chatId);
                return;
            case '/models':
                await this.#sendModels(chatId);
                return;
            case '/model':
                await this.#selectModel(chatId, arg);
                return;
            case '/setmodel':
                await this.#setModel(chatId, text);
                return;
            case '/characters':
                await this.#sendCharacters(chatId);
                return;
            case '/character':
                await this.#selectCharacter(chatId, arg);
                return;
            case '/presets':
                await this.#sendPresets(chatId);
                return;
            case '/preset':
                await this.#selectPreset(chatId, arg);
                return;
            case '/newchat':
                this.store.updateChat(chatId, { chatId: null, sessionId: null });
                await this.telegram.sendMessage(chatId, 'The next message will create a new chat.');
                return;
            default:
                await this.telegram.sendMessage(chatId, 'Unknown command. Send /help for usage.');
        }
    }

    async #handlePhoto(chatId) {
        console.warn(`Telegram photo ignored: chat=${chatId}; character cards must be uploaded as files/documents.`);
        await this.telegram.sendMessage(chatId, [
            'Telegram received this as a photo, not as a file.',
            'Please resend the SillyTavern PNG character card as a file/document.',
            'Compressed Telegram photos do not preserve the PNG character-card metadata.',
        ].join('\n'));
    }

    async #handleDocument(chatId, document) {
        const name = getDocumentName(document);
        console.log(`Telegram document received: chat=${chatId} name=${name} mime=${document.mime_type || 'unknown'}`);
        const buffer = await this.telegram.downloadFile(document.file_id);

        if (isPng(name, document.mime_type)) {
            const character = await this.headless.importCharacter(buffer, name);
            this.store.updateChat(chatId, {
                characterId: character.id,
                chatId: null,
                sessionId: null,
            });
            console.log(`Character imported from Telegram: chat=${chatId} id=${character.id} name=${character.name}`);
            await this.telegram.sendMessage(chatId, `Character card imported and selected: ${character.name} (${character.id})`);
            return;
        }

        if (isJson(name, document.mime_type)) {
            const preset = await this.headless.importPreset(buffer, name, 'openai');
            this.store.updateChat(chatId, {
                presetId: preset.id,
                sessionId: null,
            });
            console.log(`Preset imported from Telegram: chat=${chatId} id=${preset.id} name=${preset.name}`);
            await this.telegram.sendMessage(chatId, `Preset imported and selected: ${preset.name} (${preset.id})`);
            return;
        }

        console.warn(`Unsupported Telegram document: chat=${chatId} name=${name} mime=${document.mime_type || 'unknown'}`);
        await this.telegram.sendMessage(chatId, 'Only PNG character-card files and JSON preset files are supported.');
    }

    async #handleConversation(chatId, text) {
        console.log(`Telegram conversation message: chat=${chatId} length=${text.length}`);
        const state = await this.#prepareState(chatId);
        const sessionId = await this.headless.ensureSession(state);
        this.store.updateChat(chatId, { sessionId });

        await this.telegram.sendMessage(chatId, 'Generating...');
        console.log(`Generation started: chat=${chatId} session=${sessionId}`);
        const result = await this.headless.generate(sessionId, text);
        if (result.text) {
            console.log(`Generation completed: chat=${chatId} session=${sessionId} chars=${result.text.length}`);
        } else {
            console.warn(`Generation completed without content: chat=${chatId} session=${sessionId}`);
        }
        await this.telegram.sendMessage(chatId, result.text || 'The model returned no content.');
    }

    async #prepareState(chatId) {
        const state = this.store.getChat(chatId);

        if (!state.characterId) {
            const characters = await this.headless.get('/characters');
            if (characters.length === 1) {
                state.characterId = characters[0].id;
            } else {
                throw new Error('Upload a PNG character card first, or use /characters then /character ID.');
            }
        }

        if (!state.chatId) {
            const chat = await this.headless.post('/chats', {
                characterId: state.characterId,
                title: `telegram-${chatId}`,
            });
            state.chatId = chat.id;
        }

        this.store.updateChat(chatId, state);
        return state;
    }

    async #setModel(chatId, text) {
        const profile = parseSetModel(text);
        if (!profile) {
            await this.telegram.sendMessage(chatId, 'Format: /setmodel name BaseURL APIKey model');
            return;
        }

        const created = await this.headless.post('/model-profiles', {
            name: profile.name,
            provider: 'openai',
            baseUrl: profile.baseUrl,
            apiKey: profile.apiKey,
            model: profile.model,
        });
        this.store.updateChat(chatId, { modelProfileId: created.id, sessionId: null });
        console.log(`Model profile saved from Telegram: chat=${chatId} id=${created.id} name=${created.name} model=${created.model}`);
        await this.telegram.sendMessage(chatId, `Model profile saved and selected: ${created.name} (${created.id})`);
    }

    async #selectModel(chatId, arg) {
        const items = await this.headless.get('/model-profiles');
        const selected = resolveSelection(items, arg);
        if (!arg) {
            await this.telegram.sendMessage(chatId, formatSelectionHelp(
                'Usage: /model ID or /model number',
                items,
                item => `${item.id} | ${item.name} | ${item.model} | ${item.hasApiKey ? 'has key' : 'no key'}`,
            ));
            return;
        }
        if (!selected) {
            await this.telegram.sendMessage(chatId, `Model profile not found: ${arg}\nUse /models to list available model profiles.`);
            return;
        }

        this.store.updateChat(chatId, { modelProfileId: selected.id, sessionId: null });
        await this.telegram.sendMessage(chatId, `Model profile selected: ${selected.name} (${selected.id})`);
    }

    async #selectCharacter(chatId, arg) {
        const items = await this.headless.get('/characters');
        const selected = resolveSelection(items, arg);
        if (!arg) {
            await this.telegram.sendMessage(chatId, formatSelectionHelp(
                'Usage: /character ID or /character number',
                items,
                item => `${item.id} | ${item.name}`,
            ));
            return;
        }
        if (!selected) {
            await this.telegram.sendMessage(chatId, `Character not found: ${arg}\nUse /characters to list available character cards.`);
            return;
        }

        this.store.updateChat(chatId, { characterId: selected.id, chatId: null, sessionId: null });
        await this.telegram.sendMessage(chatId, `Character selected: ${selected.name} (${selected.id})`);
    }

    async #selectPreset(chatId, arg) {
        const items = await this.headless.get('/presets?apiId=openai');
        const selected = resolveSelection(items, arg);
        if (!arg) {
            await this.telegram.sendMessage(chatId, formatSelectionHelp(
                'Usage: /preset ID or /preset number',
                items,
                item => `${item.id} | ${item.name}`,
            ));
            return;
        }
        if (!selected) {
            await this.telegram.sendMessage(chatId, `Preset not found: ${arg}\nUse /presets to list available presets.`);
            return;
        }

        this.store.updateChat(chatId, { presetId: selected.id, sessionId: null });
        await this.telegram.sendMessage(chatId, `Preset selected: ${selected.name} (${selected.id})`);
    }

    async #sendModels(chatId) {
        const items = await this.headless.get('/model-profiles');
        await this.telegram.sendMessage(chatId, formatList(items, (item, index) => `${index + 1}. ${item.id} | ${item.name} | ${item.model} | ${item.hasApiKey ? 'has key' : 'no key'}`));
    }

    async #sendCharacters(chatId) {
        const items = await this.headless.get('/characters');
        await this.telegram.sendMessage(chatId, formatList(items, (item, index) => `${index + 1}. ${item.id} | ${item.name}`));
    }

    async #sendPresets(chatId) {
        const items = await this.headless.get('/presets?apiId=openai');
        await this.telegram.sendMessage(chatId, formatList(items, (item, index) => `${index + 1}. ${item.id} | ${item.name}`));
    }

    async #sendStatus(chatId) {
        const state = this.store.getChat(chatId);
        await this.telegram.sendMessage(chatId, [
            `Character: ${state.characterId || 'not selected'}`,
            `Preset: ${state.presetId || 'not selected'}`,
            `Model: ${state.modelProfileId || 'not selected'}`,
            `Chat: ${state.chatId || 'not created'}`,
        ].join('\n'));
    }
}
