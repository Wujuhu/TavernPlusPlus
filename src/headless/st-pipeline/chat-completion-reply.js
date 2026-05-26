import { CHAT_COMPLETION_SOURCES } from '../../constants.js';

const GOOGLE_SOURCES = new Set([
    CHAT_COMPLETION_SOURCES.MAKERSUITE,
    CHAT_COMPLETION_SOURCES.VERTEXAI,
]);

const OPENAI_COMPATIBLE_SOURCES = new Set([
    CHAT_COMPLETION_SOURCES.CUSTOM,
    CHAT_COMPLETION_SOURCES.POLLINATIONS,
    CHAT_COMPLETION_SOURCES.AIMLAPI,
    CHAT_COMPLETION_SOURCES.MOONSHOT,
    CHAT_COMPLETION_SOURCES.COMETAPI,
    CHAT_COMPLETION_SOURCES.ELECTRONHUB,
    CHAT_COMPLETION_SOURCES.NANOGPT,
    CHAT_COMPLETION_SOURCES.ZAI,
    CHAT_COMPLETION_SOURCES.SILICONFLOW,
    CHAT_COMPLETION_SOURCES.CHUTES,
    CHAT_COMPLETION_SOURCES.WORKERS_AI,
]);

function isDataURL(value) {
    return typeof value === 'string' && /^data:[^;]+;base64,/i.test(value);
}

export function createStreamingReplyState() {
    return {
        reasoning: '',
        images: [],
        signature: '',
        toolSignatures: {},
    };
}

function normalizeState(state) {
    if (!state) {
        return createStreamingReplyState();
    }

    state.reasoning ??= '';
    state.images ??= [];
    state.signature ??= '';
    state.toolSignatures ??= {};
    return state;
}

// Ported from public/scripts/openai.js:getStreamingReply so headless uses the
// same provider-specific response extraction rules as the SillyTavern Web UI.
export function getStreamingReply(data, state, { chatCompletionSource = CHAT_COMPLETION_SOURCES.CUSTOM, overrideShowThoughts = null } = {}) {
    const replyState = normalizeState(state);
    const showThoughts = overrideShowThoughts ?? false;

    if (chatCompletionSource === CHAT_COMPLETION_SOURCES.CLAUDE) {
        if (showThoughts) {
            replyState.reasoning += data?.delta?.thinking || '';
        }
        return data?.delta?.text || '';
    } else if (GOOGLE_SOURCES.has(chatCompletionSource)) {
        const inlineData = data?.candidates?.[0]?.content?.parts?.filter(x => x.inlineData && !x.thought)?.map(x => x.inlineData) || [];
        if (Array.isArray(inlineData) && inlineData.length > 0) {
            replyState.images.push(...inlineData.map(x => `data:${x.mimeType};base64,${x.data}`).filter(isDataURL));
        }
        if (showThoughts) {
            replyState.reasoning += data?.candidates?.[0]?.content?.parts?.filter(x => x.thought)?.map(x => x.text)?.[0] || '';
        }
        const parts = data?.candidates?.[0]?.content?.parts || [];
        parts.forEach(part => {
            if (part.thoughtSignature && typeof part.text === 'string') {
                replyState.signature = part.thoughtSignature;
            }
        });
        return data?.candidates?.[0]?.content?.parts?.filter(x => !x.thought)?.map(x => x.text)?.[0] || '';
    } else if (chatCompletionSource === CHAT_COMPLETION_SOURCES.COHERE) {
        return data?.delta?.message?.content?.text || data?.delta?.message?.tool_plan || '';
    } else if (chatCompletionSource === CHAT_COMPLETION_SOURCES.DEEPSEEK) {
        if (showThoughts) {
            replyState.reasoning += data.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content || '';
        }
        return data.choices?.[0]?.delta?.content || '';
    } else if (chatCompletionSource === CHAT_COMPLETION_SOURCES.XAI) {
        if (showThoughts) {
            replyState.reasoning += data.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content || '';
        }
        return data.choices?.[0]?.delta?.content || '';
    } else if (chatCompletionSource === CHAT_COMPLETION_SOURCES.OPENROUTER) {
        const imageUrls = data?.choices?.[0]?.delta?.images?.filter(x => x.type === 'image_url')?.map(x => x?.image_url?.url) || [];
        if (Array.isArray(imageUrls) && imageUrls.length > 0) {
            replyState.images.push(...imageUrls.filter(isDataURL));
        }
        if (showThoughts) {
            replyState.reasoning += data.choices?.filter(x => x?.delta?.reasoning)?.[0]?.delta?.reasoning ??
                data.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content ??
                data.choices?.filter(x => x?.message?.reasoning)?.[0]?.message?.reasoning ??
                data.choices?.filter(x => x?.message?.reasoning_content)?.[0]?.message?.reasoning_content ??
                '';
        }
        const reasoningDetails = [
            ...(data?.choices?.[0]?.delta?.reasoning_details || []),
            ...(data?.choices?.[0]?.message?.reasoning_details || []),
        ];
        reasoningDetails.forEach(detail => {
            if (detail.type === 'reasoning.encrypted' && detail.data) {
                const isToolLikeId = typeof detail.id === 'string' && /^(tool_|call_)/.test(detail.id);
                if (typeof detail.id === 'string' && detail.id.length > 0) {
                    replyState.toolSignatures[detail.id] = detail.data;
                }
                if (!isToolLikeId) {
                    replyState.signature = detail.data;
                }
            }
        });
        return data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
    } else if (OPENAI_COMPATIBLE_SOURCES.has(chatCompletionSource)) {
        if (showThoughts) {
            replyState.reasoning += data.choices?.filter(x => x?.delta?.reasoning_content)?.[0]?.delta?.reasoning_content ??
                data.choices?.filter(x => x?.delta?.reasoning)?.[0]?.delta?.reasoning ??
                '';
        }
        return data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
    } else if (chatCompletionSource === CHAT_COMPLETION_SOURCES.MISTRALAI) {
        if (showThoughts) {
            replyState.reasoning += data.choices?.filter(x => x?.delta?.content?.[0]?.thinking)?.[0]?.delta?.content?.[0]?.thinking?.[0]?.text || '';
        }
        const content = data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
        return Array.isArray(content) ? content.map(x => x.text).filter(x => x).join('') : content;
    } else {
        return data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
    }
}
