import { applyTextMacros } from './macros.js';
import { buildChatCompletionPromptMessages } from './st-pipeline/chat-completion-prompt.js';

function getCharacterData(character) {
    return character?.data || character?.raw?.data || character?.raw || character || {};
}

function normalizeEntries(worldbook) {
    const entries = worldbook?.data?.entries || worldbook?.entries || {};
    return Array.isArray(entries) ? entries : Object.values(entries);
}

function getEntryKeys(entry) {
    if (Array.isArray(entry.key)) {
        return entry.key;
    }
    if (Array.isArray(entry.keys)) {
        return entry.keys;
    }
    if (typeof entry.key === 'string') {
        return [entry.key];
    }
    return [];
}

function entryMatches(entry, recentText) {
    if (entry.disable || entry.enabled === false) {
        return false;
    }
    if (entry.constant) {
        return true;
    }

    const lowerText = recentText.toLowerCase();
    return getEntryKeys(entry).some(key => key && lowerText.includes(String(key).toLowerCase()));
}

function getCharacterName(character, data, chat) {
    return character?.name || data?.name || chat?.header?.character_name || 'Assistant';
}

function getUserName(chat) {
    return chat?.header?.user_name || 'User';
}

function getCharacterBook(character, data) {
    const book = data?.character_book || character?.raw?.data?.character_book || character?.raw?.character_book;
    if (!book) {
        return null;
    }

    return {
        id: 'character-book',
        name: book.name || `${data?.name || character?.name || 'Character'} book`,
        data: book,
    };
}

export function selectWorldInfoEntries(worldbooks, messages, input = '') {
    const recentText = [...messages.slice(-12).map(message => message.mes || ''), input].join('\n');
    const selected = [];

    for (const worldbook of worldbooks || []) {
        for (const entry of normalizeEntries(worldbook)) {
            if (entryMatches(entry, recentText)) {
                selected.push({
                    worldbook: worldbook.name || worldbook.id || 'worldbook',
                    content: entry.content || '',
                    comment: entry.comment || '',
                    position: Number(entry.position ?? entry.extensions?.position ?? 0),
                    order: Number(entry.order ?? entry.insertion_order ?? 100),
                });
            }
        }
    }

    return selected
        .filter(entry => entry.content)
        .sort((a, b) => a.order - b.order);
}

export function compilePrompt({ character, chat, worldbooks = [], preset = null, input = '' }) {
    const data = getCharacterData(character);
    const charName = getCharacterName(character, data, chat);
    const userName = getUserName(chat);
    const macroContext = {
        charName,
        userName,
        charIfNotGroup: charName,
        group: charName,
        description: data.description || '',
        personality: data.personality || '',
        scenario: data.scenario || '',
    };
    const characterBook = getCharacterBook(character, data);
    const selectedWorldInfo = selectWorldInfoEntries(
        [characterBook, ...worldbooks].filter(Boolean),
        chat.messages,
        input,
    );
    const worldInfoBefore = selectedWorldInfo
        .filter(entry => entry.position !== 1)
        .map(entry => applyTextMacros(entry.content, macroContext))
        .join('\n');
    const worldInfoAfter = selectedWorldInfo
        .filter(entry => entry.position === 1)
        .map(entry => applyTextMacros(entry.content, macroContext))
        .join('\n');
    const promptPreset = preset?.preset || preset || {};
    const messages = buildChatCompletionPromptMessages({
        preset: promptPreset,
        charDescription: applyTextMacros(data.description || '', macroContext),
        charPersonality: applyTextMacros(data.personality || '', macroContext),
        scenario: applyTextMacros(data.scenario || '', macroContext),
        systemPromptOverride: applyTextMacros(data.system_prompt || '', macroContext),
        jailbreakPromptOverride: applyTextMacros(data.post_history_instructions || '', macroContext),
        mesExample: data.mes_example || '',
        worldInfoBefore,
        worldInfoAfter,
        chatMessages: chat.messages,
        macroContext,
        namesBehavior: Number(promptPreset.names_behavior ?? promptPreset.namesBehavior ?? 0),
    });

    return {
        messages,
        selectedWorldInfo,
        preset: promptPreset,
    };
}
