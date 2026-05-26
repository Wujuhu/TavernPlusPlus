import path from 'node:path';

import { HeadlessClient } from './headless-client.js';
import { JsonStateStore } from './store.js';
import { TelegramApi } from './telegram-api.js';

export const TELEGRAM_BOT_COMMANDS = Object.freeze([
    { command: 'start', description: '启动酒馆网关' },
    { command: 'help', description: '显示帮助信息' },
    { command: 'status', description: '查看当前配置状态' },
    { command: 'setmodel', description: '保存并选择模型 API 配置' },
    { command: 'model', description: '查看或切换模型配置' },
    { command: 'character', description: '查看或切换角色卡' },
    { command: 'preset', description: '查看或切换预设' },
    { command: 'newchat', description: '开始新对话' },
    { command: 'retry', description: '重新生成上一条回复' },
]);

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const STREAM_EDIT_DEBOUNCE_MS = 1000;
const STREAM_SPLIT_THRESHOLD = 3900;
const CURSOR = '▍';

function getChatId(message) {
    return message?.chat?.id;
}

function getUserId(message) {
    return message?.from?.id;
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
    const message = String(error?.message || error || '未知错误').replace(/\s+/g, ' ').trim();
    const text = `操作失败：${message}`;
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
        return '暂无数据。';
    }

    return items.map(formatter).join('\n');
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

function splitLongMessage(text) {
    if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
        return [text];
    }

    const chunks = [];
    let remaining = text;

    while (remaining.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
        let splitAt = remaining.lastIndexOf('\n', TELEGRAM_MAX_MESSAGE_LENGTH);
        if (splitAt < TELEGRAM_MAX_MESSAGE_LENGTH / 2) {
            splitAt = remaining.lastIndexOf(' ', TELEGRAM_MAX_MESSAGE_LENGTH);
        }
        if (splitAt < TELEGRAM_MAX_MESSAGE_LENGTH / 2) {
            splitAt = TELEGRAM_MAX_MESSAGE_LENGTH;
        }
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).trimStart();
    }

    if (remaining) {
        chunks.push(remaining);
    }

    return chunks;
}

function maskApiKey(key) {
    if (!key) return '未配置';
    if (key.length <= 8) return '***';
    return `${key.slice(0, 4)}***${key.slice(-4)}`;
}

export class TelegramGateway {
    #userClients = new Map();

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

        const fetchImpl = config.fetchImpl || undefined;
        return new TelegramGateway({
            config,
            store,
            telegram: overrides.telegram || new TelegramApi({ token: config.token, fetchImpl }),
            headless: overrides.headless || null,
        });
    }

    #getHeadless(userId) {
        if (this.headless) {
            return this.headless;
        }

        const handle = `tg-${userId}`;
        if (!this.#userClients.has(handle)) {
            this.#userClients.set(handle, new HeadlessClient({
                baseUrl: this.config.headlessBaseUrl,
                token: this.config.headlessToken,
                userHandle: handle,
            }));
        }
        return this.#userClients.get(handle);
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
        const userId = getUserId(message) || chatId;

        if (!chatId || !message) {
            return;
        }

        const whitelist = this.config.allowedUserIds;
        if (whitelist && whitelist.length > 0 && !whitelist.includes(Number(userId))) {
            console.warn(`Telegram update ${update.update_id}: blocked user=${userId}`);
            await this.telegram.sendMessage(chatId, '访问被拒绝：你的用户 ID 不在白名单中。');
            return;
        }

        try {
            console.log(`Telegram update ${update.update_id}: chat=${chatId} user=${userId} type=${getMessageKind(message)}`);

            if (message.document) {
                await this.#handleDocument(chatId, userId, message.document);
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
                await this.#handleCommand(chatId, userId, text);
                return;
            }

            await this.#handleConversation(chatId, userId, text);
        } catch (error) {
            console.error(`Telegram update ${update.update_id} failed:`, error);
            await this.#sendSafe(chatId, formatTelegramError(error));
        }
    }

    async #handleCommand(chatId, userId, text) {
        const { command, arg } = parseCommand(text);
        const headless = this.#getHeadless(userId);
        console.log(`Telegram command: chat=${chatId} command=${command}`);

        await this.telegram.sendChatAction(chatId, 'typing');

        switch (command) {
            case '/start':
            case '/help':
                await this.telegram.sendMessage(chatId, [
                    '酒馆网关已连接。',
                    '',
                    '发送 PNG 角色卡文件（作为文档）→ 导入并选中角色',
                    '发送 JSON 预设文件（作为文档）→ 导入并选中预设',
                    '（同名文件会自动覆盖更新，不会重复创建）',
                    '',
                    '/setmodel 名称 BaseURL APIKey 模型名',
                    '/model 查看模型列表 · /model 序号 切换模型',
                    '/character 查看角色列表 · /character 序号 切换角色',
                    '/preset 查看预设列表 · /preset 序号 切换预设',
                    '/newchat 开始新对话 · /retry 重新生成',
                    '/status 查看当前状态',
                ].join('\n'));
                return;
            case '/status':
                await this.#sendStatus(chatId, headless);
                return;
            case '/model':
                if (arg) {
                    await this.#selectModel(chatId, headless, arg);
                } else {
                    await this.#sendModels(chatId, headless);
                }
                return;
            case '/setmodel':
                await this.#setModel(chatId, headless, text);
                return;
            case '/character':
                if (arg) {
                    await this.#selectCharacter(chatId, headless, arg);
                } else {
                    await this.#sendCharacters(chatId, headless);
                }
                return;
            case '/preset':
                if (arg) {
                    await this.#selectPreset(chatId, headless, arg);
                } else {
                    await this.#sendPresets(chatId, headless);
                }
                return;
            case '/newchat':
                await this.#handleNewChat(chatId, headless);
                return;
            case '/retry':
                await this.#handleRetry(chatId, userId, headless);
                return;
            default:
                await this.telegram.sendMessage(chatId, '未知命令，发送 /help 查看帮助。');
        }
    }

    async #handlePhoto(chatId) {
        console.warn(`Telegram photo ignored: chat=${chatId}; character cards must be uploaded as files/documents.`);
        await this.telegram.sendMessage(chatId, [
            'Telegram 将此作为图片接收，而非文件。',
            '请以「文件/文档」方式重新发送 SillyTavern PNG 角色卡。',
            '压缩后的图片不会保留 PNG 中的角色卡元数据。',
        ].join('\n'));
    }

    async #handleDocument(chatId, userId, document) {
        const headless = this.#getHeadless(userId);
        const name = getDocumentName(document);
        console.log(`Telegram document received: chat=${chatId} name=${name} mime=${document.mime_type || 'unknown'}`);

        await this.telegram.sendChatAction(chatId, 'typing');

        if (isPng(name, document.mime_type)) {
            await this.telegram.sendMessage(chatId, `已接收文件：${name}\n正在导入角色卡...`);
            const buffer = await this.telegram.downloadFile(document.file_id);
            const character = await headless.importCharacter(buffer, name);
            this.store.updateChat(chatId, {
                characterId: character.id,
                chatId: null,
                sessionId: null,
            });
            const verb = character.updated ? '已更新' : '已导入';
            console.log(`Character ${verb} from Telegram: chat=${chatId} id=${character.id} name=${character.name}`);
            await this.telegram.sendMessage(chatId, `角色卡${verb}并选中：${character.name}（${character.id}）`);
            return;
        }

        if (isJson(name, document.mime_type)) {
            await this.telegram.sendMessage(chatId, `已接收文件：${name}\n正在导入预设...`);
            const buffer = await this.telegram.downloadFile(document.file_id);
            const preset = await headless.importPreset(buffer, name, 'openai');
            this.store.updateChat(chatId, {
                presetId: preset.id,
                sessionId: null,
            });
            const verb = preset.updated ? '已更新' : '已导入';
            console.log(`Preset ${verb} from Telegram: chat=${chatId} id=${preset.id} name=${preset.name}`);
            await this.telegram.sendMessage(chatId, `预设${verb}并选中：${preset.name}（${preset.id}）`);
            return;
        }

        console.warn(`Unsupported Telegram document: chat=${chatId} name=${name} mime=${document.mime_type || 'unknown'}`);
        await this.telegram.sendMessage(chatId, '仅支持 PNG 角色卡和 JSON 预设文件。');
    }

    async #handleConversation(chatId, userId, text) {
        console.log(`Telegram conversation message: chat=${chatId} length=${text.length}`);
        const headless = this.#getHeadless(userId);
        const hadChat = Boolean(this.store.getChat(chatId).chatId);
        const state = await this.#prepareState(chatId, headless);
        const sessionId = await headless.ensureSession(state);
        this.store.updateChat(chatId, { sessionId });

        if (!hadChat) {
            await this.#sendGreeting(chatId, headless, state.chatId);
        }

        await this.#streamGeneration(chatId, headless, sessionId, text);
    }

    async #handleNewChat(chatId, headless) {
        const state = this.store.getChat(chatId);
        this.store.updateChat(chatId, { chatId: null, sessionId: null });

        if (state.characterId) {
            try {
                const character = await headless.get(`/characters/${state.characterId}`);
                const firstMes = character.first_mes || character.data?.first_mes;
                if (firstMes) {
                    const chat = await headless.post('/chats', {
                        characterId: state.characterId,
                        title: `telegram-${chatId}`,
                    });
                    this.store.updateChat(chatId, { chatId: chat.id });
                    await this.telegram.sendMessage(chatId, '新对话已开始。');
                    await this.#sendGreeting(chatId, headless, chat.id);
                    return;
                }
            } catch {
                // Fall through to simple message
            }
        }

        await this.telegram.sendMessage(chatId, '下一条消息将开始新对话。');
    }

    async #handleRetry(chatId, userId, headless) {
        const state = this.store.getChat(chatId);
        if (!state.chatId || !state.sessionId) {
            await this.telegram.sendMessage(chatId, '当前没有进行中的对话，无法重新生成。');
            return;
        }

        try {
            const result = await headless.post(`/chats/${state.chatId}/regenerate`, {
                characterId: state.characterId,
                presetId: state.presetId,
                modelProfileId: state.modelProfileId,
            });

            const eventsUrl = result.events;
            if (!eventsUrl) {
                await this.telegram.sendMessage(chatId, '重新生成请求已提交。');
                return;
            }

            await this.#streamFromEvents(chatId, headless, eventsUrl);
        } catch (error) {
            await this.#sendSafe(chatId, formatTelegramError(error));
        }
    }

    async #sendGreeting(chatId, headless, hChatId) {
        try {
            const chatData = await headless.get(`/chats/${hChatId}`);
            const greeting = chatData.messages?.[0];
            if (greeting && !greeting.is_user && greeting.mes) {
                await this.#sendSafe(chatId, greeting.mes);
            }
        } catch {
            // Non-fatal
        }
    }

    async #streamGeneration(chatId, headless, sessionId, text) {
        let msgId = null;
        let currentText = '';
        let fullText = '';
        let lastEditAt = 0;

        try {
            const initial = await this.telegram.sendMessage(chatId, CURSOR);
            msgId = initial.message_id;

            console.log(`Generation started: chat=${chatId} session=${sessionId}`);

            for await (const event of headless.generateStream(sessionId, text)) {
                if (event.type === 'error') {
                    throw new Error(event.message);
                }
                if (event.type !== 'token') continue;

                fullText += event.token;
                currentText += event.token;

                if (currentText.length > STREAM_SPLIT_THRESHOLD) {
                    await this.#editSafe(chatId, msgId, currentText);
                    currentText = '';
                    const next = await this.telegram.sendMessage(chatId, CURSOR);
                    msgId = next.message_id;
                    lastEditAt = Date.now();
                    continue;
                }

                const now = Date.now();
                if (now - lastEditAt >= STREAM_EDIT_DEBOUNCE_MS) {
                    await this.#editSafe(chatId, msgId, currentText + CURSOR);
                    lastEditAt = now;
                }
            }

            if (currentText) {
                await this.#editSafe(chatId, msgId, currentText);
            } else if (!fullText) {
                await this.#editSafe(chatId, msgId, '模型未返回任何内容。');
            }

            if (fullText) {
                console.log(`Generation completed: chat=${chatId} session=${sessionId} chars=${fullText.length}`);
            } else {
                console.warn(`Generation completed without content: chat=${chatId} session=${sessionId}`);
            }
        } catch (error) {
            console.error(`Generation failed: chat=${chatId}`, error);
            const errorText = formatTelegramError(error);
            if (msgId) {
                await this.#editSafe(chatId, msgId, errorText);
            } else {
                await this.#sendSafe(chatId, errorText);
            }
        }
    }

    async #streamFromEvents(chatId, headless, eventsUrl) {
        let msgId = null;
        let currentText = '';
        let fullText = '';
        let lastEditAt = 0;

        try {
            const initial = await this.telegram.sendMessage(chatId, CURSOR);
            msgId = initial.message_id;

            for await (const event of headless.streamEvents(eventsUrl)) {
                if (event.type === 'error') {
                    throw new Error(event.message);
                }
                if (event.type !== 'token') continue;

                fullText += event.token;
                currentText += event.token;

                if (currentText.length > STREAM_SPLIT_THRESHOLD) {
                    await this.#editSafe(chatId, msgId, currentText);
                    currentText = '';
                    const next = await this.telegram.sendMessage(chatId, CURSOR);
                    msgId = next.message_id;
                    lastEditAt = Date.now();
                    continue;
                }

                const now = Date.now();
                if (now - lastEditAt >= STREAM_EDIT_DEBOUNCE_MS) {
                    await this.#editSafe(chatId, msgId, currentText + CURSOR);
                    lastEditAt = now;
                }
            }

            if (currentText) {
                await this.#editSafe(chatId, msgId, currentText);
            } else if (!fullText) {
                await this.#editSafe(chatId, msgId, '模型未返回任何内容。');
            }
        } catch (error) {
            console.error(`Retry generation failed: chat=${chatId}`, error);
            const errorText = formatTelegramError(error);
            if (msgId) {
                await this.#editSafe(chatId, msgId, errorText);
            } else {
                await this.#sendSafe(chatId, errorText);
            }
        }
    }

    async #editSafe(chatId, messageId, text) {
        try {
            await this.telegram.editMessageText(chatId, messageId, text);
        } catch (error) {
            if (!String(error.message).includes('message is not modified')) {
                throw error;
            }
        }
    }

    async #sendSafe(chatId, text) {
        const chunks = splitLongMessage(text);
        for (const chunk of chunks) {
            await this.telegram.sendMessage(chatId, chunk);
        }
    }

    async #prepareState(chatId, headless) {
        const state = this.store.getChat(chatId);

        if (!state.characterId) {
            const characters = await headless.get('/characters');
            if (characters.length === 1) {
                state.characterId = characters[0].id;
            } else {
                throw new Error('请先上传一张 PNG 角色卡，或使用 /character 查看列表后选择。');
            }
        }

        if (!state.chatId) {
            const chat = await headless.post('/chats', {
                characterId: state.characterId,
                title: `telegram-${chatId}`,
            });
            state.chatId = chat.id;
        }

        this.store.updateChat(chatId, state);
        return state;
    }

    async #setModel(chatId, headless, text) {
        const profile = parseSetModel(text);
        if (!profile) {
            await this.telegram.sendMessage(chatId, '格式：/setmodel 名称 BaseURL APIKey 模型名');
            return;
        }

        const created = await headless.post('/model-profiles', {
            name: profile.name,
            provider: 'openai',
            baseUrl: profile.baseUrl,
            apiKey: profile.apiKey,
            model: profile.model,
        });
        this.store.updateChat(chatId, { modelProfileId: created.id, sessionId: null });
        const verb = created.updated ? '已更新' : '已创建';
        console.log(`Model profile ${verb} from Telegram: chat=${chatId} id=${created.id} name=${created.name} model=${created.model}`);
        await this.telegram.sendMessage(chatId, `模型配置${verb}并选中：${created.name}（${created.id}）`);
    }

    async #selectModel(chatId, headless, arg) {
        const items = await headless.get('/model-profiles');
        const selected = resolveSelection(items, arg);
        if (!selected) {
            await this.telegram.sendMessage(chatId, `未找到模型配置：${arg}\n使用 /model 查看可用列表。`);
            return;
        }

        this.store.updateChat(chatId, { modelProfileId: selected.id, sessionId: null });
        await this.telegram.sendMessage(chatId, `已切换模型配置：${selected.name}（${selected.id}）`);
    }

    async #selectCharacter(chatId, headless, arg) {
        const items = await headless.get('/characters');
        const selected = resolveSelection(items, arg);
        if (!selected) {
            await this.telegram.sendMessage(chatId, `未找到角色卡：${arg}\n使用 /character 查看可用列表。`);
            return;
        }

        this.store.updateChat(chatId, { characterId: selected.id, chatId: null, sessionId: null });
        await this.telegram.sendMessage(chatId, `已切换角色卡：${selected.name}（${selected.id}）`);
    }

    async #selectPreset(chatId, headless, arg) {
        const items = await headless.get('/presets?apiId=openai');
        const selected = resolveSelection(items, arg);
        if (!selected) {
            await this.telegram.sendMessage(chatId, `未找到预设：${arg}\n使用 /preset 查看可用列表。`);
            return;
        }

        this.store.updateChat(chatId, { presetId: selected.id, sessionId: null });
        await this.telegram.sendMessage(chatId, `已切换预设：${selected.name}（${selected.id}）`);
    }

    async #sendModels(chatId, headless) {
        const state = this.store.getChat(chatId);
        const items = await headless.get('/model-profiles?includeSecret=true');
        await this.#sendSafe(chatId, formatList(items, (item, index) => {
            const mark = item.id === state.modelProfileId ? ' [当前]' : '';
            return `${index + 1}. ${item.name} | ${item.model} | ${maskApiKey(item.apiKey)}${mark}`;
        }));
    }

    async #sendCharacters(chatId, headless) {
        const state = this.store.getChat(chatId);
        const items = await headless.get('/characters');
        await this.#sendSafe(chatId, formatList(items, (item, index) => {
            const mark = item.id === state.characterId ? ' [当前]' : '';
            return `${index + 1}. ${item.name}${mark}`;
        }));
    }

    async #sendPresets(chatId, headless) {
        const state = this.store.getChat(chatId);
        const items = await headless.get('/presets?apiId=openai');
        await this.#sendSafe(chatId, formatList(items, (item, index) => {
            const mark = item.id === state.presetId ? ' [当前]' : '';
            return `${index + 1}. ${item.name}${mark}`;
        }));
    }

    async #sendStatus(chatId, headless) {
        const state = this.store.getChat(chatId);
        const lines = ['当前配置状态', ''];

        if (state.characterId) {
            try {
                const char = await headless.get(`/characters/${state.characterId}`);
                lines.push(`角色卡：${char.name}（${state.characterId}）`);
                if (char.description) {
                    const desc = char.description.length > 80 ? char.description.slice(0, 77) + '...' : char.description;
                    lines.push(`  简介：${desc}`);
                }
            } catch {
                lines.push(`角色卡：${state.characterId}（读取失败）`);
            }
        } else {
            lines.push('角色卡：未选择');
        }

        if (state.presetId) {
            try {
                const presets = await headless.get('/presets?apiId=openai');
                const preset = presets.find(p => p.id === state.presetId);
                if (preset) {
                    const info = [];
                    const p = preset.preset || {};
                    if (p.temperature !== undefined) info.push(`temp=${p.temperature}`);
                    if (p.openai_max_context) info.push(`ctx=${p.openai_max_context}`);
                    if (p.openai_max_tokens) info.push(`max_tokens=${p.openai_max_tokens}`);
                    lines.push(`预设：${preset.name}${info.length ? `（${info.join(', ')}）` : ''}`);
                } else {
                    lines.push(`预设：${state.presetId}`);
                }
            } catch {
                lines.push(`预设：${state.presetId}（读取失败）`);
            }
        } else {
            lines.push('预设：未选择');
        }

        if (state.modelProfileId) {
            try {
                const profile = await headless.get(`/model-profiles/${state.modelProfileId}?includeSecret=true`);
                lines.push(`模型配置：${profile.name}`);
                lines.push(`  模型：${profile.model}`);
                lines.push(`  API：${profile.baseUrl || '未设置'}`);
                lines.push(`  密钥：${maskApiKey(profile.apiKey)}`);
            } catch {
                lines.push(`模型配置：${state.modelProfileId}（读取失败）`);
            }
        } else {
            lines.push('模型配置：未选择');
        }

        lines.push(`对话：${state.chatId ? '进行中' : '未创建'}`);

        await this.telegram.sendMessage(chatId, lines.join('\n'));
    }
}
