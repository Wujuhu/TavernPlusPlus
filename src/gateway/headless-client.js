import { Blob } from 'node:buffer';

function makeUrl(baseUrl, route) {
    return `${baseUrl.replace(/\/+$/, '')}${route}`;
}

async function parseResponse(response) {
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;

    if (!response.ok) {
        throw new Error(data?.error || `Headless API returned ${response.status}`);
    }

    return data;
}

async function collectSse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalText = '';
    let finalTask = null;
    let errorMessage = '';

    while (true) {
        const { value, done } = await reader.read();
        if (done) {
            break;
        }

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';

        for (const block of blocks) {
            const event = block.match(/^event: (.+)$/m)?.[1];
            const data = block.match(/^data: (.+)$/m)?.[1];
            if (!event || !data) {
                continue;
            }

            const payload = JSON.parse(data);
            if (event === 'token') {
                finalText += payload.token || '';
            }
            if (event === 'error') {
                errorMessage = payload?.message || JSON.stringify(payload);
            }
            if (event === 'done') {
                finalTask = payload;
            }
        }
    }

    if (errorMessage) {
        throw new Error(errorMessage);
    }

    if (finalTask?.status === 'error') {
        throw new Error('Generation failed.');
    }

    return { text: finalText, task: finalTask };
}

export class HeadlessClient {
    constructor({ baseUrl, token, fetchImpl = fetch, userHandle }) {
        this.baseUrl = baseUrl;
        this.token = token;
        this.fetch = fetchImpl;
        this.userHandle = userHandle || null;
    }

    #headers(extra = {}) {
        return {
            Authorization: `Bearer ${this.token}`,
            ...(this.userHandle ? { 'X-User-Handle': this.userHandle } : {}),
            ...extra,
        };
    }

    async request(method, route, body = undefined) {
        const response = await this.fetch(makeUrl(this.baseUrl, route), {
            method,
            headers: this.#headers(body ? { 'Content-Type': 'application/json' } : {}),
            body: body ? JSON.stringify(body) : undefined,
        });

        return parseResponse(response);
    }

    get(route) {
        return this.request('GET', route);
    }

    post(route, body) {
        return this.request('POST', route, body);
    }

    put(route, body) {
        return this.request('PUT', route, body);
    }

    async upload(route, { buffer, filename, fields = {} }) {
        const form = new FormData();
        if (filename) {
            form.set('filename', filename);
        }
        for (const [key, value] of Object.entries(fields)) {
            if (value !== undefined && value !== null) {
                form.set(key, String(value));
            }
        }
        form.set('file', new Blob([buffer]), filename || 'upload.bin');

        const response = await this.fetch(makeUrl(this.baseUrl, route), {
            method: 'POST',
            headers: this.#headers(),
            body: form,
        });

        return parseResponse(response);
    }

    importCharacter(buffer, filename) {
        return this.upload('/characters/import', { buffer, filename });
    }

    importPreset(buffer, filename, apiId = 'openai') {
        return this.upload('/presets/import', { buffer, filename, fields: { apiId } });
    }

    async ensureSession(state) {
        if (state.sessionId) {
            try {
                await this.get(`/sessions/${state.sessionId}`);
                return state.sessionId;
            } catch {
                // Session store is in-memory; recreate if the gateway survived a restart.
            }
        }

        const session = await this.post('/sessions', {
            characterId: state.characterId,
            chatId: state.chatId,
            presetId: state.presetId,
            modelProfileId: state.modelProfileId,
            worldbookIds: state.worldbookIds || [],
        });
        return session.id;
    }

    async generate(sessionId, input) {
        const task = await this.post('/generate', { sessionId, input });
        const origin = new URL(this.baseUrl).origin;
        const eventsUrl = task.events.startsWith('/api/') ? `${origin}${task.events}` : makeUrl(this.baseUrl, task.events);
        const response = await this.fetch(eventsUrl, {
            headers: this.#headers(),
        });

        if (!response.ok) {
            throw new Error(`SSE stream failed: ${response.status}`);
        }

        return collectSse(response);
    }

    async *generateStream(sessionId, input) {
        const task = await this.post('/generate', { sessionId, input });
        const origin = new URL(this.baseUrl).origin;
        const eventsUrl = task.events.startsWith('/api/') ? `${origin}${task.events}` : makeUrl(this.baseUrl, task.events);
        yield* this.streamEvents(eventsUrl);
    }

    async *streamEvents(eventsUrl) {
        const url = eventsUrl.startsWith('http') ? eventsUrl : (() => {
            const origin = new URL(this.baseUrl).origin;
            return eventsUrl.startsWith('/api/') ? `${origin}${eventsUrl}` : makeUrl(this.baseUrl, eventsUrl);
        })();

        const response = await this.fetch(url, {
            headers: this.#headers(),
        });

        if (!response.ok) {
            throw new Error(`SSE stream failed: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split('\n\n');
            buffer = blocks.pop() || '';

            for (const block of blocks) {
                const event = block.match(/^event: (.+)$/m)?.[1];
                const data = block.match(/^data: (.+)$/m)?.[1];
                if (!event || !data) continue;

                const payload = JSON.parse(data);
                if (event === 'token') {
                    yield { type: 'token', token: payload.token || '' };
                }
                if (event === 'error') {
                    yield { type: 'error', message: payload?.message || JSON.stringify(payload) };
                }
                if (event === 'done') {
                    yield { type: 'done', task: payload };
                }
            }
        }
    }
}
