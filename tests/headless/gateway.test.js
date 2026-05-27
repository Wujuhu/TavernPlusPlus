import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { createHeadlessApp } from '../../src/headless/app.js';
import { HeadlessClient } from '../../src/gateway/headless-client.js';
import { JsonStateStore } from '../../src/gateway/store.js';
import { TelegramGateway } from '../../src/gateway/telegram-gateway.js';

const TEST_TOKEN = 'gateway-token';

class FakeTelegram {
    constructor(files = {}) {
        this.files = files;
        this.messages = [];
        this.edits = [];
        this.commands = [];
    }

    async getUpdates() {
        return new Promise(() => {});
    }

    async setMyCommands(commands) {
        this.commands = commands;
        return true;
    }

    async sendChatAction(_chatId, _action, _extra = {}) {
        return true;
    }

    async sendMessage(chatId, text, extra = {}) {
        this.messages.push({ chatId, text, threadId: extra.message_thread_id ?? null });
        return { message_id: this.messages.length };
    }

    async editMessageText(chatId, messageId, text) {
        this.edits.push({ chatId, messageId, text });
        return true;
    }

    async downloadFile(fileId) {
        return this.files[fileId];
    }
}

async function testProvider({ options, onToken }) {
    const response = options?.mockResponse || 'gateway fallback';
    onToken(response);
    return response;
}

async function withGateway(fn, providerAdapter = testProvider) {
    const dataRoot = path.resolve('.tmp-headless-tests', crypto.randomUUID());
    const created = await createHeadlessApp({
        token: TEST_TOKEN,
        dataRoot,
        providerAdapter,
    });
    const server = created.app.listen(0, '127.0.0.1');

    await new Promise(resolve => server.once('listening', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/api/headless/v1`;
    const telegram = new FakeTelegram();
    const store = new JsonStateStore(path.join(dataRoot, 'gateway', 'telegram-state.json'));
    await store.load();
    const gateway = await TelegramGateway.create({
        enabled: true,
        token: 'fake-telegram-token',
        dataRoot,
        statePath: store.filePath,
        headlessBaseUrl: baseUrl,
        headlessToken: TEST_TOKEN,
    }, {
        telegram,
        store,
        headless: new HeadlessClient({ baseUrl, token: TEST_TOKEN }),
    });

    try {
        await fn({ baseUrl, dataRoot, gateway, telegram, store });
    } finally {
        await new Promise(resolve => server.close(resolve));
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
}

async function requestJson(baseUrl, method, route, body = undefined) {
    const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: {
            Authorization: `Bearer ${TEST_TOKEN}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    return response.json();
}

function messageUpdate(chatId, body, threadId = undefined) {
    return {
        update_id: Date.now(),
        message: {
            message_id: Date.now(),
            from: { id: chatId },
            chat: { id: chatId },
            ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
            ...body,
        },
    };
}

test('Telegram gateway imports files, guides photo uploads, saves model profiles, switches config, and chats', async () => {
    await withGateway(async ({ baseUrl, dataRoot, gateway, telegram, store }) => {
        await gateway.start();
        gateway.stop();
        assert.deepEqual(telegram.commands.map(item => item.command), [
            'start',
            'status',
            'setmodel',
            'model',
            'character',
            'preset',
            'newchat',
            'retry',
        ]);

        const createdCharacter = await requestJson(baseUrl, 'POST', '/characters', {
            name: 'Gateway Ava',
            description: 'Gateway test character.',
        });
        const cardBuffer = await fs.promises.readFile(path.join(dataRoot, 'default-user', 'characters', `${createdCharacter.id}.png`));
        telegram.files.card = cardBuffer;
        telegram.files.preset = Buffer.from(JSON.stringify({ temperature: 0.2 }));

        await gateway.handleUpdate(messageUpdate(1001, {
            photo: [{ file_id: 'compressed-photo' }],
        }));
        assert.match(telegram.messages.at(-1).text, /而非文件/);

        await gateway.handleUpdate(messageUpdate(1001, {
            document: {
                file_id: 'card',
                file_name: 'gateway-ava.png',
                mime_type: 'image/png',
            },
        }));
        assert.match(telegram.messages.at(-1).text, /角色卡已更新并选中/);
        assert.ok(store.getChat(1001).characterId);
        const importedCharacterId = store.getChat(1001).characterId;

        await gateway.handleUpdate(messageUpdate(1001, {
            document: {
                file_id: 'card',
                file_name: 'gateway-ava.png',
                mime_type: 'image/png',
            },
        }));
        assert.match(telegram.messages.at(-1).text, /角色卡已更新并选中/);

        await gateway.handleUpdate(messageUpdate(1001, {
            text: '/character',
        }));
        assert.match(telegram.messages.at(-1).text, /1\./);
        assert.equal(store.getChat(1001).characterId, importedCharacterId);

        await gateway.handleUpdate(messageUpdate(1001, {
            document: {
                file_id: 'preset',
                file_name: 'telegram-preset.json',
                mime_type: 'application/json',
            },
        }));
        assert.match(telegram.messages.at(-1).text, /预设已导入并选中/);
        assert.equal(store.getChat(1001).presetId, 'openai:telegram-preset');
        const importedPresetId = store.getChat(1001).presetId;

        await gateway.handleUpdate(messageUpdate(1001, {
            document: {
                file_id: 'preset',
                file_name: 'telegram-preset.json',
                mime_type: 'application/json',
            },
        }));
        assert.match(telegram.messages.at(-1).text, /预设已更新并选中/);

        await gateway.handleUpdate(messageUpdate(1001, {
            text: '/preset',
        }));
        assert.match(telegram.messages.at(-1).text, /1\./);
        assert.equal(store.getChat(1001).presetId, importedPresetId);

        await gateway.handleUpdate(messageUpdate(1001, {
            text: '/setmodel main http://example.invalid/v1 sk-test gpt-test',
        }));
        assert.match(telegram.messages.at(-1).text, /模型配置已创建并选中/);
        const openAiProfileId = store.getChat(1001).modelProfileId;
        assert.ok(openAiProfileId);

        await gateway.handleUpdate(messageUpdate(1001, {
            text: '/setmodel main http://example.invalid/v1 sk-new gpt-test-2',
        }));
        assert.match(telegram.messages.at(-1).text, /模型配置已更新并选中/);
        assert.equal(store.getChat(1001).modelProfileId, openAiProfileId, 'Same model profile ID after upsert');

        await gateway.handleUpdate(messageUpdate(1001, {
            text: '/model',
        }));
        const modelListMsg = telegram.messages.at(-1).text;
        assert.match(modelListMsg, /1\./);
        assert.match(modelListMsg, /\[当前\]/);
        assert.equal(store.getChat(1001).modelProfileId, openAiProfileId);

        const mockProfile = await requestJson(baseUrl, 'POST', '/model-profiles', {
            name: 'mock-main',
            provider: 'mock',
            model: 'mock',
            parameters: { mockResponse: 'gateway answer' },
        });
        await gateway.handleUpdate(messageUpdate(1001, {
            text: `/model ${mockProfile.id}`,
        }));
        assert.equal(store.getChat(1001).modelProfileId, mockProfile.id);

        await gateway.handleUpdate(messageUpdate(1001, {
            text: '/character 1',
        }));
        assert.ok(store.getChat(1001).characterId);
        assert.notEqual(store.getChat(1001).characterId, 'undefined');

        telegram.edits = [];
        await gateway.handleUpdate(messageUpdate(1001, {
            text: 'hello from telegram',
        }));

        const lastEdit = telegram.edits.at(-1);
        assert.ok(lastEdit, 'Expected at least one edit for streaming response');
        assert.equal(lastEdit.text, 'gateway answer');

        const state = store.getChat(1001);
        assert.ok(state.chatId);
        assert.ok(state.sessionId);
        const chat = await requestJson(baseUrl, 'GET', `/chats/${state.chatId}`);
        assert.equal(chat.messages.at(-1).mes, 'gateway answer');
    });
});

test('Telegram gateway reports generation backend errors to the chat', async () => {
    await withGateway(async ({ baseUrl, gateway, telegram }) => {
        await requestJson(baseUrl, 'POST', '/characters', {
            name: 'Error Ava',
            description: 'Gateway error test character.',
        });

        await gateway.handleUpdate(messageUpdate(2002, {
            text: 'hello from telegram',
        }));

        const lastEdit = telegram.edits.at(-1);
        assert.ok(lastEdit, 'Expected error to be shown via edit');
        assert.match(lastEdit.text, /操作失败：backend exploded/);
    }, async () => {
        throw new Error('backend exploded');
    });
});

test('Telegram gateway rejects users not in the whitelist', async () => {
    await withGateway(async ({ gateway, telegram }) => {
        gateway.config.allowedUserIds = [9999];

        await gateway.handleUpdate(messageUpdate(1234, {
            text: 'hello',
        }));

        assert.match(telegram.messages.at(-1).text, /访问被拒绝/);
    });
});

test('model-profiles API supports includeSecret query param', async () => {
    await withGateway(async ({ baseUrl }) => {
        await requestJson(baseUrl, 'POST', '/model-profiles', {
            name: 'secret-test',
            provider: 'openai',
            apiKey: 'sk-secret-12345678',
            model: 'gpt-4o',
        });

        const withoutSecret = await requestJson(baseUrl, 'GET', '/model-profiles');
        assert.equal(withoutSecret[0].apiKey, undefined);
        assert.equal(withoutSecret[0].hasApiKey, true);

        const withSecret = await requestJson(baseUrl, 'GET', '/model-profiles?includeSecret=true');
        assert.equal(withSecret[0].apiKey, 'sk-secret-12345678');
    });
});

test('createModelProfile upserts by name instead of creating duplicates', async () => {
    await withGateway(async ({ baseUrl }) => {
        const first = await requestJson(baseUrl, 'POST', '/model-profiles', {
            name: 'upsert-test',
            provider: 'openai',
            model: 'gpt-4o',
            apiKey: 'key-1',
        });
        assert.equal(first.updated, false);

        const second = await requestJson(baseUrl, 'POST', '/model-profiles', {
            name: 'upsert-test',
            provider: 'openai',
            model: 'gpt-4o-mini',
            apiKey: 'key-2',
        });
        assert.equal(second.updated, true);
        assert.equal(second.id, first.id, 'Same ID after upsert');
        assert.equal(second.model, 'gpt-4o-mini');

        const all = await requestJson(baseUrl, 'GET', '/model-profiles');
        assert.equal(all.length, 1, 'No duplicate profiles');
    });
});

test('messages with message_thread_id are routed to separate state and replies include threadId', async () => {
    await withGateway(async ({ baseUrl, gateway, telegram, store }) => {
        const mockProfile = await requestJson(baseUrl, 'POST', '/model-profiles', {
            name: 'thread-mock',
            provider: 'mock',
            model: 'mock',
            parameters: { mockResponse: 'thread reply' },
        });

        // Set model in thread 100
        await gateway.handleUpdate(messageUpdate(5001, { text: `/model ${mockProfile.id}` }, 100));
        assert.match(telegram.messages.at(-1).text, /已切换模型配置/);
        assert.equal(telegram.messages.at(-1).threadId, 100, 'Reply should include thread 100');

        // Thread 100 state has the model
        const t100State = store.getChat('5001_t100');
        assert.equal(t100State.modelProfileId, mockProfile.id);

        // Default state (no thread) should be empty
        const defaultState = store.getChat('5001');
        assert.equal(defaultState.modelProfileId, undefined);

        // Set model in thread 200
        await gateway.handleUpdate(messageUpdate(5001, { text: `/model ${mockProfile.id}` }, 200));
        assert.equal(telegram.messages.at(-1).threadId, 200, 'Reply should include thread 200');
        const t200State = store.getChat('5001_t200');
        assert.equal(t200State.modelProfileId, mockProfile.id);

        // Thread 100 and 200 states are independent
        assert.notEqual(
            store.getChat('5001_t100').updatedAt,
            store.getChat('5001_t200').updatedAt,
            'Thread states should be independent store entries',
        );

        // Messages without threadId go to default state
        await gateway.handleUpdate(messageUpdate(5001, { text: `/model ${mockProfile.id}` }));
        assert.equal(telegram.messages.at(-1).threadId, null, 'No threadId for default');
        assert.equal(store.getChat('5001').modelProfileId, mockProfile.id);
    });
});

test('conversation in a thread uses isolated chat history', async () => {
    await withGateway(async ({ baseUrl, gateway, telegram, store }) => {
        await requestJson(baseUrl, 'POST', '/characters', {
            name: 'Thread Char',
            description: 'Thread test.',
        });

        const mockProfile = await requestJson(baseUrl, 'POST', '/model-profiles', {
            name: 'thread-conv-mock',
            provider: 'mock',
            model: 'mock',
            parameters: { mockResponse: 'hello from thread' },
        });

        // Configure thread 42
        await gateway.handleUpdate(messageUpdate(6001, { text: `/model ${mockProfile.id}` }, 42));
        await gateway.handleUpdate(messageUpdate(6001, { text: '/character 1' }, 42));

        // Chat in thread 42
        telegram.edits = [];
        await gateway.handleUpdate(messageUpdate(6001, { text: 'hi thread 42' }, 42));
        assert.ok(telegram.edits.length > 0, 'Should have streaming edits');
        assert.equal(telegram.edits.at(-1).text, 'hello from thread');

        // Thread 42 has a chatId, default does not
        const t42State = store.getChat('6001_t42');
        assert.ok(t42State.chatId, 'Thread 42 should have a chatId');
        assert.ok(t42State.sessionId, 'Thread 42 should have a sessionId');

        const defaultState = store.getChat('6001');
        assert.equal(defaultState.chatId, undefined, 'Default thread should have no chatId');
    });
});
