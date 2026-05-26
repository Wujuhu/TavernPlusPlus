import test from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_COMPLETION_SOURCES } from '../../src/constants.js';
import {
    createChatCompletionGenerationData,
    createOpenAiCompatibleRequestBody,
} from '../../src/headless/st-pipeline/chat-completion-parameters.js';
import { createStreamingReplyState, getStreamingReply } from '../../src/headless/st-pipeline/chat-completion-reply.js';

test('createChatCompletionGenerationData maps SillyTavern OpenAI preset fields', () => {
    const { generateData, stream } = createChatCompletionGenerationData({
        settings: {
            chat_completion_source: CHAT_COMPLETION_SOURCES.CUSTOM,
            temperature: 0.42,
            frequency_penalty: 0.1,
            presence_penalty: 0.2,
            top_p: 0.7,
            openai_max_tokens: 123,
            stream_openai: false,
            stop: ['A', 'B', 'C', 'D', 'E'],
        },
        model: 'test-model',
        type: 'normal',
        messages: [{ role: 'user', content: 'hello' }],
        userName: 'Mira',
        charName: 'Ava',
    });

    assert.equal(stream, false);
    assert.equal(generateData.model, 'test-model');
    assert.equal(generateData.temperature, 0.42);
    assert.equal(generateData.frequency_penalty, 0.1);
    assert.equal(generateData.presence_penalty, 0.2);
    assert.equal(generateData.top_p, 0.7);
    assert.equal(generateData.max_tokens, 123);
    assert.deepEqual(generateData.stop, ['A', 'B', 'C', 'D']);
    assert.equal(generateData.user_name, 'Mira');
    assert.equal(generateData.char_name, 'Ava');
});

test('createChatCompletionGenerationData applies original o-series request conversion', () => {
    const { generateData } = createChatCompletionGenerationData({
        settings: {
            chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI,
            openai_max_tokens: 64,
            temperature: 0.7,
            stop: ['stop'],
        },
        model: 'o1',
        messages: [
            { role: 'system', content: 'rules' },
            { role: 'user', content: 'hello' },
        ],
    });

    assert.equal(generateData.max_completion_tokens, 64);
    assert.equal(generateData.max_tokens, undefined);
    assert.equal(generateData.temperature, undefined);
    assert.equal(generateData.stop, undefined);
    assert.deepEqual(generateData.messages.map(message => message.role), ['user', 'user']);
});

test('createOpenAiCompatibleRequestBody removes SillyTavern backend-only fields', () => {
    const { generateData } = createChatCompletionGenerationData({
        settings: {
            chat_completion_source: CHAT_COMPLETION_SOURCES.CUSTOM,
            temperature: 0.33,
        },
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
        userName: 'Mira',
        charName: 'Ava',
    });
    const body = createOpenAiCompatibleRequestBody(generateData, { extra_provider_flag: true });

    assert.equal(body.temperature, 0.33);
    assert.equal(body.model, 'test-model');
    assert.equal(body.type, undefined);
    assert.equal(body.chat_completion_source, undefined);
    assert.equal(body.user_name, undefined);
    assert.equal(body.extra_provider_flag, true);
});

test('getStreamingReply follows SillyTavern OpenAI-compatible fallbacks', () => {
    const state = createStreamingReplyState();

    assert.equal(getStreamingReply({
        choices: [{ delta: { content: 'stream' } }],
    }, state), 'stream');
    assert.equal(getStreamingReply({
        choices: [{ message: { content: 'message' } }],
    }, state), 'message');
    assert.equal(getStreamingReply({
        choices: [{ text: 'text' }],
    }, state), 'text');
});

test('getStreamingReply captures reasoning fields for compatible sources', () => {
    const state = createStreamingReplyState();
    const token = getStreamingReply({
        choices: [{ delta: { content: 'visible', reasoning_content: 'hidden' } }],
    }, state, {
        chatCompletionSource: CHAT_COMPLETION_SOURCES.CUSTOM,
        overrideShowThoughts: true,
    });

    assert.equal(token, 'visible');
    assert.equal(state.reasoning, 'hidden');
});

test('getStreamingReply ports OpenRouter image and signature extraction', () => {
    const state = createStreamingReplyState();
    const token = getStreamingReply({
        choices: [{
            delta: {
                content: 'token',
                images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
                reasoning_details: [
                    { type: 'reasoning.encrypted', id: 'summary', data: 'sig' },
                    { type: 'reasoning.encrypted', id: 'tool_1', data: 'tool-sig' },
                ],
            },
        }],
    }, state, {
        chatCompletionSource: CHAT_COMPLETION_SOURCES.OPENROUTER,
        overrideShowThoughts: true,
    });

    assert.equal(token, 'token');
    assert.deepEqual(state.images, ['data:image/png;base64,AAAA']);
    assert.equal(state.signature, 'sig');
    assert.equal(state.toolSignatures.tool_1, 'tool-sig');
});

test('getStreamingReply handles Claude and Mistral content shapes', () => {
    const claudeState = createStreamingReplyState();
    const mistralState = createStreamingReplyState();

    assert.equal(getStreamingReply({
        delta: { text: 'claude', thinking: 'thought' },
    }, claudeState, {
        chatCompletionSource: CHAT_COMPLETION_SOURCES.CLAUDE,
        overrideShowThoughts: true,
    }), 'claude');
    assert.equal(claudeState.reasoning, 'thought');

    assert.equal(getStreamingReply({
        choices: [{ delta: { content: [{ text: 'mis' }, { text: 'tral' }] } }],
    }, mistralState, {
        chatCompletionSource: CHAT_COMPLETION_SOURCES.MISTRALAI,
    }), 'mistral');
});
