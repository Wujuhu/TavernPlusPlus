import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

const DEFAULT_CONFIG_PATH = './config/headless-gateway.config.json';

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

function getDefaultConfig() {
    return {
        headless: {
            apiToken: '',
            host: '127.0.0.1',
            port: 8001,
            dataRoot: './data-headless',
            userHandle: 'default-user',
            adminEnabled: false,
            provider: 'mock',
            mockDelayMs: 0,
            openAiBaseUrl: '',
            openAiApiKey: '',
            openAiModel: 'gpt-4o-mini',
        },
        telegram: {
            enabled: true,
            botToken: '',
            registerCommands: true,
            pollTimeoutSeconds: 25,
            allowedUserIds: [],
        },
        proxy: '',
    };
}

function mergeConfig(base, user) {
    return {
        ...base,
        ...user,
        headless: {
            ...base.headless,
            ...(user.headless || {}),
        },
        telegram: {
            ...base.telegram,
            ...(user.telegram || {}),
        },
        proxy: user.proxy ?? base.proxy,
    };
}

function writeConfig(filePath, config) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileAtomicSync(filePath, JSON.stringify(config, null, 4));
}

export function resolveRuntimeConfigPath(argv = process.argv.slice(2), cwd = process.cwd()) {
    return path.resolve(cwd, getArgValue(argv, 'headlessConfig') || DEFAULT_CONFIG_PATH);
}

export function loadHeadlessGatewayConfig(options = {}) {
    const argv = options.argv ?? process.argv.slice(2);
    const cwd = options.cwd ?? process.cwd();
    const configPath = options.configPath ? path.resolve(cwd, options.configPath) : resolveRuntimeConfigPath(argv, cwd);
    let config = getDefaultConfig();
    let shouldWrite = false;

    if (fs.existsSync(configPath)) {
        config = mergeConfig(config, JSON.parse(fs.readFileSync(configPath, 'utf8')));
    } else {
        shouldWrite = true;
    }

    if (!config.headless.apiToken) {
        config.headless.apiToken = crypto.randomBytes(32).toString('hex');
        shouldWrite = true;
    }

    if (shouldWrite) {
        writeConfig(configPath, config);
    }

    return {
        configPath,
        config,
    };
}
