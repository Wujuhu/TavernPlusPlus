import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { startCombinedRuntime } from '../../src/combined-main.js';

test('combined runtime starts headless by default and persists generated API token', async () => {
    const dataRoot = path.resolve('.tmp-headless-tests', crypto.randomUUID());
    const runtime = await startCombinedRuntime({
        runtimeConfig: {
            headless: {
                apiToken: 'runtime-token',
                host: '127.0.0.1',
                port: 0,
                dataRoot,
                provider: 'mock',
            },
            telegram: {
                enabled: false,
                botToken: '',
                pollTimeoutSeconds: 1,
            },
        },
        gateway: { enabled: false },
    });

    try {
        const address = runtime.server.address();
        const response = await fetch(`http://127.0.0.1:${address.port}/api/headless/v1/health`, {
            headers: { Authorization: `Bearer ${runtime.token}` },
        });
        assert.equal(response.status, 200);
        assert.equal(runtime.token, 'runtime-token');
    } finally {
        runtime.gateway.stop();
        await new Promise(resolve => runtime.server.close(resolve));
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
});
