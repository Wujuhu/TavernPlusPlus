import path from 'node:path';

function getNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function resolveTelegramGatewayConfig(options = {}) {
    const dataRoot = path.resolve(options.dataRoot || './data-headless');
    const token = options.telegramToken ?? '';

    return {
        enabled: options.enabled ?? Boolean(token),
        token,
        dataRoot,
        statePath: options.statePath || path.join(dataRoot, 'gateway', 'telegram-state.json'),
        headlessBaseUrl: options.headlessBaseUrl || 'http://127.0.0.1:8001/api/headless/v1',
        headlessToken: options.headlessToken || '',
        registerCommands: options.registerCommands !== false,
        pollTimeoutSeconds: getNumber(options.pollTimeoutSeconds, 25),
    };
}
