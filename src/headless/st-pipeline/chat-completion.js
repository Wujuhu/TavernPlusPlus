/**
 * Headless ChatCompletion token budget system — server-side port of SillyTavern's
 * Message, MessageCollection, and ChatCompletion classes.
 */

import { countTokens } from './tokenizer.js';

const MESSAGE_OVERHEAD = 3;

export class Message {
    constructor(role, content, identifier) {
        this.role = role || 'system';
        this.content = content || '';
        this.identifier = identifier || '';
        this.name = null;
        this.tokens = 0;
        this.tool_calls = null;
        this.signature = null;
    }

    static create(role, content, identifier, model) {
        const msg = new Message(role, content, identifier);
        msg.tokens = msg.#countTokens(model);
        return msg;
    }

    static fromPrompt(prompt, model) {
        if (!prompt) return null;
        const msg = new Message(prompt.role || 'system', prompt.content || '', prompt.identifier || '');
        if (prompt.name) msg.name = prompt.name;
        msg.tokens = msg.#countTokens(model);
        return msg;
    }

    setName(name, model) {
        this.name = name;
        this.tokens = this.#countTokens(model);
    }

    getTokens() {
        return this.tokens;
    }

    #countTokens(model) {
        let count = MESSAGE_OVERHEAD;
        if (this.content) count += countTokens(this.content, model);
        if (this.name) count += countTokens(this.name, model) + 1;
        return count;
    }

    toJSON() {
        const obj = { role: this.role };
        if (this.content !== undefined && this.content !== null) obj.content = this.content;
        if (this.name) obj.name = this.name;
        if (this.tool_calls) obj.tool_calls = this.tool_calls;
        return obj;
    }
}

export class MessageCollection {
    constructor(identifier) {
        this.identifier = identifier || '';
        this.collection = [];
    }

    add(messageOrCollection) {
        this.collection.push(messageOrCollection);
    }

    getTokens() {
        return this.collection.reduce((sum, item) => sum + (item ? item.getTokens() : 0), 0);
    }

    flatten() {
        const result = [];
        for (const item of this.collection) {
            if (!item) continue;
            if (item instanceof MessageCollection) {
                result.push(...item.flatten());
            } else {
                result.push(item);
            }
        }
        return result;
    }

    getChat() {
        return this.flatten().map(msg => msg.toJSON()).filter(m => m.content || m.tool_calls);
    }
}

export class TokenBudgetExceededError extends Error {
    constructor(identifier = '') {
        super(`Token budget exceeded. Message: ${identifier}`);
        this.name = 'TokenBudgetExceeded';
    }
}

export class ChatCompletion {
    constructor() {
        this.tokenBudget = 0;
        this.messages = new MessageCollection('root');
        this.overriddenPrompts = [];
        this.model = null;
    }

    getMessages() {
        return this.messages;
    }

    setTokenBudget(context, response) {
        this.tokenBudget = context - response;
    }

    setModel(model) {
        this.model = model;
    }

    setOverriddenPrompts(prompts) {
        this.overriddenPrompts = prompts || [];
    }

    getOverriddenPrompts() {
        return this.overriddenPrompts;
    }

    add(collection, position = null) {
        this.#validateCollection(collection);
        this.#checkBudget(collection, collection.identifier);

        if (position !== null && position !== -1) {
            this.messages.collection[position] = collection;
        } else {
            this.messages.collection.push(collection);
        }

        this.tokenBudget -= collection.getTokens();
        return this;
    }

    insert(message, identifier, position = 'end') {
        this.#checkBudget(message, message.identifier);

        const index = this.#findIndex(identifier);
        if (index === -1) return;

        const target = this.messages.collection[index];
        if (message.content || message.tool_calls) {
            if (position === 'start') {
                target.collection.unshift(message);
            } else if (position === 'end') {
                target.collection.push(message);
            } else if (typeof position === 'number') {
                target.collection.splice(position, 0, message);
            }
            this.tokenBudget -= message.getTokens();
        }
    }

    insertAtStart(message, identifier) {
        this.insert(message, identifier, 'start');
    }

    insertAtEnd(message, identifier) {
        this.insert(message, identifier, 'end');
    }

    removeLastFrom(identifier) {
        const index = this.#findIndex(identifier);
        if (index === -1) return;
        const message = this.messages.collection[index].collection.pop();
        if (message) {
            this.tokenBudget += message.getTokens();
        }
    }

    canAfford(messageOrTokens) {
        const tokens = typeof messageOrTokens === 'number' ? messageOrTokens : messageOrTokens.getTokens();
        return this.tokenBudget - tokens >= 0;
    }

    canAffordAll(messages) {
        const total = messages.reduce((sum, m) => sum + m.getTokens(), 0);
        return this.tokenBudget - total >= 0;
    }

    reserveBudget(messageOrTokens) {
        const tokens = typeof messageOrTokens === 'number' ? messageOrTokens : messageOrTokens.getTokens();
        this.#checkBudgetAmount(tokens, 'reservation');
        this.tokenBudget -= tokens;
    }

    freeBudget(messageOrTokens) {
        const tokens = typeof messageOrTokens === 'number' ? messageOrTokens : messageOrTokens.getTokens();
        this.tokenBudget += tokens;
    }

    has(identifier) {
        return this.#findIndex(identifier) !== -1;
    }

    getChat() {
        return this.messages.getChat();
    }

    getRemainingBudget() {
        return this.tokenBudget;
    }

    async squashSystemMessages() {
        const excludeList = ['newMainChat', 'newChat', 'groupNudge'];
        const flat = this.messages.flatten();
        const squashed = [];
        let lastMessage = null;

        for (const message of flat) {
            if (message.role === 'system' && !message.content) continue;

            const shouldSquash = (m) =>
                !excludeList.includes(m.identifier) && m.role === 'system' && !m.name;

            if (shouldSquash(message)) {
                if (lastMessage && shouldSquash(lastMessage)) {
                    lastMessage.content += '\n' + message.content;
                    lastMessage.tokens = MESSAGE_OVERHEAD + countTokens(lastMessage.content, this.model);
                } else {
                    squashed.push(message);
                    lastMessage = message;
                }
            } else {
                squashed.push(message);
                lastMessage = message;
            }
        }

        this.messages = new MessageCollection('root');
        const wrapper = new MessageCollection('squashed');
        wrapper.collection = squashed;
        this.messages.collection = [wrapper];
    }

    #findIndex(identifier) {
        return this.messages.collection.findIndex(
            item => item.identifier === identifier,
        );
    }

    #validateCollection(collection) {
        if (!(collection instanceof MessageCollection) && !(collection instanceof Message)) {
            throw new Error('Invalid collection type');
        }
    }

    #checkBudget(item, identifier) {
        const tokens = item.getTokens();
        this.#checkBudgetAmount(tokens, identifier);
    }

    #checkBudgetAmount(tokens, identifier) {
        if (this.tokenBudget - tokens < 0) {
            throw new TokenBudgetExceededError(identifier);
        }
    }
}
