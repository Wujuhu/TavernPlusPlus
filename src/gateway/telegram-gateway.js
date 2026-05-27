import path from 'node:path';

import { HeadlessClient } from './headless-client.js';
import { JsonStateStore } from './store.js';
import { TelegramApi } from './telegram-api.js';

export const TELEGRAM_BOT_COMMANDS = Object.freeze([
    { command: 'start', description: '查看使用说明和配置流程' },
    { command: 'status', description: '查看当前配置状态' },
    { command: 'setmodel', description: '保存并选择模型 API 配置' },
    { command: 'model', description: '查看或切换模型配置' },
    { command: 'character', description: '查看或切换角色卡' },
    { command: 'preset', description: '查看或切换预设' },
    { command: 'newchat', description: '开始新对话' },
    { command: 'retry', description: '重新生成上一条回复' },
]);

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const STREAM_EDIT_DEBOUNCE_MS = 1500;
const STREAM_SPLIT_THRESHOLD = 3900;
const CURSOR = '▍';

function getChatId(message) {
    return message?.chat?.id;
}

function getUserId(message) {
    return message?.from?.id;
}

function getThreadId(message) {
    return message?.message_thread_id ?? null;
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

/**
 * Build a composite state key so each topic / thread gets its own
 * isolated conversation, character selection, etc.
 */
function computeStateKey(chatId, threadId) {
    if (threadId != null) return `${chatId}_t${threadId}`;
    return String(chatId);
}

export class TelegramGateway {
    #userClients = new Map();
    #queues = new Map();

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

                if (updates.length > 0) {
                    this.store.setOffset(updates.at(-1).update_id + 1);
                    for (const update of updates) {
                        this.#dispatch(update);
                    }
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

    #dispatch(update) {
        const message = update.message;
        if (!message) return;

        const chatId = getChatId(message);
        if (!chatId) return;

        const threadId = getThreadId(message);
        const key = threadId != null ? `${chatId}_t${threadId}` : String(chatId);

        const prev = this.#queues.get(key) || Promise.resolve();
        const next = prev
            .then(() => this.handleUpdate(update))
            .catch(err => console.error(`Unhandled error in update ${update.update_id}:`, err))
            .finally(() => {
                if (this.#queues.get(key) === next) {
                    this.#queues.delete(key);
                }
            });
        this.#queues.set(key, next);
    }

    // ── public entry point ──────────────────────────────────────────

    async handleUpdate(update) {
        const message = update.message;
        const chatId = getChatId(message);
        const userId = getUserId(message) || chatId;
        const threadId = getThreadId(message);

        if (!chatId || !message) {
            return;
        }

        const whitelist = this.config.allowedUserIds;
        if (whitelist && whitelist.length > 0 && !whitelist.includes(Number(userId))) {
            console.warn(`Telegram update ${update.update_id}: blocked user=${userId}`);
            const extra = threadId != null ? { message_thread_id: threadId } : {};
            await this.telegram.sendMessage(chatId, '访问被拒绝：你的用户 ID 不在白名单中。', extra);
            return;
        }

        const stateKey = computeStateKey(chatId, threadId);
        const ctx = { chatId, userId, threadId, stateKey };

        try {
            await this.#ensureDefaultPreset(ctx);

            console.log(`Telegram update ${update.update_id}: chat=${chatId} user=${userId} thread=${threadId ?? 'none'} type=${getMessageKind(message)}`);

            if (message.document) {
                await this.#handleDocument(ctx, message.document);
                return;
            }

            if (message.photo) {
                await this.#handlePhoto(ctx);
                return;
            }

            const text = String(message.text || '').trim();
            if (!text) {
                return;
            }

            if (text.startsWith('/')) {
                await this.#handleCommand(ctx, text);
                return;
            }

            await this.#handleConversation(ctx, text);
        } catch (error) {
            console.error(`Telegram update ${update.update_id} failed:`, error);
            await this.#sendSafe(ctx, formatTelegramError(error));
        }
    }

    // ── thread-aware send helpers ───────────────────────────────────

    #threadExtra(ctx) {
        return ctx.threadId != null ? { message_thread_id: ctx.threadId } : {};
    }

    async #sendMsg(ctx, text, extra = {}) {
        return this.telegram.sendMessage(ctx.chatId, text, { ...this.#threadExtra(ctx), ...extra });
    }

    async #typing(ctx) {
        return this.telegram.sendChatAction(ctx.chatId, 'typing', this.#threadExtra(ctx));
    }

    #startTypingLoop(ctx) {
        this.#typing(ctx).catch(() => {});
        const interval = setInterval(() => {
            this.#typing(ctx).catch(() => {});
        }, 4000);
        return () => clearInterval(interval);
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

    async #sendSafe(ctx, text) {
        const chunks = splitLongMessage(text);
        for (const chunk of chunks) {
            await this.#sendMsg(ctx, chunk);
        }
    }

    // ── command routing ─────────────────────────────────────────────

    async #handleCommand(ctx, text) {
        const { command, arg } = parseCommand(text);
        const headless = this.#getHeadless(ctx.userId);
        console.log(`Telegram command: chat=${ctx.chatId} command=${command}`);

        await this.#typing(ctx);

        switch (command) {
            case '/start':
                await this.#sendMsg(ctx, [
                    '🍺 SillyTavern 酒馆网关',
                    '',
                    '━━ 首次配置流程 ━━',
                    '',
                    '1️⃣ 配置模型 API',
                    '/setmodel 名称 BaseURL APIKey 模型名',
                    '示例：',
                    '/setmodel openai https://api.openai.com/v1 sk-xxxx gpt-4o',
                    '/setmodel deepseek https://api.deepseek.com/v1 sk-xxxx deepseek-chat',
                    '',
                    '2️⃣ 导入角色卡',
                    '将 SillyTavern PNG 角色卡以「文件/文档」方式发送到对话中',
                    '',
                    '3️⃣ 导入预设（可选）',
                    '将 JSON 预设文件以「文件/文档」方式发送到对话中',
                    '',
                    '4️⃣ 直接发消息即可开始对话',
                    '',
                    '━━ 所有命令 ━━',
                    '',
                    '/setmodel — 配置模型 API（名称 URL 密钥 模型名）',
                    '/model — 查看模型列表 · /model 序号 切换',
                    '/character — 查看角色列表 · /character 序号 切换',
                    '/preset — 查看预设列表 · /preset 序号 切换',
                    '/newchat — 开始新对话',
                    '/retry — 重新生成上一条回复',
                    '/status — 查看当前配置状态',
                    '',
                    '━━ 提示 ━━',
                    '',
                    '• 同名角色卡/预设会自动覆盖更新，不会重复创建',
                    '• 参数中含空格时可用 | 分隔：/setmodel 名称|URL|密钥|模型名',
                    '• 群聊话题和 Bot 线程中的对话互相隔离',
                ].join('\n'));
                return;
            case '/status':
                await this.#sendStatus(ctx, headless);
                return;
            case '/model':
                if (arg) {
                    await this.#selectModel(ctx, headless, arg);
                } else {
                    await this.#sendModels(ctx, headless);
                }
                return;
            case '/setmodel':
                await this.#setModel(ctx, headless, text);
                return;
            case '/character':
                if (arg) {
                    await this.#selectCharacter(ctx, headless, arg);
                } else {
                    await this.#sendCharacters(ctx, headless);
                }
                return;
            case '/preset':
                if (arg) {
                    await this.#selectPreset(ctx, headless, arg);
                } else {
                    await this.#sendPresets(ctx, headless);
                }
                return;
            case '/newchat':
                await this.#handleNewChat(ctx, headless);
                return;
            case '/retry':
                await this.#handleRetry(ctx, headless);
                return;
            default:
                await this.#sendMsg(ctx, '未知命令，发送 /help 查看帮助。');
        }
    }

    // ── photo / document ────────────────────────────────────────────

    async #handlePhoto(ctx) {
        console.warn(`Telegram photo ignored: chat=${ctx.chatId}; character cards must be uploaded as files/documents.`);
        await this.#sendMsg(ctx, [
            'Telegram 将此作为图片接收，而非文件。',
            '请以「文件/文档」方式重新发送 SillyTavern PNG 角色卡。',
            '压缩后的图片不会保留 PNG 中的角色卡元数据。',
        ].join('\n'));
    }

    async #handleDocument(ctx, document) {
        const headless = this.#getHeadless(ctx.userId);
        const name = getDocumentName(document);
        console.log(`Telegram document received: chat=${ctx.chatId} name=${name} mime=${document.mime_type || 'unknown'}`);

        await this.#typing(ctx);

        if (isPng(name, document.mime_type)) {
            await this.#sendMsg(ctx, `已接收文件：${name}\n正在导入角色卡...`);
            const buffer = await this.telegram.downloadFile(document.file_id);
            const character = await headless.importCharacter(buffer, name);
            this.store.updateChat(ctx.stateKey, {
                characterId: character.id,
                chatId: null,
                sessionId: null,
            });
            const verb = character.updated ? '已更新' : '已导入';
            console.log(`Character ${verb} from Telegram: chat=${ctx.chatId} id=${character.id} name=${character.name}`);
            await this.#sendMsg(ctx, `角色卡${verb}并选中：${character.name}（${character.id}）`);
            return;
        }

        if (isJson(name, document.mime_type)) {
            await this.#sendMsg(ctx, `已接收文件：${name}\n正在导入预设...`);
            const buffer = await this.telegram.downloadFile(document.file_id);
            const preset = await headless.importPreset(buffer, name, 'openai');
            this.store.updateChat(ctx.stateKey, {
                presetId: preset.id,
                sessionId: null,
            });
            const verb = preset.updated ? '已更新' : '已导入';
            console.log(`Preset ${verb} from Telegram: chat=${ctx.chatId} id=${preset.id} name=${preset.name}`);
            await this.#sendMsg(ctx, `预设${verb}并选中：${preset.name}（${preset.id}）`);
            return;
        }

        console.warn(`Unsupported Telegram document: chat=${ctx.chatId} name=${name} mime=${document.mime_type || 'unknown'}`);
        await this.#sendMsg(ctx, '仅支持 PNG 角色卡和 JSON 预设文件。');
    }

    // ── conversation / generation ───────────────────────────────────

    async #handleConversation(ctx, text) {
        console.log(`Telegram conversation message: chat=${ctx.chatId} length=${text.length}`);
        const headless = this.#getHeadless(ctx.userId);
        const hadChat = Boolean(this.store.getChat(ctx.stateKey).chatId);
        const state = await this.#prepareState(ctx, headless);
        const sessionId = await headless.ensureSession(state);
        this.store.updateChat(ctx.stateKey, { sessionId });

        if (!hadChat) {
            await this.#sendGreeting(ctx, headless, state.chatId);
        }

        await this.#streamGeneration(ctx, headless, sessionId, text);
    }

    async #handleNewChat(ctx, headless) {
        const state = this.store.getChat(ctx.stateKey);
        this.store.updateChat(ctx.stateKey, { chatId: null, sessionId: null });

        if (state.characterId) {
            try {
                const character = await headless.get(`/characters/${state.characterId}`);
                const firstMes = character.first_mes || character.data?.first_mes;
                if (firstMes) {
                    const chat = await headless.post('/chats', {
                        characterId: state.characterId,
                        title: `telegram-${ctx.stateKey}`,
                    });
                    this.store.updateChat(ctx.stateKey, { chatId: chat.id });
                    await this.#sendMsg(ctx, '新对话已开始。');
                    await this.#sendGreeting(ctx, headless, chat.id);
                    return;
                }
            } catch {
                // Fall through to simple message
            }
        }

        await this.#sendMsg(ctx, '下一条消息将开始新对话。');
    }

    async #handleRetry(ctx, headless) {
        const state = this.store.getChat(ctx.stateKey);
        if (!state.chatId || !state.sessionId) {
            await this.#sendMsg(ctx, '当前没有进行中的对话，无法重新生成。');
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
                await this.#sendMsg(ctx, '重新生成请求已提交。');
                return;
            }

            await this.#streamFromEvents(ctx, headless, eventsUrl);
        } catch (error) {
            await this.#sendSafe(ctx, formatTelegramError(error));
        }
    }

    async #sendGreeting(ctx, headless, hChatId) {
        try {
            const chatData = await headless.get(`/chats/${hChatId}`);
            const greeting = chatData.messages?.[0];
            if (greeting && !greeting.is_user && greeting.mes) {
                await this.#sendSafe(ctx, greeting.mes);
            }
        } catch {
            // Non-fatal
        }
    }

    async #streamGeneration(ctx, headless, sessionId, text) {
        let msgId = null;
        let currentText = '';
        let fullText = '';
        let lastEditAt = 0;
        const stopTyping = this.#startTypingLoop(ctx);

        try {
            const initial = await this.#sendMsg(ctx, CURSOR);
            msgId = initial.message_id;

            console.log(`Generation started: chat=${ctx.chatId} session=${sessionId}`);

            for await (const event of headless.generateStream(sessionId, text)) {
                if (event.type === 'error') {
                    throw new Error(event.message);
                }
                if (event.type !== 'token') continue;

                fullText += event.token;
                currentText += event.token;

                if (currentText.length > STREAM_SPLIT_THRESHOLD) {
                    await this.#editSafe(ctx.chatId, msgId, currentText);
                    currentText = '';
                    const next = await this.#sendMsg(ctx, CURSOR);
                    msgId = next.message_id;
                    lastEditAt = Date.now();
                    continue;
                }

                const now = Date.now();
                if (now - lastEditAt >= STREAM_EDIT_DEBOUNCE_MS) {
                    await this.#editSafe(ctx.chatId, msgId, currentText + CURSOR);
                    lastEditAt = now;
                }
            }

            if (currentText) {
                await this.#editSafe(ctx.chatId, msgId, currentText);
            } else if (!fullText) {
                await this.#editSafe(ctx.chatId, msgId, '模型未返回任何内容。');
            }

            if (fullText) {
                console.log(`Generation completed: chat=${ctx.chatId} session=${sessionId} chars=${fullText.length}`);
            } else {
                console.warn(`Generation completed without content: chat=${ctx.chatId} session=${sessionId}`);
            }
        } catch (error) {
            console.error(`Generation failed: chat=${ctx.chatId}`, error);
            const errorText = formatTelegramError(error);
            if (msgId) {
                await this.#editSafe(ctx.chatId, msgId, errorText);
            } else {
                await this.#sendSafe(ctx, errorText);
            }
        } finally {
            stopTyping();
        }
    }

    async #streamFromEvents(ctx, headless, eventsUrl) {
        let msgId = null;
        let currentText = '';
        let fullText = '';
        let lastEditAt = 0;
        const stopTyping = this.#startTypingLoop(ctx);

        try {
            const initial = await this.#sendMsg(ctx, CURSOR);
            msgId = initial.message_id;

            for await (const event of headless.streamEvents(eventsUrl)) {
                if (event.type === 'error') {
                    throw new Error(event.message);
                }
                if (event.type !== 'token') continue;

                fullText += event.token;
                currentText += event.token;

                if (currentText.length > STREAM_SPLIT_THRESHOLD) {
                    await this.#editSafe(ctx.chatId, msgId, currentText);
                    currentText = '';
                    const next = await this.#sendMsg(ctx, CURSOR);
                    msgId = next.message_id;
                    lastEditAt = Date.now();
                    continue;
                }

                const now = Date.now();
                if (now - lastEditAt >= STREAM_EDIT_DEBOUNCE_MS) {
                    await this.#editSafe(ctx.chatId, msgId, currentText + CURSOR);
                    lastEditAt = now;
                }
            }

            if (currentText) {
                await this.#editSafe(ctx.chatId, msgId, currentText);
            } else if (!fullText) {
                await this.#editSafe(ctx.chatId, msgId, '模型未返回任何内容。');
            }
        } catch (error) {
            console.error(`Retry generation failed: chat=${ctx.chatId}`, error);
            const errorText = formatTelegramError(error);
            if (msgId) {
                await this.#editSafe(ctx.chatId, msgId, errorText);
            } else {
                await this.#sendSafe(ctx, errorText);
            }
        } finally {
            stopTyping();
        }
    }

    // ── state helpers ───────────────────────────────────────────────

    async #ensureDefaultPreset(ctx) {
        const state = this.store.getChat(ctx.stateKey);
        if (state.presetId) return;

        const headless = this.#getHeadless(ctx.userId);
        const presets = await headless.get('/presets?apiId=openai');
        if (presets.length > 0) {
            this.store.updateChat(ctx.stateKey, { presetId: presets[0].id });
        }
    }

    async #prepareState(ctx, headless) {
        const state = this.store.getChat(ctx.stateKey);

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
                title: `telegram-${ctx.stateKey}`,
            });
            state.chatId = chat.id;
        }

        this.store.updateChat(ctx.stateKey, state);
        return state;
    }

    // ── model / character / preset ──────────────────────────────────

    async #setModel(ctx, headless, text) {
        const profile = parseSetModel(text);
        if (!profile) {
            await this.#sendMsg(ctx, '格式：/setmodel 名称 BaseURL APIKey 模型名');
            return;
        }

        const created = await headless.post('/model-profiles', {
            name: profile.name,
            provider: 'openai',
            baseUrl: profile.baseUrl,
            apiKey: profile.apiKey,
            model: profile.model,
        });
        this.store.updateChat(ctx.stateKey, { modelProfileId: created.id, sessionId: null });
        const verb = created.updated ? '已更新' : '已创建';
        console.log(`Model profile ${verb} from Telegram: chat=${ctx.chatId} id=${created.id} name=${created.name} model=${created.model}`);
        await this.#sendMsg(ctx, `模型配置${verb}并选中：${created.name}（${created.id}）`);
    }

    async #selectModel(ctx, headless, arg) {
        const items = await headless.get('/model-profiles');
        const selected = resolveSelection(items, arg);
        if (!selected) {
            await this.#sendMsg(ctx, `未找到模型配置：${arg}\n使用 /model 查看可用列表。`);
            return;
        }

        this.store.updateChat(ctx.stateKey, { modelProfileId: selected.id, sessionId: null });
        await this.#sendMsg(ctx, `已切换模型配置：${selected.name}（${selected.id}）`);
    }

    async #selectCharacter(ctx, headless, arg) {
        const items = await headless.get('/characters');
        const selected = resolveSelection(items, arg);
        if (!selected) {
            await this.#sendMsg(ctx, `未找到角色卡：${arg}\n使用 /character 查看可用列表。`);
            return;
        }

        this.store.updateChat(ctx.stateKey, { characterId: selected.id, chatId: null, sessionId: null });
        await this.#sendMsg(ctx, `已切换角色卡：${selected.name}（${selected.id}）`);
    }

    async #selectPreset(ctx, headless, arg) {
        const items = await headless.get('/presets?apiId=openai');
        const selected = resolveSelection(items, arg);
        if (!selected) {
            await this.#sendMsg(ctx, `未找到预设：${arg}\n使用 /preset 查看可用列表。`);
            return;
        }

        this.store.updateChat(ctx.stateKey, { presetId: selected.id, sessionId: null });
        await this.#sendMsg(ctx, `已切换预设：${selected.name}（${selected.id}）`);
    }

    async #sendModels(ctx, headless) {
        const state = this.store.getChat(ctx.stateKey);
        const items = await headless.get('/model-profiles?includeSecret=true');
        await this.#sendSafe(ctx, formatList(items, (item, index) => {
            const mark = item.id === state.modelProfileId ? ' [当前]' : '';
            return `${index + 1}. ${item.name} | ${item.model} | ${maskApiKey(item.apiKey)}${mark}`;
        }));
    }

    async #sendCharacters(ctx, headless) {
        const state = this.store.getChat(ctx.stateKey);
        const items = await headless.get('/characters');
        await this.#sendSafe(ctx, formatList(items, (item, index) => {
            const mark = item.id === state.characterId ? ' [当前]' : '';
            return `${index + 1}. ${item.name}${mark}`;
        }));
    }

    async #sendPresets(ctx, headless) {
        const state = this.store.getChat(ctx.stateKey);
        const items = await headless.get('/presets?apiId=openai');
        await this.#sendSafe(ctx, formatList(items, (item, index) => {
            const mark = item.id === state.presetId ? ' [当前]' : '';
            return `${index + 1}. ${item.name}${mark}`;
        }));
    }

    async #sendStatus(ctx, headless) {
        const state = this.store.getChat(ctx.stateKey);
        const lines = ['当前配置状态', ''];

        if (ctx.threadId != null) {
            lines.push(`线程：#${ctx.threadId}`);
        }

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

        await this.#sendMsg(ctx, lines.join('\n'));
    }
}
