import path from 'node:path';

function getArgValue(argv, name) {
    const exact = `--${name}`;
    const prefixed = `${exact}=`;

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === exact) {
            return argv[index + 1];
        }
        if (arg.startsWith(prefixed)) {
            return arg.slice(prefixed.length);
        }
    }

    return undefined;
}

function getBooleanValue(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }

    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function getNumberValue(value, defaultValue) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : defaultValue;
}

/**
 * Resolves the runtime configuration for the headless API server.
 * @param {object} [overrides] Explicit runtime overrides
 * @param {string[]} [overrides.argv] Command line arguments
 * @param {string} [overrides.cwd] Working directory
 * @param {string} [overrides.host] Hostname or address
 * @param {number} [overrides.port] TCP port
 * @param {string} [overrides.dataRoot] Data root
 * @param {string} [overrides.token] API bearer token
 * @param {string} [overrides.provider] Generation provider
 * @param {boolean} [overrides.adminEnabled] Whether to expose admin page
 * @returns {object} Headless configuration
 */
export function resolveHeadlessConfig(overrides = {}) {
    const argv = overrides.argv ?? process.argv.slice(2);
    const cwd = overrides.cwd ?? process.cwd();
    const token = overrides.token ?? getArgValue(argv, 'token');
    const dataRootValue = overrides.dataRoot ?? getArgValue(argv, 'dataRoot') ?? './data-headless';
    const openAiBaseUrl = overrides.openAiBaseUrl ?? getArgValue(argv, 'openAiBaseUrl') ?? '';
    const openAiApiKey = overrides.openAiApiKey ?? getArgValue(argv, 'openAiApiKey') ?? '';
    const openAiModel = overrides.openAiModel ?? getArgValue(argv, 'openAiModel') ?? 'gpt-4o-mini';
    const provider = overrides.provider ?? getArgValue(argv, 'provider') ?? (openAiBaseUrl && openAiApiKey ? 'openai' : 'mock');

    if (!token) {
        throw new Error('Headless API token is required. Set headless.apiToken in config/headless-gateway.config.json.');
    }

    return {
        host: overrides.host ?? getArgValue(argv, 'host') ?? '127.0.0.1',
        port: getNumberValue(overrides.port ?? getArgValue(argv, 'port'), 8001),
        dataRoot: path.resolve(cwd, dataRootValue),
        token,
        userHandle: overrides.userHandle ?? getArgValue(argv, 'userHandle') ?? 'default-user',
        provider,
        adminEnabled: overrides.adminEnabled ?? getBooleanValue(getArgValue(argv, 'admin'), false),
        mockDelayMs: getNumberValue(overrides.mockDelayMs, 0),
        openAiBaseUrl,
        openAiApiKey,
        openAiModel,
        fetchImpl: overrides.fetchImpl || undefined,
    };
}
