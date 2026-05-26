import test from 'node:test';
import assert from 'node:assert/strict';

import { compilePrompt } from '../../src/headless/prompt.js';

test('compilePrompt uses SillyTavern prompt order, macros, examples, and character book entries', () => {
    const prompt = compilePrompt({
        character: {
            name: 'Ava',
            data: {
                name: 'Ava',
                description: '{{char}} is a direct pilot.',
                personality: '{{char}} speaks with dry humor.',
                scenario: '{{user}} is testing the ship.',
                mes_example: '<START>\n{{user}}: Status?\n{{char}}: Still flying.',
                character_book: {
                    entries: [
                        {
                            keys: ['ship'],
                            content: '{{char}} keeps a red notebook in the cockpit.',
                            enabled: true,
                        },
                    ],
                },
            },
        },
        chat: {
            header: {
                user_name: 'Mira',
                character_name: 'Ava',
            },
            messages: [
                { is_user: true, mes: 'How is the ship?' },
            ],
        },
        input: 'ship',
    });

    assert.equal(prompt.messages[0].role, 'system');
    assert.match(prompt.messages[0].content, /Write Ava's next reply/);
    assert.ok(prompt.messages.some(message => /Ava is a direct pilot/.test(message.content)));
    assert.ok(prompt.messages.some(message => /Ava speaks with dry humor/.test(message.content)));
    assert.ok(prompt.messages.some(message => /Mira is testing the ship/.test(message.content)));
    assert.ok(prompt.messages.some(message => /red notebook/.test(message.content)));
    assert.ok(prompt.messages.some(message => message.name === 'example_user' && message.content === 'Status?'));
    assert.ok(prompt.messages.some(message => message.name === 'example_assistant' && message.content === 'Still flying.'));
    assert.equal(prompt.messages.at(-1).role, 'user');
    assert.equal(prompt.messages.at(-1).content, 'How is the ship?');
});

test('compilePrompt honors imported OpenAI preset prompts and prompt_order', () => {
    const prompt = compilePrompt({
        character: {
            name: 'Ava',
            data: {
                name: 'Ava',
                description: 'Definition for {{char}}.',
            },
        },
        chat: {
            header: {
                user_name: 'Mira',
                character_name: 'Ava',
            },
            messages: [
                { is_user: true, mes: 'Hello.' },
            ],
        },
        preset: {
            preset: {
                prompts: [
                    {
                        name: 'Main Prompt',
                        system_prompt: true,
                        role: 'system',
                        content: 'Custom main for {{char}} and {{user}}.',
                        identifier: 'main',
                    },
                    {
                        identifier: 'charDescription',
                        name: 'Char Description',
                        system_prompt: true,
                        marker: true,
                    },
                    {
                        identifier: 'chatHistory',
                        name: 'Chat History',
                        system_prompt: true,
                        marker: true,
                    },
                ],
                prompt_order: [
                    {
                        character_id: 100001,
                        order: [
                            { identifier: 'charDescription', enabled: true },
                            { identifier: 'main', enabled: true },
                            { identifier: 'chatHistory', enabled: true },
                        ],
                    },
                ],
            },
        },
    });

    assert.equal(prompt.messages[0].content, 'Definition for Ava.');
    assert.equal(prompt.messages[1].content, 'Custom main for Ava and Mira.');
    assert.equal(prompt.messages[2].content, 'Hello.');
});
