/**
 * Headless Extension Prompts framework — manages injection of extension prompts
 * (Author's Note, Summary, Vectors, Persona, Depth Prompts) into the generation pipeline.
 */

export const extension_prompt_types = Object.freeze({
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
    NONE: -1,
});

export const extension_prompt_roles = Object.freeze({
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
});

function roleToString(role) {
    switch (role) {
        case extension_prompt_roles.USER: return 'user';
        case extension_prompt_roles.ASSISTANT: return 'assistant';
        default: return 'system';
    }
}

/**
 * Extension prompt definition.
 */
export class ExtensionPrompt {
    constructor({ key, value = '', position = extension_prompt_types.IN_PROMPT, depth = 0, scan = false, role = extension_prompt_roles.SYSTEM, filter = null } = {}) {
        this.key = key || '';
        this.value = value;
        this.position = position;
        this.depth = depth;
        this.scan = scan;
        this.role = role;
        this.filter = filter;
    }
}

/**
 * Manages a collection of extension prompts.
 */
export class ExtensionPromptManager {
    #prompts = new Map();

    set(key, value, position, depth = 0, scan = false, role = extension_prompt_roles.SYSTEM) {
        this.#prompts.set(key, new ExtensionPrompt({ key, value, position, depth, scan, role }));
    }

    get(key) {
        return this.#prompts.get(key) || null;
    }

    getAll() {
        return new Map(this.#prompts);
    }

    /**
     * Get extension prompts suitable for chat completion prompt merging.
     * Returns prompts grouped by their injection type.
     */
    getForChatCompletion() {
        const systemPrompts = [];
        const depthPrompts = [];

        for (const [key, prompt] of this.#prompts) {
            if (!prompt.value) continue;

            if (prompt.position === extension_prompt_types.IN_CHAT) {
                depthPrompts.push({
                    content: prompt.value,
                    depth: prompt.depth,
                    role: roleToString(prompt.role),
                    identifier: key.replace(/\W/g, '_'),
                });
            } else if (prompt.position === extension_prompt_types.IN_PROMPT || prompt.position === extension_prompt_types.BEFORE_PROMPT) {
                systemPrompts.push({
                    role: roleToString(prompt.role),
                    content: prompt.value,
                    identifier: key.replace(/\W/g, '_'),
                    position: prompt.position,
                    extension: true,
                });
            }
        }

        return { systemPrompts, depthPrompts };
    }

    /**
     * Get concatenated extension prompt text for a specific position and depth.
     */
    getPromptByPosition(position, depth = null) {
        const parts = [];

        for (const [, prompt] of this.#prompts) {
            if (!prompt.value) continue;
            if (prompt.position !== position) continue;
            if (depth !== null && prompt.depth !== depth) continue;
            parts.push(prompt.value);
        }

        return parts.join('\n');
    }

    clear() {
        this.#prompts.clear();
    }
}

/**
 * Build extension prompt configuration from session/API parameters.
 * @param {object} params - Extension prompt parameters from the API
 * @returns {ExtensionPromptManager}
 */
export function buildExtensionPrompts(params = {}) {
    const manager = new ExtensionPromptManager();

    if (params.authorsNote) {
        manager.set('2_floating_prompt', params.authorsNote.value || '',
            params.authorsNote.position ?? extension_prompt_types.IN_CHAT,
            params.authorsNote.depth ?? 4,
            false,
            params.authorsNote.role ?? extension_prompt_roles.SYSTEM);
    }

    if (params.personaDescription) {
        manager.set('PERSONA_DESCRIPTION', params.personaDescription,
            extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
    }

    if (params.summary) {
        manager.set('1_memory', params.summary,
            extension_prompt_types.IN_PROMPT, 0, true, extension_prompt_roles.SYSTEM);
    }

    // Support arbitrary extension prompts passed as key-value
    if (params.custom && typeof params.custom === 'object') {
        for (const [key, config] of Object.entries(params.custom)) {
            if (!config?.value) continue;
            manager.set(key, config.value,
                config.position ?? extension_prompt_types.IN_PROMPT,
                config.depth ?? 0,
                config.scan ?? false,
                config.role ?? extension_prompt_roles.SYSTEM);
        }
    }

    return manager;
}
