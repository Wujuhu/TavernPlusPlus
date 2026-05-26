import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { copyHeadlessData } from '../../src/headless/copy-data.js';

test('copyHeadlessData copies selected user assets without secrets', async () => {
    const root = path.resolve('.tmp-headless-tests', crypto.randomUUID());
    const source = path.join(root, 'data');
    const target = path.join(root, 'data-headless');
    const sourceUser = path.join(source, 'default-user');
    const targetUser = path.join(target, 'default-user');

    try {
        await fs.promises.mkdir(path.join(sourceUser, 'characters'), { recursive: true });
        await fs.promises.mkdir(path.join(sourceUser, 'worlds'), { recursive: true });
        await fs.promises.mkdir(path.join(sourceUser, 'OpenAI Settings'), { recursive: true });
        await fs.promises.writeFile(path.join(sourceUser, 'characters', 'Ava.png'), 'character');
        await fs.promises.writeFile(path.join(sourceUser, 'worlds', 'lore.json'), '{"entries":{}}');
        await fs.promises.writeFile(path.join(sourceUser, 'OpenAI Settings', 'preset.json'), '{}');
        await fs.promises.writeFile(path.join(sourceUser, 'secrets.json'), '{"api":"secret"}');

        const report = await copyHeadlessData({
            sourceDataRoot: source,
            targetDataRoot: target,
            overwrite: true,
        });

        assert.ok(report.find(item => item.directory === 'characters')?.copied);
        assert.equal(await fs.promises.readFile(path.join(targetUser, 'characters', 'Ava.png'), 'utf8'), 'character');
        assert.equal(await fs.promises.readFile(path.join(targetUser, 'worlds', 'lore.json'), 'utf8'), '{"entries":{}}');
        assert.equal(await fs.promises.readFile(path.join(targetUser, 'OpenAI Settings', 'preset.json'), 'utf8'), '{}');
        assert.equal(fs.existsSync(path.join(targetUser, 'secrets.json')), false);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
