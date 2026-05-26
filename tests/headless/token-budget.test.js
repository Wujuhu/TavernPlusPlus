import test from 'node:test';
import assert from 'node:assert/strict';

import { countTokens, countMessageTokens, estimateTokens } from '../../src/headless/st-pipeline/tokenizer.js';
import { Message, MessageCollection, ChatCompletion, TokenBudgetExceededError } from '../../src/headless/st-pipeline/chat-completion.js';

// === Tokenizer tests ===

test('countTokens returns a positive number for non-empty text', () => {
    const count = countTokens('Hello, world!');
    assert.ok(count > 0);
    assert.ok(Number.isInteger(count));
});

test('countTokens returns 0 for empty or null text', () => {
    assert.equal(countTokens(''), 0);
    assert.equal(countTokens(null), 0);
    assert.equal(countTokens(undefined), 0);
});

test('countMessageTokens includes per-message overhead', () => {
    const messages = [
        { role: 'user', content: 'Hi' },
    ];
    const count = countMessageTokens(messages);
    const contentOnly = countTokens('user') + countTokens('Hi');
    assert.ok(count > contentOnly);
});

test('countMessageTokens handles empty message array', () => {
    assert.equal(countMessageTokens([]), 0);
    assert.equal(countMessageTokens(null), 0);
});

test('estimateTokens provides byte-based estimate', () => {
    const estimate = estimateTokens('Hello, world!');
    assert.ok(estimate > 0);
    assert.ok(Number.isInteger(estimate));
});

test('countTokens respects model parameter for encoding selection', () => {
    const count1 = countTokens('Hello, world!', 'gpt-4');
    const count2 = countTokens('Hello, world!', 'gpt-4o');
    assert.ok(count1 > 0);
    assert.ok(count2 > 0);
});

// === Message tests ===

test('Message.create counts tokens correctly', () => {
    const msg = Message.create('system', 'Hello, world!', 'test');
    assert.ok(msg.tokens > 0);
    assert.equal(msg.role, 'system');
    assert.equal(msg.content, 'Hello, world!');
    assert.equal(msg.identifier, 'test');
});

test('Message.toJSON omits internal fields', () => {
    const msg = Message.create('user', 'Hi', 'greeting');
    const json = msg.toJSON();
    assert.equal(json.role, 'user');
    assert.equal(json.content, 'Hi');
    assert.equal(json.identifier, undefined);
    assert.equal(json.tokens, undefined);
});

test('Message.fromPrompt creates message from prompt object', () => {
    const msg = Message.fromPrompt({
        role: 'system',
        content: 'Be helpful.',
        identifier: 'main',
    });
    assert.equal(msg.role, 'system');
    assert.equal(msg.content, 'Be helpful.');
    assert.ok(msg.tokens > 0);
});

// === MessageCollection tests ===

test('MessageCollection tracks total tokens', () => {
    const coll = new MessageCollection('test');
    const msg1 = Message.create('system', 'First message.', 'msg1');
    const msg2 = Message.create('user', 'Second message.', 'msg2');
    coll.add(msg1);
    coll.add(msg2);

    assert.equal(coll.getTokens(), msg1.getTokens() + msg2.getTokens());
});

test('MessageCollection.flatten returns flat array of Messages', () => {
    const outer = new MessageCollection('outer');
    const inner = new MessageCollection('inner');
    inner.add(Message.create('system', 'Nested.', 'n'));
    outer.add(Message.create('user', 'Top.', 't'));
    outer.add(inner);

    const flat = outer.flatten();
    assert.equal(flat.length, 2);
    assert.equal(flat[0].content, 'Top.');
    assert.equal(flat[1].content, 'Nested.');
});

test('MessageCollection.getChat produces API-compatible message objects', () => {
    const coll = new MessageCollection('test');
    coll.add(Message.create('system', 'You are helpful.', 'main'));
    coll.add(Message.create('user', 'Hello!', 'greeting'));

    const chat = coll.getChat();
    assert.equal(chat.length, 2);
    assert.equal(chat[0].role, 'system');
    assert.equal(chat[0].content, 'You are helpful.');
    assert.equal(chat[0].identifier, undefined);
});

// === ChatCompletion tests ===

test('ChatCompletion manages token budget', () => {
    const cc = new ChatCompletion();
    cc.setTokenBudget(1000, 200);
    assert.equal(cc.getRemainingBudget(), 800);
});

test('ChatCompletion.add deducts from budget', () => {
    const cc = new ChatCompletion();
    cc.setTokenBudget(1000, 200);
    const startBudget = cc.getRemainingBudget();

    const coll = new MessageCollection('test');
    coll.add(Message.create('system', 'A short message.', 'msg'));
    cc.add(coll);

    assert.ok(cc.getRemainingBudget() < startBudget);
});

test('ChatCompletion.canAfford returns false when over budget', () => {
    const cc = new ChatCompletion();
    cc.setTokenBudget(50, 20);

    const bigMsg = Message.create('system', 'A '.repeat(100), 'big');
    assert.equal(cc.canAfford(bigMsg), false);
});

test('ChatCompletion throws TokenBudgetExceededError when adding too large message', () => {
    const cc = new ChatCompletion();
    cc.setTokenBudget(50, 20);

    const coll = new MessageCollection('big');
    coll.add(Message.create('system', 'A '.repeat(100), 'big'));

    assert.throws(() => cc.add(coll), TokenBudgetExceededError);
});

test('ChatCompletion.reserveBudget and freeBudget work correctly', () => {
    const cc = new ChatCompletion();
    cc.setTokenBudget(1000, 200);
    const initial = cc.getRemainingBudget();

    cc.reserveBudget(50);
    assert.equal(cc.getRemainingBudget(), initial - 50);

    cc.freeBudget(50);
    assert.equal(cc.getRemainingBudget(), initial);
});

test('ChatCompletion.getChat returns flat message list', () => {
    const cc = new ChatCompletion();
    cc.setTokenBudget(10000, 200);

    const c1 = new MessageCollection('system');
    c1.add(Message.create('system', 'System prompt.', 'main'));
    cc.add(c1);

    const c2 = new MessageCollection('chat');
    c2.add(Message.create('user', 'Hello!', 'msg1'));
    c2.add(Message.create('assistant', 'Hi there!', 'msg2'));
    cc.add(c2);

    const chat = cc.getChat();
    assert.equal(chat.length, 3);
    assert.equal(chat[0].role, 'system');
    assert.equal(chat[1].role, 'user');
    assert.equal(chat[2].role, 'assistant');
});

test('ChatCompletion supports insert operations', () => {
    const cc = new ChatCompletion();
    cc.setTokenBudget(10000, 200);

    const coll = new MessageCollection('chat');
    coll.add(Message.create('user', 'First.', 'first'));
    cc.add(coll);

    cc.insertAtEnd(Message.create('assistant', 'Second.', 'second'), 'chat');

    const chat = cc.getChat();
    assert.equal(chat.length, 2);
    assert.equal(chat[1].role, 'assistant');
});
