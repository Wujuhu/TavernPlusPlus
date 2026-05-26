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
        this.commands = [];
    }

    async getUpdates() {
        return new Promise(() => {});
    }

    async setMyCommands(commands) {
        this.commands = commands;
        return true;
    }

    async sendMessage(chatId, text) {
        this.messages.push({ chatId, text });
        return { message_id: this.messages.length };
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

function messageUpdate(chatId, body) {
    return {
        update_id: Date.now(),
        message: {
            message_id: Date.now(),
            chat: { id: chatId },
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
            'help',
            'status',
            'setmodel',
            'models',
            'model',
            'characters',
            'character',
            'presets',
            'preset',
            'newchat',
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
        assert.match(telegram.messages.at(-1).text, /not as a file/);

        await gateway.handleUpdate(messageUpdate(1001, {
            document: {
                file_id: 'card',
                file_name: 'gateway-ava.png',
                mime_type: 'image/png',
            },
        }));
        assert.match(telegram.messages.at(-1).text, /Character card imported and selected/);
        assert.ok(store.getChat(1001).characterId);
        const importedCharacterId = store.getChat(1001).characterId;

        await gateway.handleUpdate(messageUpdate(1001, {
            text: '/character',
        }));
        assert.match(telegram.messages.at(-1).text, /Usage: \/character ID or \/character number/);
        assert.equal(store.getChat(1001).characterId, importedCharacterId);

        await gateway.handleUpdate(messageUpdate(1001, {
            document: {
                file_id: 'preset',
                file_name: 'telegram-preset.json',
                mime_type: 'application/json',
            },
        }));
        assert.match(telegram.messages.at(-1).text, /Preset imported and selected/);
        assert.equal(store.getChat(1001).presetId, 'openai:telegram-preset');
        const importedPresetId = store.getChat(1001).presetId;

        await gateway.handleUpdate(messageUpdate(1001, {
            text: '/preset',
        }));
        assert.match(telegram.messages.at(-1).text, /Usage: \/preset ID or \/preset number/);
        assert.equal(store.getChat(1001).presetId, importedPresetId);

        await gateway.handleUpdate(messageUpdate(1001, {
            text: '/setmodel main http://example.invalid/v1 sk-test gpt-test',
        }));
        assert.match(telegram.messages.at(-1).text, /Model profile saved and selected/);
        const openAiProfileId = store.getChat(1001).modelProfileId;
        assert.ok(openAiProfileId);

        await gateway.handleUpdate(messageUpdate(1001, {
            text: '/model',
        }));
        assert.match(telegram.messages.at(-1).text, /Usage: \/model ID or \/model number/);
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

        await gateway.handleUpdate(messageUpdate(1001, {
            text: 'hello from telegram',
        }));
        assert.equal(telegram.messages.at(-1).text, 'gateway answer');

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

        assert.equal(telegram.messages.at(-2).text, 'Generating...');
        assert.match(telegram.messages.at(-1).text, /Operation failed: backend exploded/);
    }, async () => {
        throw new Error('backend exploded');
    });
});
