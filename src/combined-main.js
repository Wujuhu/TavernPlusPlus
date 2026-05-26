import path from 'node:path';

import { startHeadlessServer } from './headless/app.js';
import { startTelegramGateway } from './gateway/start.js';
import { loadHeadlessGatewayConfig } from './runtime-config.js';

function getArgValue(argv, name) {
    const exact = `--${name}`;
    const prefixed = `${exact}=`;

    for (let index = 0; index < argv.length; index++) {
        if (argv[index] === exact) {
            return argv[index + 1];
        }
        if (argv[index].startsWith(prefixed)) {
            return argv[index].slice(prefixed.length);
        }
    }

    return undefined;
}

export async function startCombinedRuntime(options = {}) {
    const argv = options.argv ?? process.argv.slice(2);
    const loaded = options.runtimeConfig
        ? { config: options.runtimeConfig, configPath: options.configPath || '' }
        : loadHeadlessGatewayConfig({ argv, cwd: options.cwd ?? process.cwd(), configPath: options.configPath });
    const headless = loaded.config.headless || {};
    const telegram = loaded.config.telegram || {};
    const dataRoot = path.resolve(options.dataRoot ?? getArgValue(argv, 'dataRoot') ?? headless.dataRoot ?? './data-headless');
    const token = options.token ?? headless.apiToken;
    const host = options.host ?? getArgValue(argv, 'host') ?? headless.host ?? '127.0.0.1';
    const port = Number(options.port ?? getArgValue(argv, 'port') ?? headless.port ?? 8001);
    const headlessBaseUrl = `http://${host}:${port}/api/headless/v1`;
    const server = await startHeadlessServer({
        ...options,
        dataRoot,
        token,
        host,
        port,
        userHandle: headless.userHandle,
        adminEnabled: headless.adminEnabled,
        provider: headless.provider,
        mockDelayMs: headless.mockDelayMs,
        openAiBaseUrl: headless.openAiBaseUrl,
        openAiApiKey: headless.openAiApiKey,
        openAiModel: headless.openAiModel,
    });
    const gateway = await startTelegramGateway({
        enabled: Boolean(telegram.enabled && telegram.botToken),
        telegramToken: telegram.botToken,
        registerCommands: telegram.registerCommands,
        pollTimeoutSeconds: telegram.pollTimeoutSeconds,
        ...(options.gateway || {}),
        dataRoot,
        headlessBaseUrl,
        headlessToken: token,
    });

    return { server, gateway, token, headlessBaseUrl, configPath: loaded.configPath };
}
