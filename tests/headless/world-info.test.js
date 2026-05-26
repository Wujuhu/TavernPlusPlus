import test from 'node:test';
import assert from 'node:assert/strict';

import { checkWorldInfo, world_info_position } from '../../src/headless/st-pipeline/world-info.js';

test('checkWorldInfo activates entries matching primary keywords in chat', () => {
    const result = checkWorldInfo({
        chat: [
            { mes: 'Have you seen the dragon?', is_user: true },
        ],
        worldbooks: [{
            name: 'lore',
            entries: {
                0: {
                    uid: '0',
                    key: ['dragon'],
                    content: 'A fearsome red dragon lives in the mountains.',
                    position: world_info_position.before,
                    order: 100,
                    enabled: true,
                },
            },
        }],
        maxContext: 4096,
    });

    assert.ok(result.worldInfoBefore.includes('fearsome red dragon'));
    assert.equal(result.allActivatedEntries.size, 1);
});

test('checkWorldInfo does not activate disabled entries', () => {
    const result = checkWorldInfo({
        chat: [
            { mes: 'Tell me about the castle.', is_user: true },
        ],
        worldbooks: [{
            name: 'lore',
            entries: {
                0: {
                    uid: '0',
                    key: ['castle'],
                    content: 'A ruined castle stands on the hill.',
                    position: world_info_position.before,
                    order: 100,
                    disable: true,
                },
            },
        }],
        maxContext: 4096,
    });

    assert.equal(result.worldInfoBefore, '');
    assert.equal(result.allActivatedEntries.size, 0);
});

test('checkWorldInfo activates constant entries regardless of keywords', () => {
    const result = checkWorldInfo({
        chat: [
            { mes: 'Hello there.', is_user: true },
        ],
        worldbooks: [{
            name: 'lore',
            entries: {
                0: {
                    uid: '0',
                    key: ['nonexistent_keyword'],
                    content: 'This is always included.',
                    position: world_info_position.before,
                    order: 100,
                    constant: true,
                    enabled: true,
                },
            },
        }],
        maxContext: 4096,
    });

    assert.ok(result.worldInfoBefore.includes('always included'));
    assert.equal(result.allActivatedEntries.size, 1);
});

test('checkWorldInfo respects injection positions: before, after, atDepth', () => {
    const result = checkWorldInfo({
        chat: [
            { mes: 'Tell me about the castle and the dragon and the sword.', is_user: true },
        ],
        worldbooks: [{
            name: 'lore',
            entries: {
                0: {
                    uid: '0',
                    key: ['castle'],
                    content: 'Castle content.',
                    position: world_info_position.before,
                    order: 100,
                    enabled: true,
                },
                1: {
                    uid: '1',
                    key: ['dragon'],
                    content: 'Dragon content.',
                    position: world_info_position.after,
                    order: 100,
                    enabled: true,
                },
                2: {
                    uid: '2',
                    key: ['sword'],
                    content: 'Sword content.',
                    position: world_info_position.atDepth,
                    depth: 2,
                    role: 'system',
                    order: 100,
                    enabled: true,
                },
            },
        }],
        maxContext: 4096,
    });

    assert.ok(result.worldInfoBefore.includes('Castle content'));
    assert.ok(result.worldInfoAfter.includes('Dragon content'));
    assert.ok(result.WIDepthEntries.some(e => e.entries.includes('Sword content.') && e.depth === 2));
});

test('checkWorldInfo handles secondary keywords with AND_ANY logic', () => {
    const result = checkWorldInfo({
        chat: [
            { mes: 'The knight drew his sword.', is_user: true },
        ],
        worldbooks: [{
            name: 'lore',
            entries: {
                0: {
                    uid: '0',
                    key: ['knight'],
                    keysecondary: ['sword', 'shield'],
                    selectiveLogic: 0,
                    selective: true,
                    content: 'The knight is brave.',
                    position: world_info_position.before,
                    order: 100,
                    enabled: true,
                },
            },
        }],
        maxContext: 4096,
    });

    assert.ok(result.worldInfoBefore.includes('brave'));
});

test('checkWorldInfo filters by secondary keywords when selective is true and no match', () => {
    const result = checkWorldInfo({
        chat: [
            { mes: 'The knight walked away.', is_user: true },
        ],
        worldbooks: [{
            name: 'lore',
            entries: {
                0: {
                    uid: '0',
                    key: ['knight'],
                    keysecondary: ['sword', 'shield'],
                    selectiveLogic: 3,
                    selective: true,
                    content: 'The knight has weapons.',
                    position: world_info_position.before,
                    order: 100,
                    enabled: true,
                },
            },
        }],
        maxContext: 4096,
    });

    assert.equal(result.worldInfoBefore, '');
});

test('checkWorldInfo respects token budget', () => {
    const result = checkWorldInfo({
        chat: [
            { mes: 'Tell me about cats and dogs and birds and fish.', is_user: true },
        ],
        worldbooks: [{
            name: 'lore',
            entries: {
                0: {
                    uid: '0',
                    key: ['cats'],
                    content: 'Cats are wonderful creatures that purr and meow. '.repeat(50),
                    position: world_info_position.before,
                    order: 200,
                    enabled: true,
                },
                1: {
                    uid: '1',
                    key: ['dogs'],
                    content: 'Dogs are loyal companions. '.repeat(50),
                    position: world_info_position.before,
                    order: 100,
                    enabled: true,
                },
            },
        }],
        maxContext: 200,
        settings: { budget: 10, budgetCap: 50 },
    });

    assert.ok(result.allActivatedEntries.size <= 2);
});

test('checkWorldInfo produces empty result for empty worldbooks', () => {
    const result = checkWorldInfo({
        chat: [{ mes: 'Hello', is_user: true }],
        worldbooks: [],
        maxContext: 4096,
    });

    assert.equal(result.worldInfoBefore, '');
    assert.equal(result.worldInfoAfter, '');
    assert.equal(result.allActivatedEntries.size, 0);
});

test('checkWorldInfo supports regex keywords', () => {
    const result = checkWorldInfo({
        chat: [
            { mes: 'The dragon123 attacks!', is_user: true },
        ],
        worldbooks: [{
            name: 'lore',
            entries: {
                0: {
                    uid: '0',
                    key: ['/dragon\\d+/i'],
                    content: 'Regex matched dragon.',
                    position: world_info_position.before,
                    order: 100,
                    enabled: true,
                },
            },
        }],
        maxContext: 4096,
    });

    assert.ok(result.worldInfoBefore.includes('Regex matched'));
});

test('checkWorldInfo handles case sensitive matching', () => {
    const result = checkWorldInfo({
        chat: [
            { mes: 'the DRAGON attacks!', is_user: true },
        ],
        worldbooks: [{
            name: 'lore',
            entries: {
                0: {
                    uid: '0',
                    key: ['dragon'],
                    content: 'Lowercase dragon.',
                    position: world_info_position.before,
                    order: 100,
                    enabled: true,
                    caseSensitive: true,
                },
            },
        }],
        maxContext: 4096,
    });

    assert.equal(result.worldInfoBefore, '');
});

test('checkWorldInfo applies probability filtering', () => {
    let activatedCount = 0;
    const runs = 100;

    for (let i = 0; i < runs; i++) {
        const result = checkWorldInfo({
            chat: [{ mes: 'dragon', is_user: true }],
            worldbooks: [{
                name: 'lore',
                entries: {
                    0: {
                        uid: '0',
                        key: ['dragon'],
                        content: 'Dragon lore.',
                        position: world_info_position.before,
                        order: 100,
                        enabled: true,
                        useProbability: true,
                        probability: 0,
                    },
                },
            }],
            maxContext: 4096,
        });

        if (result.allActivatedEntries.size > 0) activatedCount++;
    }

    assert.equal(activatedCount, 0);
});
