/**
 * Headless macro engine — server-side port of SillyTavern's substituteParams / evaluateMacros.
 * Supports all macros that don't require browser DOM or live UI state.
 */

function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function diceRoll(formula) {
    const match = String(formula).match(/^(\d+)?d(\d+)([+-]\d+)?$/i);
    if (!match) {
        const n = Number(formula);
        if (Number.isInteger(n) && n > 0) {
            return Math.floor(Math.random() * n) + 1;
        }
        return 0;
    }
    const count = parseInt(match[1] || '1', 10);
    const sides = parseInt(match[2], 10);
    const mod = parseInt(match[3] || '0', 10);
    let total = mod;
    for (let i = 0; i < count; i++) {
        total += Math.floor(Math.random() * sides) + 1;
    }
    return total;
}

function pickRandom(options) {
    if (!options.length) return '';
    return options[Math.floor(Math.random() * options.length)];
}

function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return Math.abs(hash);
}

function pickDeterministic(options, seed) {
    if (!options.length) return '';
    const index = simpleHash(seed) % options.length;
    return options[index];
}

function formatTime(offset) {
    const now = new Date();
    if (offset !== undefined) {
        const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
        const target = new Date(utcMs + Number(offset) * 3600000);
        return target.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate() {
    return new Date().toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatWeekday() {
    return new Date().toLocaleDateString([], { weekday: 'long' });
}

function formatIsoTime() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function formatIsoDate() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function formatDatetime(format) {
    const now = new Date();
    return String(format)
        .replace(/YYYY/g, String(now.getFullYear()))
        .replace(/YY/g, String(now.getFullYear()).slice(-2))
        .replace(/MMMM/g, now.toLocaleDateString([], { month: 'long' }))
        .replace(/MMM/g, now.toLocaleDateString([], { month: 'short' }))
        .replace(/MM/g, String(now.getMonth() + 1).padStart(2, '0'))
        .replace(/DD/g, String(now.getDate()).padStart(2, '0'))
        .replace(/dddd/g, now.toLocaleDateString([], { weekday: 'long' }))
        .replace(/ddd/g, now.toLocaleDateString([], { weekday: 'short' }))
        .replace(/HH/g, String(now.getHours()).padStart(2, '0'))
        .replace(/hh/g, String(now.getHours() % 12 || 12).padStart(2, '0'))
        .replace(/mm/g, String(now.getMinutes()).padStart(2, '0'))
        .replace(/ss/g, String(now.getSeconds()).padStart(2, '0'))
        .replace(/A/g, now.getHours() >= 12 ? 'PM' : 'AM')
        .replace(/a/g, now.getHours() >= 12 ? 'pm' : 'am');
}

function getLastMessage(messages) {
    if (!messages?.length) return '';
    return messages[messages.length - 1]?.mes || '';
}

function getLastUserMessage(messages) {
    if (!messages?.length) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.is_user) return messages[i].mes || '';
    }
    return '';
}

function getLastCharMessage(messages) {
    if (!messages?.length) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
        if (!messages[i]?.is_user) return messages[i].mes || '';
    }
    return '';
}

function getTimeSinceLastMessage(messages) {
    if (!messages?.length) return '';
    const last = messages[messages.length - 1];
    const sendDate = last?.send_date;
    if (!sendDate) return '';
    const then = new Date(sendDate);
    if (isNaN(then.getTime())) return '';
    const diff = Date.now() - then.getTime();
    if (diff < 0) return '0 seconds';
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${seconds} second${seconds !== 1 ? 's' : ''}`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''}`;
    const days = Math.floor(hours / 24);
    return `${days} day${days !== 1 ? 's' : ''}`;
}

/**
 * Full macro expansion engine for headless mode.
 * @param {string} content - Text to process
 * @param {object} env - Environment variables for substitution
 * @param {object} [context] - Additional context (messages array, outlet entries, etc.)
 * @returns {string}
 */
export function evaluateMacros(content, env = {}, context = {}) {
    if (!content) return '';
    let text = String(content);
    const rawContent = text;
    const messages = context.messages || [];
    const outletEntries = context.outletEntries || {};

    // === Legacy non-curly macros ===
    const legacyReplacements = [
        [/<USER>/gi, () => env.user || 'User'],
        [/<BOT>/gi, () => env.char || 'Assistant'],
        [/<CHAR>/gi, () => env.char || 'Assistant'],
        [/<CHARIFNOTGROUP>/gi, () => env.charIfNotGroup || env.char || 'Assistant'],
        [/<GROUP>/gi, () => env.group || env.char || 'Assistant'],
    ];

    for (const [regex, replacer] of legacyReplacements) {
        text = text.replace(regex, replacer);
    }

    // === Pre-env built-in macros ===
    // Dice rolls
    text = text.replace(/\{\{roll[: ]([^}]+)\}\}/gi, (_, formula) => String(diceRoll(formula.trim())));

    // Control macros
    text = text.replace(/\{\{newline\}\}/gi, '\n');
    text = text.replace(/(?:\r?\n)*\{\{trim\}\}(?:\r?\n)*/gi, '');
    text = text.replace(/\{\{noop\}\}/gi, '');
    text = text.replace(/\{\{input\}\}/gi, context.input || '');

    // === Environment variables ===
    const envLower = {};
    for (const key in env) {
        if (Object.hasOwn(env, key)) {
            envLower[key.toLowerCase()] = env[key];
        }
    }

    // Common aliases
    const aliases = {
        'charifnotgroup': envLower.charifnotgroup || envLower.char || '',
        'group': envLower.group || envLower.char || '',
    };
    Object.assign(envLower, aliases);

    for (const varName in envLower) {
        if (!Object.hasOwn(envLower, varName)) continue;
        const value = envLower[varName];
        if (value === undefined || value === null) continue;
        const envRegex = new RegExp(`\\{\\{${escapeRegex(varName)}\\}\\}`, 'gi');
        text = text.replace(envRegex, () => String(typeof value === 'function' ? value() : value));
    }

    // === Post-env built-in macros ===

    // Chat state macros
    text = text.replace(/\{\{lastMessage\}\}/gi, () => getLastMessage(messages));
    text = text.replace(/\{\{lastMessageId\}\}/gi, () => {
        for (let i = messages.length - 1; i >= 0; i--) {
            if (!messages[i]?.is_system) return String(i);
        }
        return '';
    });
    text = text.replace(/\{\{lastUserMessage\}\}/gi, () => getLastUserMessage(messages));
    text = text.replace(/\{\{lastCharMessage\}\}/gi, () => getLastCharMessage(messages));
    text = text.replace(/\{\{firstIncludedMessageId\}\}/gi, () => {
        return String(context.firstIncludedMessageId ?? 0);
    });
    text = text.replace(/\{\{firstDisplayedMessageId\}\}/gi, () => messages.length ? '0' : '');
    text = text.replace(/\{\{lastSwipeId\}\}/gi, '');
    text = text.replace(/\{\{currentSwipeId\}\}/gi, '');
    text = text.replace(/\{\{allChatRange\}\}/gi, () => messages.length === 0 ? '' : `0-${messages.length - 1}`);

    // Text manipulation
    text = text.replace(/\{\{reverse:(.+?)\}\}/gi, (_, str) => Array.from(str).reverse().join(''));

    // Comments
    text = text.replace(/\{\{\/\/([\s\S]*?)\}\}/gm, '');

    // Time/date macros
    text = text.replace(/\{\{time\}\}/gi, () => formatTime());
    text = text.replace(/\{\{date\}\}/gi, () => formatDate());
    text = text.replace(/\{\{weekday\}\}/gi, () => formatWeekday());
    text = text.replace(/\{\{isotime\}\}/gi, () => formatIsoTime());
    text = text.replace(/\{\{isodate\}\}/gi, () => formatIsoDate());
    text = text.replace(/\{\{datetimeformat +([^}]*)\}\}/gi, (_, format) => formatDatetime(format));
    text = text.replace(/\{\{idle_duration\}\}/gi, () => getTimeSinceLastMessage(messages));
    text = text.replace(/\{\{time_UTC([-+]\d+)\}\}/gi, (_, offset) => formatTime(parseInt(offset, 10)));

    // Outlet macro
    text = text.replace(/\{\{outlet::(.+?)\}\}/gi, (_, key) => {
        const entries = outletEntries[key.trim()];
        return Array.isArray(entries) ? entries.join('\n') : '';
    });

    // Random macros
    text = text.replace(/\{\{random\s*::\s*([^}]+)\}\}/gi, (_, opts) => {
        const options = opts.split('::').map(s => s.trim()).filter(Boolean);
        return pickRandom(options);
    });
    text = text.replace(/\{\{random\s*,\s*([^}]+)\}\}/gi, (_, opts) => {
        const options = opts.split(',').map(s => s.trim()).filter(Boolean);
        return pickRandom(options);
    });
    text = text.replace(/\{\{random\}\}/gi, () => String(Math.floor(Math.random() * 100)));

    // Pick macro (deterministic by position using hash for reproducibility)
    let pickIndex = 0;
    text = text.replace(/\{\{pick\s*::\s*([^}]+)\}\}/gi, (match, opts) => {
        const options = opts.split('::').map(s => s.trim()).filter(Boolean);
        const seed = `${context.chatIdHash || 'default'}_${match}_${pickIndex++}`;
        return pickDeterministic(options, seed);
    });

    // Chat variable macros
    const chatVars = context.chatVariables || new Map();
    const globalVars = context.globalVariables || new Map();

    text = text.replace(/\{\{getvar::([^}]+)\}\}/gi, (_, key) => {
        return chatVars.get(key.trim()) ?? '';
    });
    text = text.replace(/\{\{setvar::([^:}]+)::([^}]*)\}\}/gi, (_, key, value) => {
        chatVars.set(key.trim(), value);
        return '';
    });
    text = text.replace(/\{\{addvar::([^:}]+)::([^}]*)\}\}/gi, (_, key, value) => {
        const current = Number(chatVars.get(key.trim()) || 0);
        chatVars.set(key.trim(), String(current + Number(value)));
        return '';
    });
    text = text.replace(/\{\{incvar::([^}]+)\}\}/gi, (_, key) => {
        const current = Number(chatVars.get(key.trim()) || 0);
        const next = current + 1;
        chatVars.set(key.trim(), String(next));
        return String(next);
    });
    text = text.replace(/\{\{decvar::([^}]+)\}\}/gi, (_, key) => {
        const current = Number(chatVars.get(key.trim()) || 0);
        const next = current - 1;
        chatVars.set(key.trim(), String(next));
        return String(next);
    });
    text = text.replace(/\{\{getglobalvar::([^}]+)\}\}/gi, (_, key) => {
        return globalVars.get(key.trim()) ?? '';
    });
    text = text.replace(/\{\{setglobalvar::([^:}]+)::([^}]*)\}\}/gi, (_, key, value) => {
        globalVars.set(key.trim(), value);
        return '';
    });

    // Token context macros (filled by caller or use defaults)
    text = text.replace(/\{\{maxPrompt(?:Tokens)?\}\}/gi, () => String(context.maxPromptTokens || 0));
    text = text.replace(/\{\{maxContext(?:Tokens)?\}\}/gi, () => String(context.maxContextTokens || 0));
    text = text.replace(/\{\{maxResponse(?:Tokens)?\}\}/gi, () => String(context.maxResponseTokens || 0));

    // Banned words macro (headless doesn't have a banned words list, return empty)
    text = text.replace(/\{\{banned\s*"([^"]*)"\}\}/gi, '');
    text = text.replace(/\{\{banned_words\}\}/gi, '');

    // Conditional macros: {{if::varname}}...{{else}}...{{/if}}
    const MAX_IF_ITERATIONS = 50;
    for (let i = 0; i < MAX_IF_ITERATIONS; i++) {
        const ifMatch = text.match(/\{\{if::([^}]+)\}\}([\s\S]*?)\{\{\/if\}\}/i);
        if (!ifMatch) break;

        const varName = ifMatch[1].trim();
        const body = ifMatch[2];
        const elseParts = body.split(/\{\{else\}\}/i);
        const trueBranch = elseParts[0] || '';
        const falseBranch = elseParts[1] || '';

        const value = chatVars.get(varName) ?? env[varName?.toLowerCase()] ?? '';
        const isTruthy = value !== '' && value !== '0' && value !== 'false' && value !== undefined && value !== null;
        text = text.replace(ifMatch[0], isTruthy ? trueBranch : falseBranch);
    }

    return text;
}

/**
 * Backward-compatible simple macro replacement (the old applyTextMacros API).
 * Now delegates to the full evaluateMacros engine.
 * @param {string} text
 * @param {object} macroContext - { charName, userName, charIfNotGroup, group, description, personality, scenario, messages, ... }
 * @returns {string}
 */
export function applyTextMacros(text, macroContext = {}) {
    const {
        charName = 'Assistant',
        userName = 'User',
        charIfNotGroup = charName,
        group = '',
        messages,
        outletEntries,
        maxPromptTokens,
        maxContextTokens,
        maxResponseTokens,
        input,
        ...rest
    } = macroContext;

    const env = {
        char: charName,
        user: userName,
        charIfNotGroup: charIfNotGroup || charName,
        group: group || charName,
        ...rest,
    };

    return evaluateMacros(text, env, {
        messages,
        outletEntries,
        maxPromptTokens,
        maxContextTokens,
        maxResponseTokens,
        input,
    });
}
