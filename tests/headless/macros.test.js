import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateMacros, applyTextMacros } from '../../src/headless/macros.js';

test('evaluateMacros replaces {{char}} and {{user}} environment variables', () => {
    const result = evaluateMacros('{{char}} greets {{user}}.', { char: 'Ava', user: 'Mira' });
    assert.equal(result, 'Ava greets Mira.');
});

test('evaluateMacros is case-insensitive for built-in macros', () => {
    const result = evaluateMacros('{{CHAR}} and {{User}}', { char: 'Ava', user: 'Mira' });
    assert.equal(result, 'Ava and Mira');
});

test('evaluateMacros replaces legacy <USER> and <BOT> tags', () => {
    const result = evaluateMacros('<USER> talks to <BOT>.', { char: 'Ava', user: 'Mira' });
    assert.equal(result, 'Mira talks to Ava.');
});

test('evaluateMacros handles {{newline}} macro', () => {
    const result = evaluateMacros('Line1{{newline}}Line2', {});
    assert.equal(result, 'Line1\nLine2');
});

test('evaluateMacros handles {{trim}} macro (removes surrounding newlines)', () => {
    const result = evaluateMacros('Line1\n\n{{trim}}\n\nLine2', {});
    assert.equal(result, 'Line1Line2');
});

test('evaluateMacros produces time macros', () => {
    const result = evaluateMacros('Now: {{time}}', {});
    assert.ok(result.startsWith('Now: '));
    assert.ok(result.length > 'Now: '.length);
});

test('evaluateMacros produces date macros', () => {
    const result = evaluateMacros('Today: {{date}}', {});
    assert.ok(result.startsWith('Today: '));
});

test('evaluateMacros handles {{isodate}} macro', () => {
    const result = evaluateMacros('{{isodate}}', {});
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});

test('evaluateMacros handles {{isotime}} macro', () => {
    const result = evaluateMacros('{{isotime}}', {});
    assert.match(result, /^\d{2}:\d{2}$/);
});

test('evaluateMacros handles {{weekday}} macro', () => {
    const result = evaluateMacros('{{weekday}}', {});
    const expected = new Date().toLocaleDateString([], { weekday: 'long' });
    assert.equal(result, expected);
});

test('evaluateMacros handles {{roll}} macro', () => {
    const result = evaluateMacros('Roll: {{roll:1d6}}', {});
    const num = parseInt(result.replace('Roll: ', ''), 10);
    assert.ok(num >= 1 && num <= 6);
});

test('evaluateMacros handles {{random}} macro', () => {
    const result = evaluateMacros('{{random}}', {});
    const num = parseInt(result, 10);
    assert.ok(num >= 0 && num < 100);
});

test('evaluateMacros handles {{random::...}} pick syntax', () => {
    const result = evaluateMacros('{{random::cat::dog::fish}}', {});
    assert.ok(['cat', 'dog', 'fish'].includes(result));
});

test('evaluateMacros handles {{reverse:text}} macro', () => {
    const result = evaluateMacros('{{reverse:hello}}', {});
    assert.equal(result, 'olleh');
});

test('evaluateMacros handles {{//comment}} macro (strips comments)', () => {
    const result = evaluateMacros('Before{{//this is a comment}}After', {});
    assert.equal(result, 'BeforeAfter');
});

test('evaluateMacros handles {{noop}} macro (removed)', () => {
    const result = evaluateMacros('A{{noop}}B', {});
    assert.equal(result, 'AB');
});

test('evaluateMacros handles {{datetimeformat}} macro', () => {
    const result = evaluateMacros('{{datetimeformat YYYY-MM-DD}}', {});
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});

test('evaluateMacros handles chat state macros', () => {
    const messages = [
        { mes: 'Hello from user', is_user: true, send_date: new Date().toISOString() },
        { mes: 'Hello from char', is_user: false, send_date: new Date().toISOString() },
    ];
    const result = evaluateMacros('Last: {{lastMessage}}', {}, { messages });
    assert.equal(result, 'Last: Hello from char');
});

test('evaluateMacros {{lastUserMessage}} returns last user message', () => {
    const messages = [
        { mes: 'First user', is_user: true },
        { mes: 'Char reply', is_user: false },
        { mes: 'Second user', is_user: true },
    ];
    const result = evaluateMacros('{{lastUserMessage}}', {}, { messages });
    assert.equal(result, 'Second user');
});

test('evaluateMacros {{lastCharMessage}} returns last char message', () => {
    const messages = [
        { mes: 'First char', is_user: false },
        { mes: 'User msg', is_user: true },
        { mes: 'Second char', is_user: false },
    ];
    const result = evaluateMacros('{{lastCharMessage}}', {}, { messages });
    assert.equal(result, 'Second char');
});

test('evaluateMacros handles {{input}} macro', () => {
    const result = evaluateMacros('Input: {{input}}', {}, { input: 'test input' });
    assert.equal(result, 'Input: test input');
});

test('evaluateMacros handles context token macros', () => {
    const result = evaluateMacros('Max: {{maxPromptTokens}}', {}, { maxPromptTokens: 4096 });
    assert.equal(result, 'Max: 4096');
});

test('applyTextMacros backward compatibility wrapper works', () => {
    const result = applyTextMacros('{{char}} says hi to {{user}}.', {
        charName: 'Ava',
        userName: 'Mira',
    });
    assert.equal(result, 'Ava says hi to Mira.');
});

test('applyTextMacros handles charIfNotGroup', () => {
    const result = applyTextMacros('{{charIfNotGroup}} is here.', {
        charName: 'Ava',
        userName: 'Mira',
    });
    assert.equal(result, 'Ava is here.');
});

test('evaluateMacros handles outlet macro', () => {
    const result = evaluateMacros('{{outlet::mySlot}}', {}, {
        outletEntries: { mySlot: ['entry1', 'entry2'] },
    });
    assert.equal(result, 'entry1\nentry2');
});
