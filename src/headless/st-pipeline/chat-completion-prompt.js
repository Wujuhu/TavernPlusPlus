import { applyTextMacros } from '../macros.js';

const DEFAULT_CHAT_COMPLETION_PROMPTS = [
    {
        name: 'Main Prompt',
        system_prompt: true,
        role: 'system',
        content: 'Write {{char}}\'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.',
        identifier: 'main',
    },
    {
        name: 'Auxiliary Prompt',
        system_prompt: true,
        role: 'system',
        content: '',
        identifier: 'nsfw',
    },
    {
        identifier: 'dialogueExamples',
        name: 'Chat Examples',
        system_prompt: true,
        marker: true,
    },
    {
        name: 'Post-History Instructions',
        system_prompt: true,
        role: 'system',
        content: '',
        identifier: 'jailbreak',
    },
    {
        identifier: 'chatHistory',
        name: 'Chat History',
        system_prompt: true,
        marker: true,
    },
    {
        identifier: 'worldInfoAfter',
        name: 'World Info (after)',
        system_prompt: true,
        marker: true,
    },
    {
        identifier: 'worldInfoBefore',
        name: 'World Info (before)',
        system_prompt: true,
        marker: true,
    },
    {
        identifier: 'enhanceDefinitions',
        role: 'system',
        name: 'Enhance Definitions',
        content: 'If you have more knowledge of {{char}}, add to the character\'s lore and personality to enhance them but keep the Character Sheet\'s definitions absolute.',
        system_prompt: true,
        marker: false,
    },
    {
        identifier: 'charDescription',
        name: 'Char Description',
        system_prompt: true,
        marker: true,
    },
    {
        identifier: 'charPersonality',
        name: 'Char Personality',
        system_prompt: true,
        marker: true,
    },
    {
        identifier: 'scenario',
        name: 'Scenario',
        system_prompt: true,
        marker: true,
    },
    {
        identifier: 'personaDescription',
        name: 'Persona Description',
        system_prompt: true,
        marker: true,
    },
];

const DEFAULT_PROMPT_ORDER = [
    { identifier: 'main', enabled: true },
    { identifier: 'worldInfoBefore', enabled: true },
    { identifier: 'personaDescription', enabled: true },
    { identifier: 'charDescription', enabled: true },
    { identifier: 'charPersonality', enabled: true },
    { identifier: 'scenario', enabled: true },
    { identifier: 'enhanceDefinitions', enabled: false },
    { identifier: 'nsfw', enabled: true },
    { identifier: 'worldInfoAfter', enabled: true },
    { identifier: 'dialogueExamples', enabled: true },
    { identifier: 'chatHistory', enabled: true },
    { identifier: 'jailbreak', enabled: true },
];

function clone(value) {
    return structuredClone(value);
}

function getPromptDefinitions(preset = {}) {
    const prompts = new Map(DEFAULT_CHAT_COMPLETION_PROMPTS.map(prompt => [prompt.identifier, clone(prompt)]));

    for (const prompt of preset.prompts || []) {
        if (prompt?.identifier) {
            prompts.set(prompt.identifier, { ...prompts.get(prompt.identifier), ...clone(prompt) });
        }
    }

    return prompts;
}

function getPromptOrder(preset = {}) {
    const promptOrder = Array.isArray(preset.prompt_order) ? preset.prompt_order : [];
    const defaultOrder = promptOrder.find(order => String(order.character_id) === '100001')?.order ||
        promptOrder.find(order => String(order.character_id) === '100000')?.order ||
        promptOrder[0]?.order;

    return Array.isArray(defaultOrder) && defaultOrder.length > 0 ? defaultOrder : DEFAULT_PROMPT_ORDER;
}

function stringFormat(format, value) {
    return String(format || '{0}').replace(/\{0\}/g, value);
}

function formatWorldInfo(value, wiFormat = '{0}') {
    if (!value) {
        return '';
    }
    if (!String(wiFormat).trim()) {
        return value;
    }
    return stringFormat(wiFormat, value);
}

function parseMesExamples(examplesString) {
    if (!examplesString || examplesString.length === 0 || examplesString === '<START>') {
        return [];
    }

    const normalized = examplesString.startsWith('<START>') ? examplesString : `<START>\n${examplesString.trim()}`;
    return normalized.split(/<START>/gi).slice(1).map(block => `<START>\n${block.trim()}\n`);
}

function parseExampleIntoIndividual(messageExampleString, { userName, charName }) {
    const result = [];
    const lines = messageExampleString.split('\n');
    let currentLines = [];
    let inUser = false;
    let inBot = false;

    function addMessage(name, role, systemName) {
        const parsedMessage = currentLines.join('\n').replace(`${name}:`, '').trim();
        result.push({ role, content: parsedMessage, name: systemName });
        currentLines = [];
    }

    for (let index = 1; index < lines.length; index++) {
        const currentLine = lines[index];
        if (currentLine.startsWith(`${userName}:`)) {
            inUser = true;
            if (inBot) {
                addMessage(charName, 'system', 'example_assistant');
            }
            inBot = false;
        } else if (currentLine.startsWith(`${charName}:`)) {
            inBot = true;
            if (inUser) {
                addMessage(userName, 'system', 'example_user');
            }
            inUser = false;
        }
        currentLines.push(currentLine);
    }

    if (inUser) {
        addMessage(userName, 'system', 'example_user');
    } else if (inBot) {
        addMessage(charName, 'system', 'example_assistant');
    }

    return result;
}

function buildExampleMessages(mesExample, macroContext) {
    const examples = parseMesExamples(applyTextMacros(mesExample, macroContext));
    return examples.flatMap(example => parseExampleIntoIndividual(example, {
        userName: macroContext.userName,
        charName: macroContext.charName,
    }));
}

function toChatHistoryMessage(message, macroContext, namesBehavior = 0) {
    let content = applyTextMacros(message.mes || '', macroContext).replace(/\r/gm, '');
    if (namesBehavior === 2 && message.name) {
        content = `${message.name}: ${content}`;
    }

    return {
        role: message.is_user ? 'user' : 'assistant',
        content,
        ...(message.name && namesBehavior === 1 ? { name: message.name } : {}),
    };
}

export function buildChatCompletionPromptMessages({
    preset = {},
    charDescription = '',
    charPersonality = '',
    scenario = '',
    systemPromptOverride = '',
    jailbreakPromptOverride = '',
    mesExample = '',
    worldInfoBefore = '',
    worldInfoAfter = '',
    chatMessages = [],
    macroContext,
    namesBehavior = 0,
} = {}) {
    const promptDefinitions = getPromptDefinitions(preset);
    const promptOrder = getPromptOrder(preset);
    const dynamicPrompts = new Map([
        ['worldInfoBefore', { role: 'system', content: formatWorldInfo(worldInfoBefore, preset.wi_format), identifier: 'worldInfoBefore' }],
        ['worldInfoAfter', { role: 'system', content: formatWorldInfo(worldInfoAfter, preset.wi_format), identifier: 'worldInfoAfter' }],
        ['charDescription', { role: 'system', content: charDescription, identifier: 'charDescription' }],
        ['charPersonality', { role: 'system', content: charPersonality && preset.personality_format ? applyTextMacros(preset.personality_format, { ...macroContext, personality: charPersonality }) : charPersonality, identifier: 'charPersonality' }],
        ['scenario', { role: 'system', content: scenario && preset.scenario_format ? applyTextMacros(preset.scenario_format, { ...macroContext, scenario }) : scenario, identifier: 'scenario' }],
    ]);
    const messages = [];

    if (systemPromptOverride && promptDefinitions.has('main') && promptDefinitions.get('main').forbid_overrides !== true) {
        promptDefinitions.get('main').content = systemPromptOverride;
    }
    if (jailbreakPromptOverride && promptDefinitions.has('jailbreak') && promptDefinitions.get('jailbreak').forbid_overrides !== true) {
        promptDefinitions.get('jailbreak').content = jailbreakPromptOverride;
    }

    for (const reference of promptOrder) {
        if (reference?.enabled === false) {
            continue;
        }

        const identifier = reference.identifier;
        if (identifier === 'dialogueExamples') {
            messages.push(...buildExampleMessages(mesExample, macroContext));
            continue;
        }
        if (identifier === 'chatHistory') {
            messages.push(...chatMessages.map(message => toChatHistoryMessage(message, macroContext, namesBehavior)));
            continue;
        }

        const prompt = dynamicPrompts.get(identifier) || promptDefinitions.get(identifier);
        const content = applyTextMacros(prompt?.content || '', macroContext).trim();
        if (!prompt || !content) {
            continue;
        }

        messages.push({
            role: prompt.role || 'system',
            content,
        });
    }

    return messages;
}
