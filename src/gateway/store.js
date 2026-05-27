import fs from 'node:fs';
import path from 'node:path';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

export class JsonStateStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.state = {
            offset: 0,
            chats: {},
        };
    }

    async load() {
        if (fs.existsSync(this.filePath)) {
            this.state = JSON.parse(await fs.promises.readFile(this.filePath, 'utf8'));
        }
        return this.state;
    }

    save() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        writeFileAtomicSync(this.filePath, JSON.stringify(this.state, null, 4));
    }

    getOffset() {
        return Number(this.state.offset || 0);
    }

    setOffset(offset) {
        this.state.offset = offset;
        this.save();
    }

    getChat(chatId) {
        const key = String(chatId);
        if (!this.state.chats[key]) {
            this.state.chats[key] = {};
        }
        return this.state.chats[key];
    }

    updateChat(chatId, patch) {
        const key = String(chatId);
        this.state.chats[key] = {
            ...this.getChat(key),
            ...patch,
            updatedAt: new Date().toISOString(),
        };
        this.save();
        return this.state.chats[key];
    }

    deleteChat(stateKey) {
        delete this.state.chats[String(stateKey)];
        this.save();
    }

    getActiveThread(chatId) {
        const key = String(chatId);
        return this.state.activeThreads?.[key] || null;
    }

    setActiveThread(chatId, name) {
        const key = String(chatId);
        if (!this.state.activeThreads) this.state.activeThreads = {};
        if (name) {
            this.state.activeThreads[key] = name;
        } else {
            delete this.state.activeThreads[key];
        }
        this.save();
    }

    listThreads(chatId) {
        const prefix = `${chatId}_thread_`;
        const threads = [];
        for (const key of Object.keys(this.state.chats)) {
            if (key.startsWith(prefix)) {
                threads.push(key.slice(prefix.length));
            }
        }
        return threads;
    }
}
