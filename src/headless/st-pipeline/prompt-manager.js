/**
 * Headless PromptManager — server-side port of SillyTavern's Prompt and PromptCollection.
 */

import { evaluateMacros } from '../macros.js';

export const INJECTION_POSITION = Object.freeze({
    RELATIVE: 0,
    ABSOLUTE: 1,
});

export class Prompt {
    constructor(input = {}) {
        this.identifier = input.identifier || '';
        this.name = input.name || '';
        this.role = input.role || 'system';
        this.content = input.content ?? '';
        this.system_prompt = input.system_prompt ?? false;
        this.enabled = input.enabled ?? true;
        this.marker = input.marker ?? false;
        this.forbid_overrides = input.forbid_overrides ?? false;
        this.injection_position = input.injection_position ?? INJECTION_POSITION.RELATIVE;
        this.injection_depth = input.injection_depth ?? 4;
        this.injection_order = input.injection_order ?? 100;
        this.injection_trigger = input.injection_trigger ?? null;
        this.position = input.position ?? null;
        this.extension = input.extension ?? false;
    }
}

export class PromptCollection {
    constructor() {
        this.collection = [];
        this.overriddenPrompts = [];
    }

    add(prompt) {
        this.collection.push(prompt instanceof Prompt ? prompt : new Prompt(prompt));
    }

    get(identifier) {
        return this.collection.find(p => p.identifier === identifier) || null;
    }

    has(identifier) {
        return this.collection.some(p => p.identifier === identifier);
    }

    index(identifier) {
        return this.collection.findIndex(p => p.identifier === identifier);
    }

    override(prompt, index) {
        if (index >= 0 && index < this.collection.length) {
            const original = this.collection[index];
            this.overriddenPrompts.push({ identifier: original.identifier, original });
            this.collection[index] = prompt instanceof Prompt ? prompt : new Prompt(prompt);
        }
    }
}

/**
 * Prepares a prompt by applying macro substitution.
 * @param {Prompt|object} prompt
 * @param {object} macroEnv
 * @param {object} [context]
 * @returns {Prompt}
 */
export function preparePrompt(prompt, macroEnv = {}, context = {}) {
    const prepared = new Prompt(prompt);
    if (prepared.content) {
        prepared.content = evaluateMacros(prepared.content, macroEnv, context);
    }
    return prepared;
}

/**
 * Check if a prompt should be triggered based on generation type.
 * @param {Prompt} prompt
 * @param {string} generationType
 * @returns {boolean}
 */
export function shouldTrigger(prompt, generationType) {
    if (!Array.isArray(prompt?.injection_trigger)) return true;
    if (!prompt.injection_trigger.length) return true;
    return prompt.injection_trigger.includes(generationType);
}

/**
 * Get the prompt collection based on prompt definitions and order.
 * Replicates PromptManager.getPromptCollection().
 * @param {Map} promptDefinitions
 * @param {object[]} promptOrder
 * @param {string} generationType
 * @returns {PromptCollection}
 */
export function getPromptCollection(promptDefinitions, promptOrder, generationType = 'normal') {
    const collection = new PromptCollection();

    for (const entry of promptOrder) {
        const prompt = promptDefinitions.get(entry.identifier);
        if (!prompt) continue;

        const allowedTrigger = entry.enabled !== false && shouldTrigger(prompt, generationType);
        if (allowedTrigger) {
            collection.add(new Prompt(prompt));
        } else if (entry.identifier === 'main') {
            const replacement = new Prompt(prompt);
            replacement.content = '';
            collection.add(replacement);
        }
    }

    return collection;
}
