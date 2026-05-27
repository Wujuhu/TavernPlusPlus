import crypto from 'node:crypto';

import { CHAT_COMPLETION_SOURCES } from '../constants.js';
import {
    appendChatMessage,
    readCharacter,
    readChat,
    readModelProfile,
    readPreset,
    readWorldbook,
    removeLastAssistantMessage,
} from './storage.js';
import { compilePrompt } from './prompt.js';
import {
    createChatCompletionGenerationData,
    createOpenAiCompatibleRequestBody,
    normalizeChatCompletionSettings,
} from './st-pipeline/chat-completion-parameters.js';
import { createStreamingReplyState, getStreamingReply } from './st-pipeline/chat-completion-reply.js';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isAbortError(error) {
    return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function getLastUserContent(messages) {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].role === 'user') {
            return messages[index].content || '';
        }
    }

    return '';
}

function splitTokens(text) {
    return String(text).match(/\S+\s*/g) || [];
}

function summarizeBackendError(status, text) {
    const body = String(text || '').trim();
    if (!body) {
        return `OpenAI-compatible backend returned ${status}.`;
    }

    try {
        const data = JSON.parse(body);
        const message = data?.error?.message || data?.message || data?.error;
        if (message) {
            return `OpenAI-compatible backend returned ${status}: ${String(message).slice(0, 1000)}`;
        }
    } catch {
        // Fall back to plain text or HTML title extraction.
    }

    const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    if (title) {
        return `OpenAI-compatible backend returned ${status}: HTML error page: ${title.replace(/\s+/g, ' ').trim().slice(0, 300)}`;
    }

    return `OpenAI-compatible backend returned ${status}: ${body.replace(/\s+/g, ' ').slice(0, 1000)}`;
}

async function mockGenerate({ messages, signal, options, onToken, config }) {
    const responseText = options?.mockResponse || `Mock response: ${getLastUserContent(messages)}`;
    const delayMs = Number(options?.mockDelayMs ?? config.mockDelayMs ?? 0);

    for (const token of splitTokens(responseText)) {
        if (signal.aborted) {
            throw new DOMException('Generation was aborted.', 'AbortError');
        }
        if (delayMs > 0) {
            await sleep(delayMs);
        }
        onToken(token);
    }

    return responseText;
}

async function openAiGenerate({ messages, signal, options, onToken, config }) {
    if (!config.openAiBaseUrl || !config.openAiApiKey) {
        throw new Error('openAiBaseUrl and openAiApiKey are required for the openai provider.');
    }

    const fetchFn = config.fetchImpl || globalThis.fetch;
    const baseUrl = config.openAiBaseUrl.replace(/\/+$/, '');
    const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
    const model = options?.model || config.openAiModel;
    const settings = normalizeChatCompletionSettings({
        chat_completion_source: config.chatCompletionSource || CHAT_COMPLETION_SOURCES.CUSTOM,
        ...options,
    });
    const { generateData } = createChatCompletionGenerationData({
        settings,
        model,
        type: options?.type || 'normal',
        messages,
        userName: options?.userName || config.userName || 'User',
        charName: options?.charName || config.charName || 'Assistant',
        groupNames: options?.groupNames || [],
    });
    const requestBody = createOpenAiCompatibleRequestBody(generateData, options?.parameters);
    const chatCompletionSource = settings.chat_completion_source;
    const showThoughts = Boolean(settings.show_thoughts);
    const replyState = createStreamingReplyState();
    const response = await fetchFn(url, {
        method: 'POST',
        signal,
        headers: {
            'Authorization': `Bearer ${config.openAiApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        throw new Error(summarizeBackendError(response.status, await response.text()));
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
        throw new Error(summarizeBackendError(response.status, await response.text()));
    }

    if (contentType.includes('application/json')) {
        const data = await response.json();
        const content = getStreamingReply(data, replyState, {
            chatCompletionSource,
            overrideShowThoughts: showThoughts,
        });
        if (!content) {
            throw new Error('OpenAI-compatible backend returned 200 but no message content.');
        }
        onToken(content);
        return content;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let sawEventData = false;

    while (true) {
        const { value, done } = await reader.read();
        if (done) {
            break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data:')) {
                continue;
            }

            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') {
                continue;
            }

            sawEventData = true;
            const parsed = JSON.parse(data);
            const token = getStreamingReply(parsed, replyState, {
                chatCompletionSource,
                overrideShowThoughts: showThoughts,
            });
            if (token) {
                fullText += token;
                onToken(token);
            }
        }
    }

    if (!fullText && !sawEventData) {
        throw new Error(`OpenAI-compatible backend returned ${response.status} but did not send SSE data.`);
    }

    return fullText;
}

export function createGenerationProvider(config) {
    return request => {
        const profile = request.modelProfile || {};
        const effectiveProvider = profile.provider
            || (profile.baseUrl ? 'openai' : null)
            || config.provider;
        const runtimeConfig = {
            ...config,
            provider: effectiveProvider,
            openAiBaseUrl: profile.baseUrl || config.openAiBaseUrl,
            openAiApiKey: profile.apiKey || config.openAiApiKey,
            openAiModel: profile.model || config.openAiModel,
            fetchImpl: config.fetchImpl,
        };

        if (runtimeConfig.provider === 'openai') {
            return openAiGenerate({ ...request, config: runtimeConfig });
        }

        return mockGenerate({ ...request, config: runtimeConfig });
    };
}

export class SessionStore {
    #sessions = new Map();

    create(input) {
        const session = {
            id: input.id || crypto.randomUUID(),
            userHandle: input.userHandle || null,
            characterId: input.characterId,
            chatId: input.chatId,
            presetId: input.presetId || null,
            modelProfileId: input.modelProfileId || null,
            worldbookIds: Array.isArray(input.worldbookIds) ? input.worldbookIds : [],
            personaDescription: input.personaDescription || '',
            worldInfoSettings: input.worldInfoSettings || {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        this.#sessions.set(session.id, session);
        return session;
    }

    get(id) {
        return this.#sessions.get(id);
    }

    list() {
        return [...this.#sessions.values()];
    }

    update(id, input) {
        const session = this.#sessions.get(id);
        if (!session) {
            return null;
        }

        if ('userHandle' in input) session.userHandle = input.userHandle || null;
        if ('characterId' in input) session.characterId = input.characterId;
        if ('chatId' in input) session.chatId = input.chatId;
        if ('presetId' in input) session.presetId = input.presetId;
        if ('modelProfileId' in input) session.modelProfileId = input.modelProfileId;
        if ('worldbookIds' in input) session.worldbookIds = Array.isArray(input.worldbookIds) ? input.worldbookIds : [];
        if ('personaDescription' in input) session.personaDescription = input.personaDescription;
        if ('worldInfoSettings' in input) session.worldInfoSettings = input.worldInfoSettings || {};
        session.updatedAt = new Date().toISOString();
        this.#sessions.set(id, session);
        return session;
    }
}

export class GenerationManager {
    #tasks = new Map();

    constructor({ context, resolveContext, provider }) {
        this.resolveContext = resolveContext || (() => context);
        this.provider = provider;
    }

    list() {
        return [...this.#tasks.values()].map(task => this.#toPublicTask(task));
    }

    get(id) {
        return this.#tasks.get(id);
    }

    start(session, input = {}) {
        const task = {
            id: crypto.randomUUID(),
            session,
            mode: input.mode || 'new',
            input: input.input || '',
            savePartial: input.savePartial !== false,
            options: input.options || {},
            controller: new AbortController(),
            status: 'running',
            content: '',
            events: [],
            listeners: new Set(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        this.#tasks.set(task.id, task);
        this.#emit(task, 'meta', this.#toPublicTask(task));
        Promise.resolve().then(() => this.#run(task));
        return this.#toPublicTask(task);
    }

    stop(id, input = {}) {
        const task = this.#tasks.get(id);
        if (!task) {
            return null;
        }

        if (typeof input.savePartial === 'boolean') {
            task.savePartial = input.savePartial;
        }

        if (task.status === 'running') {
            task.status = 'stopping';
            task.controller.abort();
        }

        return this.#toPublicTask(task);
    }

    subscribe(id, response) {
        const task = this.#tasks.get(id);
        if (!task) {
            response.sendStatus(404);
            return;
        }

        response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        response.setHeader('Cache-Control', 'no-cache, no-transform');
        response.setHeader('Connection', 'keep-alive');
        response.flushHeaders?.();

        const writeEvent = event => {
            response.write(`event: ${event.event}\n`);
            response.write(`data: ${JSON.stringify(event.data)}\n\n`);
            if (event.event === 'done') {
                response.end();
            }
        };

        for (const event of task.events) {
            writeEvent(event);
        }

        if (['done', 'error', 'stopped'].includes(task.status)) {
            response.end();
            return;
        }

        task.listeners.add(writeEvent);
        response.on('close', () => task.listeners.delete(writeEvent));
    }

    async #run(task) {
        try {
            const context = await this.resolveContext(task.session.userHandle);

            if (task.mode === 'regenerate') {
                await removeLastAssistantMessage(context, task.session.chatId);
            }

            if (task.input && task.mode !== 'continue') {
                await appendChatMessage(context, task.session.chatId, {
                    name: 'User',
                    is_user: true,
                    mes: task.input,
                });
            }

            const chat = await readChat(context, task.session.chatId);
            const character = await readCharacter(context, task.session.characterId || chat.characterId);
            const preset = task.session.presetId ? await readPreset(context, task.session.presetId) : null;
            const modelProfile = task.session.modelProfileId ? await readModelProfile(context, task.session.modelProfileId, { includeSecret: true }) : null;
            const worldbooks = [];

            for (const worldbookId of task.session.worldbookIds) {
                worldbooks.push(await readWorldbook(context, worldbookId));
            }

            const presetObj = preset?.preset || preset || {};
            const mergedParams = {
                ...(modelProfile?.parameters || {}),
                ...(presetObj || {}),
                ...task.options,
            };
            const maxContext = Number(mergedParams.openai_max_context || mergedParams.max_context || 8192);
            const maxResponse = Number(mergedParams.openai_max_tokens || mergedParams.max_tokens || 1024);
            const modelName = modelProfile?.model || mergedParams.model || '';

            const prompt = compilePrompt({
                character,
                chat,
                worldbooks,
                preset,
                input: task.input,
                maxContext,
                maxResponse,
                model: modelName,
                personaDescription: task.session.personaDescription || '',
                worldInfoSettings: task.session.worldInfoSettings || {},
                generationType: task.mode === 'continue' ? 'continue' : task.mode === 'regenerate' ? 'regenerate' : 'normal',
            });
            const options = {
                ...mergedParams,
                ...task.options,
                userName: chat.header?.user_name || 'User',
                charName: character.name || 'Assistant',
            };

            this.#emit(task, 'meta', {
                ...this.#toPublicTask(task),
                selectedWorldInfo: prompt.selectedWorldInfo,
                presetId: task.session.presetId,
                modelProfileId: task.session.modelProfileId,
            });

            const result = await this.provider({
                messages: prompt.messages,
                signal: task.controller.signal,
                options,
                modelProfile,
                onToken: token => {
                    task.content += token;
                    this.#emit(task, 'token', { token });
                },
            });

            const finalText = task.content || result || '';
            if (finalText) {
                const assistant = await appendChatMessage(context, task.session.chatId, {
                    name: character.name || 'Assistant',
                    is_user: false,
                    mes: finalText,
                });
                this.#emit(task, 'message', assistant);
            }

            task.status = 'done';
            this.#emit(task, 'done', this.#toPublicTask(task));
        } catch (error) {
            if (isAbortError(error)) {
                if (task.savePartial && task.content) {
                    const context = await this.resolveContext(task.session.userHandle);
                    const chat = await readChat(context, task.session.chatId);
                    const character = await readCharacter(context, task.session.characterId || chat.characterId);
                    const assistant = await appendChatMessage(context, task.session.chatId, {
                        name: character.name || 'Assistant',
                        is_user: false,
                        mes: task.content,
                    });
                    this.#emit(task, 'message', assistant);
                }

                task.status = 'stopped';
                this.#emit(task, 'done', this.#toPublicTask(task));
                return;
            }

            task.status = 'error';
            this.#emit(task, 'error', { message: error.message || String(error) });
            this.#emit(task, 'done', this.#toPublicTask(task));
        }
    }

    #emit(task, event, data) {
        task.updatedAt = new Date().toISOString();
        const payload = { event, data };
        task.events.push(payload);

        for (const listener of task.listeners) {
            listener(payload);
        }
    }

    #toPublicTask(task) {
        return {
            id: task.id,
            sessionId: task.session.id,
            chatId: task.session.chatId,
            characterId: task.session.characterId,
            presetId: task.session.presetId,
            modelProfileId: task.session.modelProfileId,
            mode: task.mode,
            status: task.status,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
        };
    }
}
