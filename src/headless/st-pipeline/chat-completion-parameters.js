import { CHAT_COMPLETION_SOURCES } from '../../constants.js';

const OPENAI_MAX_STOP_STRINGS = 4;

const GPT_SOURCES = new Set([
    CHAT_COMPLETION_SOURCES.OPENAI,
    CHAT_COMPLETION_SOURCES.AZURE_OPENAI,
    CHAT_COMPLETION_SOURCES.OPENROUTER,
]);

const SEED_SUPPORTED_SOURCES = new Set([
    CHAT_COMPLETION_SOURCES.OPENAI,
    CHAT_COMPLETION_SOURCES.AZURE_OPENAI,
    CHAT_COMPLETION_SOURCES.OPENROUTER,
    CHAT_COMPLETION_SOURCES.MISTRALAI,
    CHAT_COMPLETION_SOURCES.CUSTOM,
    CHAT_COMPLETION_SOURCES.COHERE,
    CHAT_COMPLETION_SOURCES.GROQ,
    CHAT_COMPLETION_SOURCES.ELECTRONHUB,
    CHAT_COMPLETION_SOURCES.NANOGPT,
    CHAT_COMPLETION_SOURCES.XAI,
    CHAT_COMPLETION_SOURCES.POLLINATIONS,
    CHAT_COMPLETION_SOURCES.AIMLAPI,
    CHAT_COMPLETION_SOURCES.VERTEXAI,
    CHAT_COMPLETION_SOURCES.MAKERSUITE,
    CHAT_COMPLETION_SOURCES.CHUTES,
]);

const MULTISWIPE_SOURCES = new Set([
    CHAT_COMPLETION_SOURCES.OPENAI,
    CHAT_COMPLETION_SOURCES.AZURE_OPENAI,
    CHAT_COMPLETION_SOURCES.CUSTOM,
    CHAT_COMPLETION_SOURCES.XAI,
    CHAT_COMPLETION_SOURCES.AIMLAPI,
    CHAT_COMPLETION_SOURCES.MOONSHOT,
]);

const EXTERNAL_OPENAI_COMPATIBLE_KEYS = [
    'model',
    'messages',
    'temperature',
    'frequency_penalty',
    'presence_penalty',
    'top_p',
    'max_tokens',
    'max_completion_tokens',
    'stream',
    'logit_bias',
    'stop',
    'n',
    'seed',
    'logprobs',
    'top_k',
    'min_p',
    'repetition_penalty',
    'top_a',
    'safe_prompt',
];

function setting(settings, internalKey, presetKey, fallback) {
    return settings?.[internalKey] ?? settings?.[presetKey] ?? fallback;
}

function numberSetting(settings, internalKey, presetKey, fallback) {
    const value = setting(settings, internalKey, presetKey, fallback);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanSetting(settings, internalKey, presetKey, fallback) {
    return Boolean(setting(settings, internalKey, presetKey, fallback));
}

function customStoppingStrings(settings, limit = OPENAI_MAX_STOP_STRINGS) {
    const stop = settings?.stop ?? settings?.custom_stopping_strings ?? settings?.customStoppingStrings ?? [];
    if (!Array.isArray(stop)) {
        return [];
    }

    return stop.slice(0, limit).filter(item => typeof item === 'string' && item.length > 0);
}

function getReasoningEffort(settings) {
    return settings?.reasoning_effort === 'auto' ? undefined : settings?.reasoning_effort;
}

function getVerbosity(settings) {
    return settings?.verbosity === 'auto' ? undefined : settings?.verbosity;
}

function isVisionModel(model) {
    return ['gpt', 'vision'].every(part => typeof model === 'string' && model.includes(part));
}

export function normalizeChatCompletionSettings(settings = {}) {
    return {
        ...settings,
        chat_completion_source: setting(settings, 'chat_completion_source', 'chatCompletionSource', CHAT_COMPLETION_SOURCES.CUSTOM),
        temp_openai: numberSetting(settings, 'temp_openai', 'temperature', 1),
        freq_pen_openai: numberSetting(settings, 'freq_pen_openai', 'frequency_penalty', 0),
        pres_pen_openai: numberSetting(settings, 'pres_pen_openai', 'presence_penalty', 0),
        top_p_openai: numberSetting(settings, 'top_p_openai', 'top_p', 1),
        top_k_openai: numberSetting(settings, 'top_k_openai', 'top_k', 0),
        top_a_openai: numberSetting(settings, 'top_a_openai', 'top_a', 0),
        min_p_openai: numberSetting(settings, 'min_p_openai', 'min_p', 0),
        repetition_penalty_openai: numberSetting(settings, 'repetition_penalty_openai', 'repetition_penalty', 1),
        openai_max_tokens: numberSetting(settings, 'openai_max_tokens', 'max_tokens', 300),
        stream_openai: booleanSetting(settings, 'stream_openai', 'stream', true),
        show_thoughts: booleanSetting(settings, 'show_thoughts', 'include_reasoning', false),
        n: numberSetting(settings, 'n', 'n', 1),
        seed: numberSetting(settings, 'seed', 'seed', -1),
    };
}

// Ported from public/scripts/openai.js:createGenerationParameters for the
// provider-neutral chat-completion request fields used by headless generation.
export function createChatCompletionGenerationData({
    settings,
    model,
    type = 'normal',
    messages,
    userName = 'User',
    charName = 'Assistant',
    groupNames = [],
    jsonSchema = null,
} = {}) {
    if (!Array.isArray(messages)) {
        throw new Error('messages must be an array');
    }

    const normalized = normalizeChatCompletionSettings(settings);
    const filteredMessages = messages.filter(message => message && typeof message === 'object');
    const stream = normalized.stream_openai && type !== 'quiet';
    const noMultiSwipeTypes = ['quiet', 'impersonate', 'continue'];
    const canMultiSwipe = normalized.n > 1 && !noMultiSwipeTypes.includes(type) && MULTISWIPE_SOURCES.has(normalized.chat_completion_source);

    const generateData = {
        type,
        messages: filteredMessages,
        model,
        temperature: Number(normalized.temp_openai),
        frequency_penalty: Number(normalized.freq_pen_openai),
        presence_penalty: Number(normalized.pres_pen_openai),
        top_p: Number(normalized.top_p_openai),
        max_tokens: normalized.openai_max_tokens,
        stream,
        logit_bias: normalized.logit_bias,
        stop: customStoppingStrings(normalized, OPENAI_MAX_STOP_STRINGS),
        chat_completion_source: normalized.chat_completion_source,
        n: canMultiSwipe ? normalized.n : undefined,
        user_name: userName,
        char_name: charName,
        group_names: groupNames,
        include_reasoning: Boolean(normalized.show_thoughts),
        reasoning_effort: getReasoningEffort(normalized),
        enable_web_search: Boolean(normalized.enable_web_search),
        request_images: Boolean(normalized.request_images),
        request_image_resolution: String(normalized.request_image_resolution ?? ''),
        request_image_aspect_ratio: String(normalized.request_image_aspect_ratio ?? ''),
        custom_prompt_post_processing: normalized.custom_prompt_post_processing,
        verbosity: getVerbosity(normalized),
    };

    if (!Array.isArray(generateData.stop) || !generateData.stop.length) {
        delete generateData.stop;
    }

    if (GPT_SOURCES.has(normalized.chat_completion_source) && isVisionModel(model)) {
        delete generateData.logit_bias;
        delete generateData.stop;
        delete generateData.logprobs;
    }
    if (GPT_SOURCES.has(normalized.chat_completion_source) && /gpt-4.5/.test(model)) {
        delete generateData.logprobs;
    }

    if (normalized.chat_completion_source === CHAT_COMPLETION_SOURCES.CLAUDE) {
        generateData.top_k = Number(normalized.top_k_openai);
        generateData.use_sysprompt = normalized.use_sysprompt;
        generateData.stop = customStoppingStrings(normalized);
        if (type !== 'quiet' && !(type === 'continue' && normalized.continue_prefill)) {
            generateData.assistant_prefill = type === 'impersonate'
                ? normalized.assistant_impersonation
                : normalized.assistant_prefill;
        }
    }

    if (normalized.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENROUTER) {
        generateData.top_k = Number(normalized.top_k_openai);
        generateData.min_p = Number(normalized.min_p_openai);
        generateData.repetition_penalty = Number(normalized.repetition_penalty_openai);
        generateData.top_a = Number(normalized.top_a_openai);
        generateData.use_fallback = normalized.openrouter_use_fallback;
        generateData.provider = normalized.openrouter_providers;
        generateData.quantizations = normalized.openrouter_quantizations;
        generateData.allow_fallbacks = normalized.openrouter_allow_fallbacks;
        generateData.middleout = normalized.openrouter_middleout;
    }

    if ([CHAT_COMPLETION_SOURCES.MAKERSUITE, CHAT_COMPLETION_SOURCES.VERTEXAI].includes(normalized.chat_completion_source)) {
        const stopStringsLimit = 5;
        generateData.top_k = Number(normalized.top_k_openai);
        generateData.stop = customStoppingStrings(normalized, stopStringsLimit).slice(0, stopStringsLimit).filter(item => item.length >= 1 && item.length <= 16);
        generateData.use_sysprompt = normalized.use_sysprompt;
    }

    if (normalized.chat_completion_source === CHAT_COMPLETION_SOURCES.MISTRALAI) {
        generateData.safe_prompt = false;
        generateData.stop = customStoppingStrings(normalized);
    }

    if (normalized.chat_completion_source === CHAT_COMPLETION_SOURCES.CUSTOM) {
        generateData.custom_url = normalized.custom_url;
        generateData.custom_include_body = normalized.custom_include_body;
        generateData.custom_exclude_body = normalized.custom_exclude_body;
        generateData.custom_include_headers = normalized.custom_include_headers;
    }

    if (normalized.chat_completion_source === CHAT_COMPLETION_SOURCES.COHERE) {
        generateData.top_p = Math.min(Math.max(Number(normalized.top_p_openai), 0.01), 0.99);
        generateData.top_k = Number(normalized.top_k_openai);
        generateData.frequency_penalty = Math.min(Math.max(Number(normalized.freq_pen_openai), 0), 1);
        generateData.presence_penalty = Math.min(Math.max(Number(normalized.pres_pen_openai), 0), 1);
        generateData.stop = customStoppingStrings(normalized, 5);
    }

    if (normalized.chat_completion_source === CHAT_COMPLETION_SOURCES.PERPLEXITY) {
        generateData.top_k = Number(normalized.top_k_openai);
        generateData.frequency_penalty = Number(normalized.freq_pen_openai);
        generateData.presence_penalty = Number(normalized.pres_pen_openai);
        delete generateData.stop;
    }

    if (normalized.chat_completion_source === CHAT_COMPLETION_SOURCES.GROQ) {
        delete generateData.logprobs;
        delete generateData.logit_bias;
        delete generateData.top_logprobs;
        delete generateData.n;
    }

    if (normalized.chat_completion_source === CHAT_COMPLETION_SOURCES.DEEPSEEK) {
        generateData.top_p ||= Number.EPSILON;
    }

    if (normalized.chat_completion_source === CHAT_COMPLETION_SOURCES.XAI) {
        if (model.includes('grok-3-mini')) {
            delete generateData.presence_penalty;
            delete generateData.frequency_penalty;
            delete generateData.stop;
        } else {
            delete generateData.reasoning_effort;
        }

        if (model.includes('grok-4') || model.includes('grok-code')) {
            delete generateData.presence_penalty;
            delete generateData.frequency_penalty;
            if (!model.includes('grok-4-fast-non-reasoning')) {
                delete generateData.stop;
            }
        }
    }

    if (normalized.chat_completion_source === CHAT_COMPLETION_SOURCES.ELECTRONHUB) {
        generateData.top_k = Number(normalized.top_k_openai);
    }

    if (normalized.chat_completion_source === CHAT_COMPLETION_SOURCES.CHUTES) {
        generateData.min_p = Number(normalized.min_p_openai);
        generateData.top_k = normalized.top_k_openai > 0 ? Number(normalized.top_k_openai) : undefined;
        generateData.repetition_penalty = Number(normalized.repetition_penalty_openai);
        generateData.stop = customStoppingStrings(normalized);
    }

    if (normalized.chat_completion_source === CHAT_COMPLETION_SOURCES.ZAI) {
        generateData.top_p ||= 0.01;
        generateData.stop = customStoppingStrings(normalized, 1);
        generateData.zai_endpoint = normalized.zai_endpoint;
        delete generateData.presence_penalty;
        delete generateData.frequency_penalty;
    }

    if (normalized.chat_completion_source === CHAT_COMPLETION_SOURCES.SILICONFLOW) {
        generateData.siliconflow_endpoint = normalized.siliconflow_endpoint;
    }

    if (normalized.chat_completion_source === CHAT_COMPLETION_SOURCES.MINIMAX) {
        generateData.minimax_endpoint = normalized.minimax_endpoint;
        if (Number.isFinite(generateData.temperature)) {
            generateData.temperature = Math.min(Math.max(generateData.temperature, Number.EPSILON), 1);
        }
    }

    if (normalized.chat_completion_source === CHAT_COMPLETION_SOURCES.WORKERS_AI) {
        generateData.workers_ai_account_id = normalized.workers_ai_account_id;
        generateData.top_k = normalized.top_k_openai > 0 ? Math.min(Number(normalized.top_k_openai), 50) : undefined;
        generateData.repetition_penalty = Number(normalized.repetition_penalty_openai);
        generateData.seed = normalized.seed >= 1 ? Number(normalized.seed) : undefined;
        generateData.top_p = Math.max(Number(normalized.top_p_openai), 0.001);
        delete generateData.n;
        delete generateData.logit_bias;
    }

    if (normalized.chat_completion_source === CHAT_COMPLETION_SOURCES.NANOGPT) {
        generateData.top_k = Number(normalized.top_k_openai);
        generateData.min_p = Number(normalized.min_p_openai);
        generateData.repetition_penalty = Number(normalized.repetition_penalty_openai);
        generateData.top_a = Number(normalized.top_a_openai);
    }

    if (normalized.chat_completion_source === CHAT_COMPLETION_SOURCES.MOONSHOT && /kimi-k2.5/.test(model)) {
        delete generateData.temperature;
        delete generateData.top_p;
        delete generateData.frequency_penalty;
        delete generateData.presence_penalty;
    }

    if (SEED_SUPPORTED_SOURCES.has(normalized.chat_completion_source) && normalized.seed >= 0) {
        generateData.seed = normalized.seed;
    }

    if ([CHAT_COMPLETION_SOURCES.OPENAI, CHAT_COMPLETION_SOURCES.AZURE_OPENAI].includes(normalized.chat_completion_source) && /^(o1|o3|o4)/.test(model) ||
        (CHAT_COMPLETION_SOURCES.OPENROUTER === normalized.chat_completion_source && /^openai\/(o1|o3|o4)/.test(model))) {
        generateData.max_completion_tokens = generateData.max_tokens;
        delete generateData.max_tokens;
        delete generateData.logprobs;
        delete generateData.top_logprobs;
        delete generateData.stop;
        delete generateData.logit_bias;
        delete generateData.temperature;
        delete generateData.top_p;
        delete generateData.frequency_penalty;
        delete generateData.presence_penalty;
        if (/^(openai\/)?(o1)/.test(model)) {
            generateData.messages.forEach(message => {
                if (message.role === 'system') {
                    message.role = 'user';
                }
            });
            delete generateData.n;
            delete generateData.tools;
            delete generateData.tool_choice;
        }
    }

    if (GPT_SOURCES.has(normalized.chat_completion_source) && /gpt-5/.test(model)) {
        generateData.max_completion_tokens = generateData.max_tokens;
        delete generateData.max_tokens;
        delete generateData.logprobs;
        delete generateData.top_logprobs;
        if (/gpt-5-chat-latest/.test(model)) {
            delete generateData.tools;
            delete generateData.tool_choice;
        } else if (/gpt-5\.(1|2|3|4)/.test(model) && !/chat-latest/.test(model) && !generateData.reasoning_effort) {
            delete generateData.frequency_penalty;
            delete generateData.presence_penalty;
            delete generateData.logit_bias;
            delete generateData.stop;
        } else {
            delete generateData.temperature;
            delete generateData.top_p;
            delete generateData.frequency_penalty;
            delete generateData.presence_penalty;
            delete generateData.logit_bias;
            delete generateData.stop;
        }
    }

    if (jsonSchema) {
        generateData.json_schema = jsonSchema;
    }

    return { generateData, stream, canMultiSwipe };
}

export function createOpenAiCompatibleRequestBody(generateData, extraParameters = {}) {
    const body = {};

    for (const key of EXTERNAL_OPENAI_COMPATIBLE_KEYS) {
        if (generateData[key] !== undefined) {
            body[key] = generateData[key];
        }
    }

    if (!Array.isArray(body.stop) || body.stop.length === 0) {
        delete body.stop;
    }

    return {
        ...body,
        ...(extraParameters || {}),
    };
}
