import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import tiktoken from 'tiktoken';
import { SentencePieceProcessor } from '@agnai/sentencepiece-js';
import { Tokenizer } from '@agnai/web-tokenizers';

const BYTES_PER_TOKEN = 3.35;
const MESSAGE_OVERHEAD_TOKENS = 3;
const REPLY_PRIMING_TOKENS = 3;

const gunzip = promisify(zlib.gunzip);

const tiktokenCache = new Map();
const sppCache = new Map();
const webCache = new Map();

const SENTENCEPIECE_MODELS = {
    llama: 'src/tokenizers/llama.model',
    nerdstash: 'src/tokenizers/nerdstash.model',
    nerdstash_v2: 'src/tokenizers/nerdstash_v2.model',
    mistral: 'src/tokenizers/mistral.model',
    yi: 'src/tokenizers/yi.model',
    gemma: 'src/tokenizers/gemma.model',
    jamba: 'src/tokenizers/jamba.model',
};

const WEB_TOKENIZER_MODELS = {
    claude: { path: 'src/tokenizers/claude.json' },
    llama3: { path: 'src/tokenizers/llama3.json' },
    'command-r': { url: 'https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/command-r.json.gz', fallback: 'src/tokenizers/llama3.json' },
    'command-a': { url: 'https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/command-a.json.gz', fallback: 'src/tokenizers/llama3.json' },
    qwen2: { url: 'https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/qwen2.json.gz', fallback: 'src/tokenizers/llama3.json' },
    nemo: { url: 'https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/nemo.json.gz', fallback: 'src/tokenizers/llama3.json' },
    deepseek: { url: 'https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/deepseek.json.gz', fallback: 'src/tokenizers/llama3.json' },
};

function resolveTokenizerType(model) {
    if (!model) return { backend: 'tiktoken', encoding: 'cl100k_base' };
    const m = String(model).toLowerCase();

    if (m.includes('gpt-4o') || m.includes('chatgpt-4o') || m.includes('gpt-4.1') || m.includes('gpt-4.5') || m.includes('gpt-5') || m.includes('o1') || m.includes('o3') || m.includes('o4')) {
        return { backend: 'tiktoken', encoding: 'o200k_base' };
    }
    if (m.includes('gpt-4') || m.includes('gpt-3.5') || m.includes('text-embedding') || m.includes('text-davinci')) {
        return { backend: 'tiktoken', encoding: 'cl100k_base' };
    }
    if (m.includes('claude')) return { backend: 'web', name: 'claude' };
    if (m.includes('llama3') || m.includes('llama-3')) return { backend: 'web', name: 'llama3' };
    if (m.includes('llama')) return { backend: 'spp', name: 'llama' };
    if (m.includes('mistral')) return { backend: 'spp', name: 'mistral' };
    if (m.includes('yi')) return { backend: 'spp', name: 'yi' };
    if (m.includes('deepseek')) return { backend: 'web', name: 'deepseek' };
    if (m.includes('gemma') || m.includes('gemini') || m.includes('learnlm')) return { backend: 'spp', name: 'gemma' };
    if (m.includes('jamba')) return { backend: 'spp', name: 'jamba' };
    if (m.includes('qwen2') || m.includes('qwen-2')) return { backend: 'web', name: 'qwen2' };
    if (m.includes('command-a')) return { backend: 'web', name: 'command-a' };
    if (m.includes('command-r')) return { backend: 'web', name: 'command-r' };
    if (m.includes('nemo')) return { backend: 'web', name: 'nemo' };
    if (m.includes('nerdstash_v2')) return { backend: 'spp', name: 'nerdstash_v2' };
    if (m.includes('nerdstash')) return { backend: 'spp', name: 'nerdstash' };

    return { backend: 'tiktoken', encoding: 'cl100k_base' };
}

function getTiktokenEncoder(encoding) {
    if (tiktokenCache.has(encoding)) return tiktokenCache.get(encoding);
    try {
        const enc = tiktoken.get_encoding(encoding);
        tiktokenCache.set(encoding, enc);
        return enc;
    } catch {
        if (encoding !== 'cl100k_base') {
            try {
                const fallback = tiktoken.get_encoding('cl100k_base');
                tiktokenCache.set(encoding, fallback);
                return fallback;
            } catch { return null; }
        }
        return null;
    }
}

async function loadSpp(name) {
    if (sppCache.has(name)) return sppCache.get(name);
    const modelPath = SENTENCEPIECE_MODELS[name];
    if (!modelPath || !fs.existsSync(modelPath)) {
        sppCache.set(name, null);
        return null;
    }
    try {
        const spp = new SentencePieceProcessor();
        await spp.load(modelPath);
        sppCache.set(name, spp);
        return spp;
    } catch (err) {
        console.error(`Failed to load sentencepiece tokenizer ${name}:`, err.message);
        sppCache.set(name, null);
        return null;
    }
}

async function loadWebTokenizer(name) {
    if (webCache.has(name)) return webCache.get(name);
    const config = WEB_TOKENIZER_MODELS[name];
    if (!config) { webCache.set(name, null); return null; }

    let fileBuffer;
    if (config.path && fs.existsSync(config.path)) {
        fileBuffer = await fs.promises.readFile(config.path);
    } else if (config.url) {
        try {
            const cachePath = path.join(globalThis.DATA_ROOT || '.', '_cache');
            if (!fs.existsSync(cachePath)) fs.mkdirSync(cachePath, { recursive: true });
            const fileName = new URL(config.url).pathname.split('/').pop();
            const cachedFile = path.join(cachePath, fileName);
            const uncompressed = cachedFile.replace(/\.gz$/, '');
            if (fs.existsSync(uncompressed)) {
                fileBuffer = await fs.promises.readFile(uncompressed);
            } else if (fs.existsSync(cachedFile)) {
                fileBuffer = config.url.endsWith('.gz')
                    ? await gunzip(await fs.promises.readFile(cachedFile))
                    : await fs.promises.readFile(cachedFile);
            } else {
                const res = await fetch(config.url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const raw = Buffer.from(await res.arrayBuffer());
                if (config.url.endsWith('.gz')) {
                    fileBuffer = await gunzip(raw);
                    fs.writeFileSync(uncompressed, fileBuffer);
                } else {
                    fileBuffer = raw;
                    fs.writeFileSync(cachedFile, raw);
                }
            }
        } catch (err) {
            console.error(`Failed to fetch web tokenizer ${name}: ${err.message}. Trying fallback.`);
            if (config.fallback && fs.existsSync(config.fallback)) {
                fileBuffer = await fs.promises.readFile(config.fallback);
            }
        }
    }

    if (!fileBuffer) { webCache.set(name, null); return null; }

    try {
        const tokenizer = await Tokenizer.fromJSON(fileBuffer);
        webCache.set(name, tokenizer);
        return tokenizer;
    } catch (err) {
        console.error(`Failed to init web tokenizer ${name}:`, err.message);
        webCache.set(name, null);
        return null;
    }
}

function countWithTiktoken(text, encoding) {
    const enc = getTiktokenEncoder(encoding);
    if (!enc) return estimateTokens(text);
    try { return enc.encode(text).length; } catch { return estimateTokens(text); }
}

function countWithSpp(text, spp) {
    if (!spp) return estimateTokens(text);
    try {
        const ids = spp.encodeIds(text);
        return ids.length;
    } catch { return estimateTokens(text); }
}

function countWithWeb(text, tokenizer) {
    if (!tokenizer) return estimateTokens(text);
    try { return tokenizer.encode(text).length; } catch { return estimateTokens(text); }
}

export function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(Buffer.byteLength(String(text), 'utf8') / BYTES_PER_TOKEN);
}

export function countTokens(text, model) {
    if (!text) return 0;
    const str = String(text);
    const type = resolveTokenizerType(model);

    if (type.backend === 'tiktoken') return countWithTiktoken(str, type.encoding);
    if (type.backend === 'spp') {
        const spp = sppCache.get(type.name);
        return spp ? countWithSpp(str, spp) : countWithTiktoken(str, 'cl100k_base');
    }
    if (type.backend === 'web') {
        const wt = webCache.get(type.name);
        return wt ? countWithWeb(str, wt) : countWithTiktoken(str, 'cl100k_base');
    }

    return estimateTokens(str);
}

export function countMessageTokens(messages, model) {
    if (!Array.isArray(messages) || messages.length === 0) return 0;
    let total = 0;
    for (const message of messages) {
        total += MESSAGE_OVERHEAD_TOKENS;
        if (message.role) total += countTokens(message.role, model);
        if (message.content) total += countTokens(message.content, model);
        if (message.name) total += countTokens(message.name, model) + 1;
    }
    total += REPLY_PRIMING_TOKENS;
    return total;
}

export function getTokenizerForModel(model) {
    const type = resolveTokenizerType(model);
    if (type.backend === 'tiktoken') return getTiktokenEncoder(type.encoding);
    if (type.backend === 'spp') return sppCache.get(type.name) || null;
    if (type.backend === 'web') return webCache.get(type.name) || null;
    return null;
}

export async function warmupTokenizers() {
    const sppNames = Object.keys(SENTENCEPIECE_MODELS);
    const webNames = Object.keys(WEB_TOKENIZER_MODELS);

    await Promise.allSettled([
        ...sppNames.map(name => loadSpp(name)),
        ...webNames.map(name => loadWebTokenizer(name)),
    ]);

    console.log(`Tokenizers warmed up: ${sppCache.size} sentencepiece, ${webCache.size} web`);
}
