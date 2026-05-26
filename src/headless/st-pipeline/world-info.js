/**
 * Headless World Info engine — server-side port of SillyTavern's checkWorldInfo / getWorldInfoPrompt.
 * Replicates recursive scanning, token budgeting, keyword matching, probability, inclusion groups,
 * and all 8 injection positions.
 */

import { countTokens } from './tokenizer.js';
import { evaluateMacros } from '../macros.js';

// === Constants ===
export const world_info_position = Object.freeze({
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
    outlet: 7,
});

export const world_info_logic = Object.freeze({
    AND_ANY: 0,
    NOT_ALL: 1,
    NOT_ANY: 2,
    AND_ALL: 3,
});

const scan_state = Object.freeze({
    NONE: 0,
    INITIAL: 1,
    RECURSION: 2,
    MIN_ACTIVATIONS: 3,
});

const DEFAULT_DEPTH = 4;
const DEFAULT_SCAN_DEPTH = 2;

// === Helpers ===

function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseRegex(input) {
    const match = String(input).match(/^\/([\s\S]+?)\/([gimsuy]*)$/);
    if (!match) return null;
    try {
        return new RegExp(match[1], match[2]);
    } catch {
        return null;
    }
}

function matchKeys(textToScan, key, entry, settings) {
    if (!key || !textToScan) return false;

    const regex = parseRegex(key);
    if (regex) {
        return regex.test(textToScan);
    }

    const caseSensitive = entry.caseSensitive ?? settings.caseSensitive ?? false;
    const matchWholeWords = entry.matchWholeWords ?? settings.matchWholeWords ?? false;
    const text = caseSensitive ? textToScan : textToScan.toLowerCase();
    const keyword = caseSensitive ? key : key.toLowerCase();

    if (matchWholeWords && !keyword.includes(' ')) {
        const wordRegex = new RegExp(`(?:^|\\W)(${escapeRegex(keyword)})(?:$|\\W)`, caseSensitive ? '' : 'i');
        return wordRegex.test(textToScan);
    }

    return text.includes(keyword);
}

function getEntryKeys(entry) {
    if (Array.isArray(entry.key)) return entry.key;
    if (Array.isArray(entry.keys)) return entry.keys;
    if (typeof entry.key === 'string') return [entry.key];
    return [];
}

function getSecondaryKeys(entry) {
    if (Array.isArray(entry.keysecondary)) return entry.keysecondary;
    return [];
}

function normalizeEntries(worldbook) {
    const entries = worldbook?.data?.entries || worldbook?.entries || {};
    const list = Array.isArray(entries) ? entries : Object.values(entries);
    return list.map(entry => ({
        ...entry,
        world: worldbook.name || worldbook.id || 'worldbook',
        uid: entry.uid ?? entry.id ?? Math.random().toString(36).slice(2),
    }));
}

function sortEntries(entries) {
    return entries.sort((a, b) => (b.order ?? b.insertion_order ?? 0) - (a.order ?? a.insertion_order ?? 0));
}

function buildScanText(messages, depth, includeNames = true) {
    const slice = messages.slice(0, depth);
    return slice.map(m => {
        const name = includeNames && m.name ? `${m.name}: ` : '';
        return `${name}${m.mes || ''}`;
    }).join('\n');
}

function matchSecondaryKeys(entry, textToScan, settings, macroEnv) {
    const secondaryKeys = getSecondaryKeys(entry);
    if (!secondaryKeys.length) return true;

    const selectiveLogic = entry.selectiveLogic ?? world_info_logic.AND_ANY;
    let hasAnyMatch = false;
    let hasAllMatch = true;

    for (const key of secondaryKeys) {
        const substituted = macroEnv ? evaluateMacros(key, macroEnv) : key;
        const hasMatch = substituted && matchKeys(textToScan, substituted.trim(), entry, settings);

        if (hasMatch) hasAnyMatch = true;
        if (!hasMatch) hasAllMatch = false;

        if (selectiveLogic === world_info_logic.AND_ANY && hasMatch) return true;
        if (selectiveLogic === world_info_logic.NOT_ALL && !hasMatch) return true;
    }

    if (selectiveLogic === world_info_logic.NOT_ANY && !hasAnyMatch) return true;
    if (selectiveLogic === world_info_logic.AND_ALL && hasAllMatch) return true;

    return false;
}

/**
 * Check World Info entries against chat context.
 * @param {object} options
 * @param {object[]} options.chat - Chat messages array (newest first / reversed, or will be reversed internally)
 * @param {object[]} options.worldbooks - Array of worldbook objects
 * @param {number} options.maxContext - Maximum context tokens
 * @param {object} [options.settings] - World info settings overrides
 * @param {object} [options.macroEnv] - Macro environment for key/content substitution
 * @param {string} [options.input] - Current user input
 * @param {string} [options.model] - Model name for token counting
 * @returns {object} World info result with entries for each position
 */
export function checkWorldInfo({
    chat = [],
    worldbooks = [],
    maxContext = 8192,
    settings = {},
    macroEnv = {},
    input = '',
    model,
    timedWorldInfo = null,
    characterName = '',
} = {}) {
    const wiSettings = {
        depth: settings.depth ?? DEFAULT_SCAN_DEPTH,
        budget: settings.budget ?? 25,
        budgetCap: settings.budgetCap ?? 0,
        recursive: settings.recursive ?? false,
        maxRecursionSteps: settings.maxRecursionSteps ?? 0,
        minActivations: settings.minActivations ?? 0,
        minActivationsDepthMax: settings.minActivationsDepthMax ?? 0,
        caseSensitive: settings.caseSensitive ?? false,
        matchWholeWords: settings.matchWholeWords ?? false,
        includeNames: settings.includeNames ?? true,
        useGroupScoring: settings.useGroupScoring ?? false,
    };

    const timedEffects = timedWorldInfo || {};

    // Collect and sort all entries
    const allEntries = [];
    for (const wb of worldbooks.filter(Boolean)) {
        allEntries.push(...normalizeEntries(wb));
    }
    const sortedEntries = sortEntries(allEntries);

    if (sortedEntries.length === 0) {
        return emptyResult();
    }

    // Compute budget
    let budget = Math.round(wiSettings.budget * maxContext / 100) || 1;
    if (wiSettings.budgetCap > 0 && budget > wiSettings.budgetCap) {
        budget = wiSettings.budgetCap;
    }

    // Chat messages should be newest-first for depth scanning
    const chatReversed = [...chat].reverse();
    const inputText = input || '';

    // State
    let scanState = scan_state.INITIAL;
    let tokenBudgetOverflowed = false;
    let count = 0;
    const allActivatedEntries = new Map();
    const failedProbabilityChecks = new Set();
    let allActivatedText = '';
    let recurseBuffer = '';
    let depthSkew = 0;

    while (scanState) {
        if (wiSettings.maxRecursionSteps && wiSettings.maxRecursionSteps <= count) {
            break;
        }
        count++;

        let nextScanState = scan_state.NONE;
        const activatedNow = new Set();

        for (const entry of sortedEntries) {
            const entryKey = `${entry.world}.${entry.uid}`;
            if (failedProbabilityChecks.has(entry) || allActivatedEntries.has(entryKey)) {
                continue;
            }
            if (entry.disable === true || entry.enabled === false) {
                continue;
            }

            // Character filter
            if (entry.characterFilter) {
                const filterNames = entry.characterFilter.names || [];
                const isExclude = entry.characterFilter.isExclude ?? false;
                if (filterNames.length > 0 && characterName) {
                    const matches = filterNames.some(n => n === characterName);
                    if (isExclude ? matches : !matches) continue;
                }
            }

            // Timed effects
            const entryTimedKey = `${entry.world}.${entry.uid}`;
            const timedState = timedEffects[entryTimedKey];
            if (timedState) {
                if (timedState.cooldown > 0) {
                    timedState.cooldown--;
                    continue;
                }
                if (entry.delay && timedState.delay > 0) {
                    timedState.delay--;
                    continue;
                }
                if (timedState.sticky > 0) {
                    timedState.sticky--;
                    activatedNow.add(entry);
                    continue;
                }
            }

            // Generation type trigger filter
            if (Array.isArray(entry.triggers) && entry.triggers.length > 0) {
                const trigger = settings.trigger || 'normal';
                if (!entry.triggers.includes(trigger)) continue;
            }

            // Recursion controls
            if (scanState !== scan_state.RECURSION && entry.delayUntilRecursion && !entry.constant) {
                continue;
            }
            if (scanState === scan_state.RECURSION && wiSettings.recursive && entry.excludeRecursion) {
                continue;
            }

            // Decorators
            const decorators = parseDecorators(entry.content);
            if (decorators.includes('@@activate')) {
                activatedNow.add(entry);
                continue;
            }
            if (decorators.includes('@@dont_activate')) {
                continue;
            }

            // Constant entries always activate
            if (entry.constant) {
                activatedNow.add(entry);
                continue;
            }

            // No primary keys
            const primaryKeys = getEntryKeys(entry);
            if (!primaryKeys.length) continue;

            // Build scan text
            const scanDepth = entry.scanDepth ?? (wiSettings.depth + depthSkew);
            let textToScan = buildScanText(chatReversed, scanDepth, wiSettings.includeNames);
            if (inputText) textToScan = inputText + '\n' + textToScan;
            if (scanState === scan_state.RECURSION && recurseBuffer) {
                textToScan = recurseBuffer + '\n' + textToScan;
            }

            if (entry.matchCharacterDescription !== false && macroEnv.description) {
                textToScan += '\n' + macroEnv.description;
            }
            if (entry.matchCharacterPersonality !== false && macroEnv.personality) {
                textToScan += '\n' + macroEnv.personality;
            }
            if (entry.matchScenario !== false && macroEnv.scenario) {
                textToScan += '\n' + macroEnv.scenario;
            }
            if (entry.matchPersonaDescription !== false && macroEnv.persona) {
                textToScan += '\n' + macroEnv.persona;
            }
            if (entry.matchCreatorNotes !== false && macroEnv.creatorNotes) {
                textToScan += '\n' + macroEnv.creatorNotes;
            }

            // Primary keyword match
            const primaryMatch = primaryKeys.find(key => {
                const substituted = macroEnv ? evaluateMacros(key, macroEnv) : key;
                return substituted && matchKeys(textToScan, substituted.trim(), entry, wiSettings);
            });

            if (!primaryMatch) continue;

            // Secondary keyword check
            const hasSecondary = entry.selective && Array.isArray(entry.keysecondary) && entry.keysecondary.length > 0;
            if (hasSecondary) {
                if (!matchSecondaryKeys(entry, textToScan, wiSettings, macroEnv)) {
                    continue;
                }
            }

            activatedNow.add(entry);
        }

        // Sort activated entries: by original sorted order
        const newEntries = [...activatedNow].sort(
            (a, b) => sortedEntries.indexOf(a) - sortedEntries.indexOf(b),
        );

        // Inclusion group filtering
        filterByInclusionGroups(newEntries, allActivatedEntries, wiSettings.useGroupScoring, inputText + '\n' + buildScanText(chatReversed, wiSettings.depth, wiSettings.includeNames));

        // Probability checks and token budgeting
        let newContent = '';
        const existingTokens = allActivatedText ? countTokens(allActivatedText, model) : 0;

        for (const entry of newEntries) {
            // Probability check
            if (entry.useProbability && entry.probability !== undefined && entry.probability < 100) {
                const roll = Math.random() * 100;
                if (roll > entry.probability) {
                    failedProbabilityChecks.add(entry);
                    continue;
                }
            }

            const rawContent = macroEnv
                ? evaluateMacros(entry.content || '', macroEnv)
                : (entry.content || '');
            entry._resolvedContent = stripDecorators(rawContent);

            // Token budget check
            if (!entry.ignoreBudget) {
                newContent += entry._resolvedContent + '\n';
                const totalTokens = existingTokens + countTokens(newContent, model);
                if (totalTokens >= budget) {
                    if (!tokenBudgetOverflowed) {
                        tokenBudgetOverflowed = true;
                    }
                    continue;
                }
            }

            const entryKey = `${entry.world}.${entry.uid}`;
            allActivatedEntries.set(entryKey, entry);

            // Initialize timed effects for newly activated entries
            if (entry.sticky || entry.cooldown) {
                timedEffects[entryKey] = {
                    sticky: entry.sticky ?? 0,
                    cooldown: 0,
                };
            }
        }

        const successfulNew = newEntries.filter(e => !failedProbabilityChecks.has(e) && allActivatedEntries.has(`${e.world}.${e.uid}`));
        const forRecursion = successfulNew.filter(e => !e.preventRecursion);

        // Recursion decision
        if (wiSettings.recursive && !tokenBudgetOverflowed && forRecursion.length) {
            nextScanState = scan_state.RECURSION;
        }

        // Min activations check
        if (wiSettings.recursive && !tokenBudgetOverflowed && scanState === scan_state.MIN_ACTIVATIONS && recurseBuffer) {
            nextScanState = scan_state.RECURSION;
        }

        const minNotSatisfied = wiSettings.minActivations > 0 && allActivatedEntries.size < wiSettings.minActivations;
        if (!nextScanState && !tokenBudgetOverflowed && minNotSatisfied) {
            const overMax = (wiSettings.minActivationsDepthMax > 0 && depthSkew >= wiSettings.minActivationsDepthMax) ||
                (wiSettings.depth + depthSkew > chat.length);
            if (!overMax) {
                nextScanState = scan_state.MIN_ACTIVATIONS;
                depthSkew++;
            }
        }

        scanState = nextScanState;
        if (scanState) {
            const text = forRecursion.map(e => e._resolvedContent || e.content || '').join('\n');
            if (text) {
                recurseBuffer = text + '\n' + recurseBuffer;
                allActivatedText = text + '\n' + allActivatedText;
            }
        }
    }

    // Build result by position
    const result = buildResult([...allActivatedEntries.values()], macroEnv);
    result.timedEffects = timedEffects;
    return result;
}

function parseDecorators(content) {
    if (!content) return [];
    const decorators = [];
    const lines = content.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('@@')) {
            decorators.push(trimmed.split(/\s/)[0]);
        } else if (trimmed) {
            break;
        }
    }
    return decorators;
}

function stripDecorators(content) {
    if (!content) return '';
    const lines = content.split('\n');
    let startIndex = 0;
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('@@')) { startIndex = i + 1; continue; }
        if (trimmed === '') { startIndex = i + 1; continue; }
        break;
    }
    return lines.slice(startIndex).join('\n');
}

function filterByInclusionGroups(newEntries, allActivatedEntries, useGroupScoring = false, textToScan = '') {
    const groups = {};
    for (const entry of newEntries) {
        if (!entry.group) continue;
        if (!groups[entry.group]) groups[entry.group] = [];
        groups[entry.group].push(entry);
    }

    for (const [groupName, group] of Object.entries(groups)) {
        // Check if group already has an activated entry
        const alreadyActivated = [...allActivatedEntries.values()].some(e => e.group === groupName);
        if (alreadyActivated) {
            for (const entry of group) {
                const idx = newEntries.indexOf(entry);
                if (idx !== -1) newEntries.splice(idx, 1);
            }
            continue;
        }

        if (group.length <= 1) continue;

        const overrideEntries = group.filter(e => e.groupOverride);
        let winner;
        if (overrideEntries.length) {
            winner = overrideEntries.sort((a, b) => (b.order ?? 0) - (a.order ?? 0))[0];
        } else if (useGroupScoring && textToScan) {
            let bestScore = -1;
            for (const entry of group) {
                const keys = getEntryKeys(entry);
                const score = keys.filter(k => k && textToScan.toLowerCase().includes(String(k).toLowerCase())).length;
                if (score > bestScore) { bestScore = score; winner = entry; }
            }
            if (!winner) winner = group[0];
        } else {
            const totalWeight = group.reduce((sum, e) => sum + (e.groupWeight ?? 100), 0);
            let roll = Math.random() * totalWeight;
            for (const entry of group) {
                roll -= entry.groupWeight ?? 100;
                if (roll <= 0) { winner = entry; break; }
            }
            if (!winner) winner = group[0];
        }

        for (const entry of group) {
            if (entry !== winner) {
                const idx = newEntries.indexOf(entry);
                if (idx !== -1) newEntries.splice(idx, 1);
            }
        }
    }
}

function buildResult(activatedEntries, macroEnv) {
    const WIBeforeEntries = [];
    const WIAfterEntries = [];
    const EMEntries = [];
    const ANTopEntries = [];
    const ANBottomEntries = [];
    const WIDepthEntries = [];
    const WIOutletEntries = {};

    const sorted = [...activatedEntries].sort((a, b) => (b.order ?? 0) - (a.order ?? 0));

    for (const entry of sorted) {
        const content = entry._resolvedContent || entry.content || '';
        if (!content) continue;

        const position = entry.position ?? world_info_position.before;
        switch (position) {
            case world_info_position.before:
                WIBeforeEntries.unshift(content);
                break;
            case world_info_position.after:
                WIAfterEntries.unshift(content);
                break;
            case world_info_position.EMTop:
                EMEntries.unshift({ position: 'before', content });
                break;
            case world_info_position.EMBottom:
                EMEntries.unshift({ position: 'after', content });
                break;
            case world_info_position.ANTop:
                ANTopEntries.unshift(content);
                break;
            case world_info_position.ANBottom:
                ANBottomEntries.unshift(content);
                break;
            case world_info_position.atDepth: {
                const depth = entry.depth ?? DEFAULT_DEPTH;
                const role = entry.role ?? 'system';
                const existing = WIDepthEntries.find(e => e.depth === depth && e.role === role);
                if (existing) {
                    existing.entries.unshift(content);
                } else {
                    WIDepthEntries.push({ depth, entries: [content], role });
                }
                break;
            }
            case world_info_position.outlet: {
                if (!entry.outletName) break;
                if (Array.isArray(WIOutletEntries[entry.outletName])) {
                    WIOutletEntries[entry.outletName].push(content);
                } else {
                    WIOutletEntries[entry.outletName] = [content];
                }
                break;
            }
            default:
                break;
        }
    }

    return {
        worldInfoBefore: WIBeforeEntries.join('\n'),
        worldInfoAfter: WIAfterEntries.join('\n'),
        WIDepthEntries,
        EMEntries,
        ANBeforeEntries: ANTopEntries,
        ANAfterEntries: ANBottomEntries,
        outletEntries: WIOutletEntries,
        allActivatedEntries: new Set(activatedEntries),
    };
}

function emptyResult() {
    return {
        worldInfoBefore: '',
        worldInfoAfter: '',
        WIDepthEntries: [],
        EMEntries: [],
        ANBeforeEntries: [],
        ANAfterEntries: [],
        outletEntries: {},
        allActivatedEntries: new Set(),
        timedEffects: {},
    };
}

/**
 * High-level API matching SillyTavern's getWorldInfoPrompt.
 * @param {object} options
 * @returns {object}
 */
export function getWorldInfoPrompt(options) {
    return checkWorldInfo(options);
}
