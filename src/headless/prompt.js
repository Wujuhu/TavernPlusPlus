/**
 * Headless prompt compiler — full SillyTavern pipeline parity.
 *
 * Replaces the legacy simplified compiler with:
 * - Complete World Info scanning (recursive, token-budgeted, all positions)
 * - ChatCompletion token budget (messages trimmed to fit context)
 * - Full macro engine with outlet→macro integration
 * - Extension prompts (Author's Note, Persona, Depth Prompts)
 * - PromptManager prompt collection & ordering
 * - EMEntries merged into dialogue examples
 * - AN entries merged into Author's Note depth prompt
 * - squashSystemMessages for consecutive system messages
 * - continue / regenerate generation modes
 */

import { applyTextMacros, evaluateMacros } from './macros.js';
import { checkWorldInfo, world_info_position } from './st-pipeline/world-info.js';
import { countTokens, countMessageTokens } from './st-pipeline/tokenizer.js';
import { Message, MessageCollection, ChatCompletion, TokenBudgetExceededError } from './st-pipeline/chat-completion.js';
import { Prompt, PromptCollection, INJECTION_POSITION, preparePrompt, getPromptCollection } from './st-pipeline/prompt-manager.js';
import { buildChatCompletionPromptMessages, getPromptDefinitions, getPromptOrder, formatWorldInfo, buildExampleMessages, toChatHistoryMessage } from './st-pipeline/chat-completion-prompt.js';

function getCharacterData(character) {
    return character?.data || character?.raw?.data || character?.raw || character || {};
}

function getCharacterName(character, data, chat) {
    return character?.name || data?.name || chat?.header?.character_name || 'Assistant';
}

function getUserName(chat) {
    return chat?.header?.user_name || 'User';
}

function getCharacterBook(character, data) {
    const book = data?.character_book || character?.raw?.data?.character_book || character?.raw?.character_book;
    if (!book) return null;
    return {
        id: 'character-book',
        name: book.name || `${data?.name || character?.name || 'Character'} book`,
        data: book,
    };
}

/**
 * Compile a full prompt using the complete SillyTavern pipeline.
 */
export function compilePrompt({
    character,
    chat,
    worldbooks = [],
    preset = null,
    input = '',
    maxContext = 8192,
    maxResponse = 1024,
    model,
    extensionPrompts = {},
    personaDescription = '',
    worldInfoSettings = {},
    generationType = 'normal',
    useBudget = true,
    timedWorldInfo = null,
    squashSystemMessages = true,
} = {}) {
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
        persona: personaDescription || '',
        mesExamples: data.mes_example || '',
        charVersion: data.character_version || '',
        creatorcomment: data.creator_notes || '',
    };

    const macroEnv = {
        char: charName,
        user: userName,
        charIfNotGroup: charName,
        group: charName,
        description: data.description || '',
        personality: data.personality || '',
        scenario: data.scenario || '',
        persona: personaDescription || '',
        mesExamples: data.mes_example || '',
        charVersion: data.character_version || '',
        creatorNotes: data.creator_notes || '',
    };

    const macroEvalContext = {
        messages: chat.messages,
        maxContextTokens: maxContext,
        maxResponseTokens: maxResponse,
        maxPromptTokens: maxContext - maxResponse,
        input,
    };

    // === World Info: full scanning with recursion and budget ===
    const characterBook = getCharacterBook(character, data);
    const allWorldbooks = [characterBook, ...worldbooks].filter(Boolean);

    const wiResult = checkWorldInfo({
        chat: chat.messages,
        worldbooks: allWorldbooks,
        maxContext,
        settings: {
            ...worldInfoSettings,
            trigger: generationType,
        },
        macroEnv,
        input,
        model,
        timedWorldInfo,
        characterName: charName,
    });

    // Inject outlet entries into macro context so {{outlet::key}} works in prompts
    if (wiResult.outletEntries && Object.keys(wiResult.outletEntries).length > 0) {
        macroEvalContext.outletEntries = wiResult.outletEntries;
    }

    const promptPreset = preset?.preset || preset || {};

    if (useBudget) {
        return compileWithBudget({
            data, chat, charName, userName,
            macroContext, macroEnv, macroEvalContext,
            promptPreset, wiResult, maxContext, maxResponse, model,
            extensionPrompts, personaDescription, generationType, input,
            squashSystemMessages,
        });
    }

    return compileWithoutBudget({
        data, chat, charName, userName,
        macroContext, macroEnv, macroEvalContext,
        promptPreset, wiResult, input, personaDescription,
    });
}

function compileWithBudget({
    data, chat, charName, userName, macroContext, macroEnv, macroEvalContext,
    promptPreset, wiResult, maxContext, maxResponse, model,
    extensionPrompts, personaDescription, generationType, input,
    squashSystemMessages: shouldSquash,
}) {
    const chatCompletion = new ChatCompletion();
    chatCompletion.setTokenBudget(maxContext, maxResponse);
    chatCompletion.setModel(model);

    const promptDefinitions = getPromptDefinitions(promptPreset);
    const promptOrder = getPromptOrder(promptPreset);

    // Apply character card system prompt / jailbreak overrides
    const systemPromptOverride = applyTextMacros(data.system_prompt || '', macroContext);
    const jailbreakOverride = applyTextMacros(data.post_history_instructions || '', macroContext);

    if (systemPromptOverride && promptDefinitions.has('main') && promptDefinitions.get('main').forbid_overrides !== true) {
        promptDefinitions.get('main').content = systemPromptOverride;
    }
    if (jailbreakOverride && promptDefinitions.has('jailbreak') && promptDefinitions.get('jailbreak').forbid_overrides !== true) {
        promptDefinitions.get('jailbreak').content = jailbreakOverride;
    }

    // Merge WI AN entries into a combined Author's Note depth prompt
    const anTopText = wiResult.ANBeforeEntries?.join('\n') || '';
    const anBottomText = wiResult.ANAfterEntries?.join('\n') || '';

    // Build dynamic prompts from character data and world info
    const dynamicPrompts = new Map([
        ['worldInfoBefore', { role: 'system', content: formatWorldInfo(wiResult.worldInfoBefore, promptPreset.wi_format), identifier: 'worldInfoBefore' }],
        ['worldInfoAfter', { role: 'system', content: formatWorldInfo(wiResult.worldInfoAfter, promptPreset.wi_format), identifier: 'worldInfoAfter' }],
        ['charDescription', { role: 'system', content: applyTextMacros(data.description || '', macroContext), identifier: 'charDescription' }],
        ['charPersonality', {
            role: 'system',
            content: data.personality && promptPreset.personality_format
                ? evaluateMacros(promptPreset.personality_format, { ...macroEnv, personality: data.personality }, macroEvalContext)
                : applyTextMacros(data.personality || '', macroContext),
            identifier: 'charPersonality',
        }],
        ['scenario', {
            role: 'system',
            content: data.scenario && promptPreset.scenario_format
                ? evaluateMacros(promptPreset.scenario_format, { ...macroEnv, scenario: data.scenario }, macroEvalContext)
                : applyTextMacros(data.scenario || '', macroContext),
            identifier: 'scenario',
        }],
        ['personaDescription', { role: 'system', content: personaDescription || '', identifier: 'personaDescription' }],
    ]);

    // Reserve budget for reply priming
    chatCompletion.reserveBudget(3);

    try {
        // Add system prompts in order, respecting token budget
        for (const reference of promptOrder) {
            if (reference?.enabled === false) continue;
            const identifier = reference.identifier;

            if (identifier === 'dialogueExamples' || identifier === 'chatHistory') continue;

            const prompt = dynamicPrompts.get(identifier) || promptDefinitions.get(identifier);
            if (!prompt) continue;

            const content = evaluateMacros(prompt.content || '', macroEnv, macroEvalContext).trim();
            if (!content) continue;

            const msg = Message.create(prompt.role || 'system', content, identifier, model);
            const coll = new MessageCollection(identifier);
            coll.add(msg);

            if (chatCompletion.canAfford(coll)) {
                chatCompletion.add(coll, promptOrder.findIndex(r => r.identifier === identifier));
            }
        }

        // Add in-prompt extension prompts (summary, persona from extensions)
        if (extensionPrompts?.systemPrompts) {
            for (const sp of extensionPrompts.systemPrompts) {
                if (!sp.content) continue;
                const spMsg = Message.create(sp.role || 'system', sp.content, sp.identifier || 'extension', model);
                const spColl = new MessageCollection(sp.identifier || 'extension');
                spColl.add(spMsg);
                if (chatCompletion.canAfford(spColl)) {
                    chatCompletion.add(spColl);
                }
            }
        }

        // Add dialogue examples within budget, with EMEntries merged
        const examplesIndex = promptOrder.findIndex(r => r.identifier === 'dialogueExamples');
        if (examplesIndex !== -1) {
            const exRef = promptOrder[examplesIndex];
            if (exRef?.enabled !== false) {
                const examplesColl = new MessageCollection('dialogueExamples');

                // WI EMTop entries go before examples
                if (wiResult.EMEntries?.length) {
                    for (const em of wiResult.EMEntries) {
                        if (em.position === 'before' && em.content) {
                            const emMsg = Message.create('system', em.content, 'wiEMTop', model);
                            if (chatCompletion.canAfford(emMsg)) {
                                examplesColl.add(emMsg);
                            }
                        }
                    }
                }

                const examples = buildExampleMessages(data.mes_example || '', macroContext);
                for (const ex of examples) {
                    const exMsg = Message.create(ex.role || 'system', ex.content || '', 'dialogueExample', model);
                    if (ex.name) exMsg.setName(ex.name, model);
                    if (chatCompletion.canAfford(exMsg)) {
                        examplesColl.add(exMsg);
                    } else {
                        break;
                    }
                }

                // WI EMBottom entries go after examples
                if (wiResult.EMEntries?.length) {
                    for (const em of wiResult.EMEntries) {
                        if (em.position === 'after' && em.content) {
                            const emMsg = Message.create('system', em.content, 'wiEMBottom', model);
                            if (chatCompletion.canAfford(emMsg)) {
                                examplesColl.add(emMsg);
                            }
                        }
                    }
                }

                if (examplesColl.collection.length > 0) {
                    chatCompletion.add(examplesColl, examplesIndex);
                }
            }
        }

        // Add chat history from newest to oldest within budget
        const historyIndex = promptOrder.findIndex(r => r.identifier === 'chatHistory');
        if (historyIndex !== -1 && promptOrder[historyIndex]?.enabled !== false) {
            const historyColl = new MessageCollection('chatHistory');
            const namesBehavior = Number(promptPreset.names_behavior ?? promptPreset.namesBehavior ?? 0);
            const reversed = [...chat.messages].reverse();

            for (const message of reversed) {
                const mapped = toChatHistoryMessage(message, macroContext, namesBehavior);
                const histMsg = Message.create(mapped.role, mapped.content, `chatHistory-${reversed.indexOf(message)}`, model);
                if (mapped.name && namesBehavior === 1) histMsg.setName(mapped.name, model);

                if (chatCompletion.canAfford(histMsg)) {
                    historyColl.collection.unshift(histMsg);
                } else {
                    break;
                }
            }

            // Inject WI depth prompts into chat history
            if (wiResult.WIDepthEntries?.length) {
                for (const depthEntry of wiResult.WIDepthEntries) {
                    const depthContent = depthEntry.entries.join('\n');
                    if (!depthContent) continue;
                    const depthMsg = Message.create(depthEntry.role || 'system', depthContent, `wiDepth-${depthEntry.depth}`, model);
                    if (chatCompletion.canAfford(depthMsg)) {
                        const insertPos = Math.min(depthEntry.depth, historyColl.collection.length);
                        historyColl.collection.splice(historyColl.collection.length - insertPos, 0, depthMsg);
                    }
                }
            }

            // Inject Author's Note as depth prompt (default depth 4)
            const anContent = [anTopText, extensionPrompts?.authorsNote || '', anBottomText].filter(Boolean).join('\n');
            if (anContent) {
                const anDepth = extensionPrompts?.authorsNoteDepth ?? 4;
                const anMsg = Message.create('system', anContent, 'authorsNote', model);
                if (chatCompletion.canAfford(anMsg)) {
                    const insertPos = Math.min(anDepth, historyColl.collection.length);
                    historyColl.collection.splice(historyColl.collection.length - insertPos, 0, anMsg);
                }
            }

            // Inject extension depth prompts
            if (extensionPrompts?.depthPrompts) {
                for (const dp of extensionPrompts.depthPrompts) {
                    if (!dp.content) continue;
                    const dpMsg = Message.create(dp.role || 'system', dp.content, `extDepth-${dp.depth}`, model);
                    if (chatCompletion.canAfford(dpMsg)) {
                        const insertPos = Math.min(dp.depth ?? 0, historyColl.collection.length);
                        historyColl.collection.splice(historyColl.collection.length - insertPos, 0, dpMsg);
                    }
                }
            }

            // Continue mode: add [Continue] marker as last assistant message hint
            if (generationType === 'continue' && historyColl.collection.length > 0) {
                const lastMsg = historyColl.collection[historyColl.collection.length - 1];
                if (lastMsg && lastMsg.role === 'assistant') {
                    const continueNudge = promptPreset.continue_nudge_prompt || '';
                    if (continueNudge) {
                        const nudgeMsg = Message.create('system', evaluateMacros(continueNudge, macroEnv, macroEvalContext), 'continueNudge', model);
                        if (chatCompletion.canAfford(nudgeMsg)) {
                            historyColl.collection.push(nudgeMsg);
                        }
                    }
                }
            }

            if (historyColl.collection.length > 0) {
                chatCompletion.add(historyColl, historyIndex);
            }
        }
    } catch (error) {
        if (!(error instanceof TokenBudgetExceededError)) throw error;
    }

    // Squash consecutive system messages (only when preset explicitly enables it)
    if (shouldSquash && promptPreset.squash_system_messages === true) {
        chatCompletion.squashSystemMessages();
    }

    const messages = chatCompletion.getChat();
    const tokenUsage = maxContext - maxResponse - chatCompletion.getRemainingBudget();

    return {
        messages,
        selectedWorldInfo: [...(wiResult.allActivatedEntries || [])],
        preset: promptPreset,
        tokenUsage,
        wiResult,
    };
}

function compileWithoutBudget({
    data, chat, charName, userName, macroContext, macroEnv, macroEvalContext,
    promptPreset, wiResult, input, personaDescription,
}) {
    const messages = buildChatCompletionPromptMessages({
        preset: promptPreset,
        charDescription: applyTextMacros(data.description || '', macroContext),
        charPersonality: applyTextMacros(data.personality || '', macroContext),
        scenario: applyTextMacros(data.scenario || '', macroContext),
        systemPromptOverride: applyTextMacros(data.system_prompt || '', macroContext),
        jailbreakPromptOverride: applyTextMacros(data.post_history_instructions || '', macroContext),
        mesExample: data.mes_example || '',
        worldInfoBefore: wiResult.worldInfoBefore,
        worldInfoAfter: wiResult.worldInfoAfter,
        chatMessages: chat.messages,
        macroContext,
        namesBehavior: Number(promptPreset.names_behavior ?? promptPreset.namesBehavior ?? 0),
        personaDescription,
    });

    return {
        messages,
        selectedWorldInfo: [...(wiResult.allActivatedEntries || [])],
        preset: promptPreset,
        wiResult,
    };
}

// Re-export for backward compatibility
export { checkWorldInfo as selectWorldInfoEntries } from './st-pipeline/world-info.js';
