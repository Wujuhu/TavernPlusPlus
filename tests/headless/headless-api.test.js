import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

import { createHeadlessApp } from '../../src/headless/app.js';

const TEST_TOKEN = 'test-token';

function splitTokens(text) {
    return String(text).match(/\S+\s*/g) || [];
}

function abortError() {
    const error = new Error('Aborted');
    error.name = 'AbortError';
    return error;
}

async function testProvider({ messages, signal, options, onToken }) {
    const lastUser = [...messages].reverse().find(message => message.role === 'user')?.content || '';
    const response = options?.mockResponse || `Echo: ${lastUser}`;
    const delayMs = Number(options?.mockDelayMs || 0);

    for (const token of splitTokens(response)) {
        if (signal.aborted) {
            throw abortError();
        }
        if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        if (signal.aborted) {
            throw abortError();
        }
        onToken(token);
    }

    return response;
}

async function withServer(fn) {
    const dataRoot = path.resolve('.tmp-headless-tests', crypto.randomUUID());
    const created = await createHeadlessApp({
        token: TEST_TOKEN,
        dataRoot,
        providerAdapter: testProvider,
    });
    const server = created.app.listen(0, '127.0.0.1');

    await new Promise(resolve => server.once('listening', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/api/headless/v1`;

    try {
        await fn({ baseUrl, dataRoot });
    } finally {
        await new Promise(resolve => server.close(resolve));
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
}

async function requestJson(baseUrl, method, route, body = undefined, token = TEST_TOKEN) {
    const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    return { response, data };
}

async function uploadFile(baseUrl, route, { buffer, filename, fields = {} }) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
        form.set(key, String(value));
    }
    form.set('file', new Blob([buffer]), filename);

    const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        body: form,
    });
    const data = await response.json();
    return { response, data };
}

async function collectSse(baseUrl, route) {
    const origin = new URL(baseUrl).origin;
    const url = route.startsWith('/api/') ? `${origin}${route}` : `${baseUrl}${route}`;
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });

    assert.equal(response.status, 200);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    let buffer = '';

    while (true) {
        const { value, done } = await reader.read();
        if (done) {
            break;
        }

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';

        for (const block of blocks) {
            const event = block.match(/^event: (.+)$/m)?.[1];
            const data = block.match(/^data: (.+)$/m)?.[1];
            if (event && data) {
                events.push({ event, data: JSON.parse(data) });
            }
        }
    }

    return events;
}

test('headless API requires auth and supports chat generation controls', async () => {
    await withServer(async ({ baseUrl, dataRoot }) => {
        const unauthenticated = await requestJson(baseUrl, 'GET', '/health', undefined, '');
        assert.equal(unauthenticated.response.status, 401);

        const health = await requestJson(baseUrl, 'GET', '/health');
        assert.equal(health.response.status, 200);
        assert.equal(health.data.ok, true);
        assert.equal(health.data.dataRoot, dataRoot);

        const character = await requestJson(baseUrl, 'POST', '/characters', {
            name: 'Ava',
            description: 'A concise assistant.',
            first_mes: 'Hello.',
        });
        assert.equal(character.response.status, 201);
        assert.equal(character.data.name, 'Ava');

        const characters = await requestJson(baseUrl, 'GET', '/characters');
        assert.equal(characters.response.status, 200);
        assert.deepEqual(characters.data.map(item => item.id), [character.data.id]);

        const originalCard = await fs.promises.readFile(path.join(dataRoot, 'default-user', 'characters', `${character.data.id}.png`));
        const importedCharacter = await uploadFile(baseUrl, '/characters/import', {
            buffer: originalCard,
            filename: 'ava-copy.png',
        });
        assert.equal(importedCharacter.response.status, 201);
        assert.equal(importedCharacter.data.name, 'Ava');

        const worldbook = await requestJson(baseUrl, 'POST', '/worldbooks', {
            name: 'lore',
            entries: {
                moon: {
                    key: ['moon'],
                    content: 'The moon is a recurring symbol.',
                },
            },
        });
        assert.equal(worldbook.response.status, 201);

        const worldbooks = await requestJson(baseUrl, 'GET', '/worldbooks');
        assert.equal(worldbooks.response.status, 200);
        assert.deepEqual(worldbooks.data.map(item => item.id), [worldbook.data.id]);

        const preset = await requestJson(baseUrl, 'POST', '/presets', {
            apiId: 'openai',
            name: 'default',
            preset: { temperature: 0.7 },
        });
        assert.equal(preset.response.status, 201);

        const importedPreset = await uploadFile(baseUrl, '/presets/import', {
            buffer: Buffer.from(JSON.stringify({ mockResponse: 'preset answer' })),
            filename: 'telegram-preset.json',
            fields: { apiId: 'openai' },
        });
        assert.equal(importedPreset.response.status, 201);

        const presets = await requestJson(baseUrl, 'GET', '/presets?apiId=openai');
        assert.equal(presets.response.status, 200);
        assert.deepEqual(presets.data.map(item => item.id).sort(), [preset.data.id, importedPreset.data.id].sort());

        const modelProfile = await requestJson(baseUrl, 'POST', '/model-profiles', {
            name: 'mock-main',
            provider: 'mock',
            model: 'mock-model',
            apiKey: 'secret',
        });
        assert.equal(modelProfile.response.status, 201);
        assert.equal(modelProfile.data.hasApiKey, true);
        assert.equal(modelProfile.data.apiKey, undefined);

        const chat = await requestJson(baseUrl, 'POST', '/chats', {
            characterId: character.data.id,
            characterName: character.data.name,
            title: 'main',
        });
        assert.equal(chat.response.status, 201);

        const session = await requestJson(baseUrl, 'POST', '/sessions', {
            characterId: character.data.id,
            chatId: chat.data.id,
            worldbookIds: [worldbook.data.id],
            presetId: importedPreset.data.id,
            modelProfileId: modelProfile.data.id,
        });
        assert.equal(session.response.status, 201);

        const updatedSession = await requestJson(baseUrl, 'POST', `/sessions/${session.data.id}/config`, {
            characterId: character.data.id,
            chatId: chat.data.id,
            presetId: importedPreset.data.id,
            modelProfileId: modelProfile.data.id,
            worldbookIds: [worldbook.data.id],
        });
        assert.equal(updatedSession.response.status, 200);
        assert.equal(updatedSession.data.modelProfileId, modelProfile.data.id);

        const generation = await requestJson(baseUrl, 'POST', '/generate', {
            sessionId: session.data.id,
            input: 'Tell me about the moon.',
        });
        assert.equal(generation.response.status, 202);

        const events = await collectSse(baseUrl, generation.data.events);
        assert.deepEqual(events.map(event => event.event).filter(event => event === 'done'), ['done']);
        assert.equal(events.filter(event => event.event === 'token').map(event => event.data.token).join(''), 'preset answer');
        assert.ok(events.find(event => event.event === 'meta' && event.data.selectedWorldInfo)?.data.selectedWorldInfo.length > 0);

        const generatedChat = await requestJson(baseUrl, 'GET', `/chats/${chat.data.id}`);
        assert.equal(generatedChat.data.messages.length, 3);
        assert.equal(generatedChat.data.messages[0].mes, 'Hello.');
        assert.equal(generatedChat.data.messages[0].is_user, false);
        assert.equal(generatedChat.data.messages[1].mes, 'Tell me about the moon.');
        assert.equal(generatedChat.data.messages[2].mes, 'preset answer');
        assert.ok(generatedChat.data.messages[2].extra.headless.id);

        const regeneration = await requestJson(baseUrl, 'POST', `/chats/${chat.data.id}/regenerate`, {
            characterId: character.data.id,
            parameters: { mockResponse: 'better answer' },
        });
        assert.equal(regeneration.response.status, 202);
        await collectSse(baseUrl, regeneration.data.events);

        const regeneratedChat = await requestJson(baseUrl, 'GET', `/chats/${chat.data.id}`);
        assert.equal(regeneratedChat.data.messages.length, 3);
        assert.equal(regeneratedChat.data.messages[2].mes, 'better answer');

        const continuation = await requestJson(baseUrl, 'POST', `/chats/${chat.data.id}/continue`, {
            characterId: character.data.id,
            parameters: { mockResponse: ' continuing' },
        });
        assert.equal(continuation.response.status, 202);
        await collectSse(baseUrl, continuation.data.events);

        const continuedChat = await requestJson(baseUrl, 'GET', `/chats/${chat.data.id}`);
        assert.equal(continuedChat.data.messages.length, 4);
        assert.equal(continuedChat.data.messages[3].mes, 'continuing');
    });
});

test('stop can discard partial generation output', async () => {
    await withServer(async ({ baseUrl }) => {
        const character = await requestJson(baseUrl, 'POST', '/characters', { name: 'Slow' });
        const chat = await requestJson(baseUrl, 'POST', '/chats', {
            characterId: character.data.id,
            characterName: character.data.name,
            title: 'stop-test',
        });
        const session = await requestJson(baseUrl, 'POST', '/sessions', {
            characterId: character.data.id,
            chatId: chat.data.id,
        });

        const generation = await requestJson(baseUrl, 'POST', '/generate', {
            sessionId: session.data.id,
            input: 'Start slowly.',
            savePartial: false,
            parameters: {
                mockResponse: 'one two three four five six',
                mockDelayMs: 20,
            },
        });
        assert.equal(generation.response.status, 202);

        await new Promise(resolve => setTimeout(resolve, 35));
        const stopped = await requestJson(baseUrl, 'POST', `/generations/${generation.data.id}/stop`, { savePartial: false });
        assert.equal(stopped.response.status, 200);

        const events = await collectSse(baseUrl, generation.data.events);
        assert.equal(events.at(-1).event, 'done');
        assert.equal(events.at(-1).data.status, 'stopped');

        const stoppedChat = await requestJson(baseUrl, 'GET', `/chats/${chat.data.id}`);
        assert.equal(stoppedChat.data.messages.length, 1);
        assert.equal(stoppedChat.data.messages[0].is_user, true);
    });
});

test('OpenAI-compatible backend HTML errors are summarized in generation events', async () => {
    const dataRoot = path.resolve('.tmp-headless-tests', crypto.randomUUID());
    const backend = http.createServer((request, response) => {
        response.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(`<html><head><title>Blocked by provider</title></head><body>${'x'.repeat(10000)}</body></html>`);
    });

    await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
    const backendAddress = backend.address();
    const backendUrl = `http://127.0.0.1:${backendAddress.port}/v1`;

    const created = await createHeadlessApp({
        token: TEST_TOKEN,
        dataRoot,
        provider: 'openai',
        openAiBaseUrl: backendUrl,
        openAiApiKey: 'test-key',
        openAiModel: 'test-model',
    });
    const server = created.app.listen(0, '127.0.0.1');

    await new Promise(resolve => server.once('listening', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/api/headless/v1`;

    try {
        const character = await requestJson(baseUrl, 'POST', '/characters', { name: 'Backend Error' });
        const chat = await requestJson(baseUrl, 'POST', '/chats', {
            characterId: character.data.id,
            characterName: character.data.name,
            title: 'backend-error-test',
        });
        const session = await requestJson(baseUrl, 'POST', '/sessions', {
            characterId: character.data.id,
            chatId: chat.data.id,
        });

        const generation = await requestJson(baseUrl, 'POST', '/generate', {
            sessionId: session.data.id,
            input: 'hello',
        });
        const events = await collectSse(baseUrl, generation.data.events);
        const error = events.find(event => event.event === 'error');

        assert.equal(error.data.message, 'OpenAI-compatible backend returned 403: HTML error page: Blocked by provider');
        assert.ok(error.data.message.length < 120);
    } finally {
        await new Promise(resolve => server.close(resolve));
        await new Promise(resolve => backend.close(resolve));
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('OpenAI-compatible generation applies SillyTavern preset fields to the request body', async () => {
    const dataRoot = path.resolve('.tmp-headless-tests', crypto.randomUUID());
    let capturedBody = null;
    const backend = http.createServer((request, response) => {
        let rawBody = '';
        request.setEncoding('utf8');
        request.on('data', chunk => {
            rawBody += chunk;
        });
        request.on('end', () => {
            capturedBody = JSON.parse(rawBody);
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ choices: [{ message: { content: 'preset ok' } }] }));
        });
    });

    await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
    const backendAddress = backend.address();
    const backendUrl = `http://127.0.0.1:${backendAddress.port}/v1`;

    const created = await createHeadlessApp({
        token: TEST_TOKEN,
        dataRoot,
        provider: 'openai',
        openAiBaseUrl: backendUrl,
        openAiApiKey: 'test-key',
        openAiModel: 'test-model',
    });
    const server = created.app.listen(0, '127.0.0.1');

    await new Promise(resolve => server.once('listening', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/api/headless/v1`;

    try {
        const character = await requestJson(baseUrl, 'POST', '/characters', { name: 'Preset Request' });
        const preset = await requestJson(baseUrl, 'POST', '/presets', {
            apiId: 'openai',
            name: 'request-body',
            preset: {
                temperature: 0.42,
                frequency_penalty: 0.11,
                presence_penalty: 0.22,
                top_p: 0.77,
                openai_max_tokens: 55,
                stop: ['END'],
            },
        });
        const chat = await requestJson(baseUrl, 'POST', '/chats', {
            characterId: character.data.id,
            characterName: character.data.name,
            title: 'preset-request-test',
        });
        const session = await requestJson(baseUrl, 'POST', '/sessions', {
            characterId: character.data.id,
            chatId: chat.data.id,
            presetId: preset.data.id,
        });
        const generation = await requestJson(baseUrl, 'POST', '/generate', {
            sessionId: session.data.id,
            input: 'hello',
        });

        const events = await collectSse(baseUrl, generation.data.events);
        assert.equal(events.filter(event => event.event === 'token').map(event => event.data.token).join(''), 'preset ok');
        assert.equal(capturedBody.model, 'test-model');
        assert.equal(capturedBody.temperature, 0.42);
        assert.equal(capturedBody.frequency_penalty, 0.11);
        assert.equal(capturedBody.presence_penalty, 0.22);
        assert.equal(capturedBody.top_p, 0.77);
        assert.equal(capturedBody.max_tokens, 55);
        assert.deepEqual(capturedBody.stop, ['END']);
        assert.equal(capturedBody.chat_completion_source, undefined);
    } finally {
        await new Promise(resolve => server.close(resolve));
        await new Promise(resolve => backend.close(resolve));
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});

test('OpenAI-compatible backend 200 HTML responses are rejected', async () => {
    const dataRoot = path.resolve('.tmp-headless-tests', crypto.randomUUID());
    const backend = http.createServer((request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<html><head><title>Neo API</title></head><body>dashboard</body></html>');
    });

    await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
    const backendAddress = backend.address();
    const backendUrl = `http://127.0.0.1:${backendAddress.port}/token`;

    const created = await createHeadlessApp({
        token: TEST_TOKEN,
        dataRoot,
        provider: 'openai',
        openAiBaseUrl: backendUrl,
        openAiApiKey: 'test-key',
        openAiModel: 'test-model',
    });
    const server = created.app.listen(0, '127.0.0.1');

    await new Promise(resolve => server.once('listening', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/api/headless/v1`;

    try {
        const character = await requestJson(baseUrl, 'POST', '/characters', { name: 'HTML 200' });
        const chat = await requestJson(baseUrl, 'POST', '/chats', {
            characterId: character.data.id,
            characterName: character.data.name,
            title: 'html-200-test',
        });
        const session = await requestJson(baseUrl, 'POST', '/sessions', {
            characterId: character.data.id,
            chatId: chat.data.id,
        });

        const generation = await requestJson(baseUrl, 'POST', '/generate', {
            sessionId: session.data.id,
            input: 'hello',
        });
        const events = await collectSse(baseUrl, generation.data.events);
        const error = events.find(event => event.event === 'error');

        assert.equal(error.data.message, 'OpenAI-compatible backend returned 200: HTML error page: Neo API');
    } finally {
        await new Promise(resolve => server.close(resolve));
        await new Promise(resolve => backend.close(resolve));
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});
