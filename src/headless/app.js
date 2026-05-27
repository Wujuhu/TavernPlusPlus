import http from 'node:http';

import compression from 'compression';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';

import { resolveHeadlessConfig } from './config.js';
import { GenerationManager, SessionStore, createGenerationProvider } from './generation.js';
import { openApiDocument } from './openapi.js';
import {
    appendChatMessage,
    createCharacter,
    createChat,
    createHeadlessContext,
    createModelProfile,
    createPreset,
    createWorldbook,
    ensureHeadlessData,
    importCharacterCard,
    importPresetJson,
    listCharacters,
    listChats,
    listModelProfiles,
    listPresets,
    listWorldbooks,
    readCharacter,
    readChat,
    readModelProfile,
    rewindChat,
    updateModelProfile,
} from './storage.js';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024,
    },
});

function resolveUploadFilename(req) {
    if (req.body?.filename) return req.body.filename;
    const raw = req.file?.originalname;
    if (!raw) return undefined;
    try {
        return Buffer.from(raw, 'latin1').toString('utf8');
    } catch {
        return raw;
    }
}

function bearerAuth(token) {
    return (request, response, next) => {
        const header = request.get('authorization') || '';
        const expected = `Bearer ${token}`;
        if (header !== expected) {
            return response.status(401).json({ error: 'Unauthorized' });
        }

        return next();
    };
}

function asyncRoute(handler) {
    return (request, response, next) => {
        Promise.resolve(handler(request, response, next)).catch(next);
    };
}

function createErrorResponse(error) {
    if (/not found/i.test(error.message || '')) {
        return { status: 404, body: { error: error.message } };
    }

    if (/unsupported|missing|required|invalid/i.test(error.message || '')) {
        return { status: 400, body: { error: error.message } };
    }

    return { status: 500, body: { error: error.message || 'Internal server error' } };
}

class ContextResolver {
    #config;
    #cache = new Map();
    #pending = new Map();

    constructor(config) {
        this.#config = config;
    }

    async resolve(userHandle) {
        const handle = userHandle || this.#config.userHandle || 'default-user';

        if (this.#cache.has(handle)) {
            return this.#cache.get(handle);
        }

        if (this.#pending.has(handle)) {
            return this.#pending.get(handle);
        }

        const promise = this.#init(handle);
        this.#pending.set(handle, promise);
        return promise;
    }

    async #init(handle) {
        const context = createHeadlessContext({ ...this.#config, userHandle: handle });
        await ensureHeadlessData(context);
        this.#cache.set(handle, context);
        this.#pending.delete(handle);
        return context;
    }
}

async function createSessionFromBody({ body, context, sessions, userHandle }) {
    let chatId = body.chatId;
    let characterId = body.characterId;

    if (!chatId) {
        const chat = await createChatFromBody({ body, context });
        chatId = chat.id;
        characterId = characterId || chat.characterId;
    } else if (!characterId) {
        const chat = await readChat(context, chatId);
        characterId = chat.characterId;
    }

    if (!characterId) {
        throw new Error('characterId is required when creating a headless session.');
    }

    return sessions.create({
        characterId,
        chatId,
        presetId: body.presetId,
        modelProfileId: body.modelProfileId,
        worldbookIds: body.worldbookIds,
        userHandle: userHandle || null,
    });
}

async function createChatFromBody({ body, context }) {
    const input = body || {};
    const character = input.characterId ? await readCharacter(context, input.characterId) : null;
    const characterName = input.characterName || character?.name || input.characterId;

    return createChat(context, {
        ...input,
        characterName,
        firstMes: input.firstMes ?? input.first_mes ?? character?.first_mes,
    });
}

function createHeadlessRouter({ config, contextResolver, defaultContext, sessions, generations }) {
    const router = express.Router();

    router.use(bearerAuth(config.token));

    router.use(asyncRoute(async (request, response, next) => {
        const userHandle = request.headers['x-user-handle'];
        request.headlessContext = userHandle
            ? await contextResolver.resolve(userHandle)
            : defaultContext;
        next();
    }));

    const ctx = (req) => req.headlessContext;

    router.get('/openapi.json', (request, response) => response.json(openApiDocument));
    router.get('/health', (request, response) => response.json({
        ok: true,
        mode: 'headless',
        dataRoot: ctx(request).dataRoot,
        provider: config.provider,
    }));

    router.get('/characters', asyncRoute(async (request, response) => response.json(await listCharacters(ctx(request)))));
    router.post('/characters', asyncRoute(async (request, response) => response.status(201).json(await createCharacter(ctx(request), request.body))));
    router.post('/characters/import', upload.single('file'), asyncRoute(async (request, response) => {
        if (!request.file) {
            return response.status(400).json({ error: 'PNG character card file is required.' });
        }

        const character = await importCharacterCard(ctx(request), {
            buffer: request.file.buffer,
            filename: resolveUploadFilename(request),
            id: request.body?.id,
        });
        return response.status(201).json(character);
    }));
    router.get('/characters/:id', asyncRoute(async (request, response) => response.json(await readCharacter(ctx(request), request.params.id))));

    router.get('/chats', asyncRoute(async (request, response) => response.json(await listChats(ctx(request)))));
    router.post('/chats', asyncRoute(async (request, response) => response.status(201).json(await createChatFromBody({ body: request.body, context: ctx(request) }))));
    router.post('/chats/:id/messages', asyncRoute(async (request, response) => {
        const message = await appendChatMessage(ctx(request), request.params.id, request.body);
        return response.status(201).json(message);
    }));
    router.post('/chats/:id/regenerate', asyncRoute(async (request, response) => {
        const chat = await readChat(ctx(request), request.params.id);
        const session = sessions.create({
            characterId: request.body?.characterId || chat.characterId,
            chatId: request.params.id,
            worldbookIds: request.body?.worldbookIds,
            presetId: request.body?.presetId,
            modelProfileId: request.body?.modelProfileId,
            userHandle: request.headers['x-user-handle'] || null,
        });
        const task = generations.start(session, {
            mode: 'regenerate',
            options: request.body?.parameters || {},
            savePartial: request.body?.savePartial,
        });
        return response.status(202).json({ ...task, events: `/api/headless/v1/generations/${task.id}/events` });
    }));
    router.post('/chats/:id/continue', asyncRoute(async (request, response) => {
        const chat = await readChat(ctx(request), request.params.id);
        const session = sessions.create({
            characterId: request.body?.characterId || chat.characterId,
            chatId: request.params.id,
            worldbookIds: request.body?.worldbookIds,
            presetId: request.body?.presetId,
            modelProfileId: request.body?.modelProfileId,
            userHandle: request.headers['x-user-handle'] || null,
        });
        const task = generations.start(session, {
            mode: 'continue',
            options: request.body?.parameters || {},
            savePartial: request.body?.savePartial,
        });
        return response.status(202).json({ ...task, events: `/api/headless/v1/generations/${task.id}/events` });
    }));
    router.get('/chats/:id', asyncRoute(async (request, response) => response.json(await readChat(ctx(request), request.params.id))));
    router.post('/chats/:id/rewind', asyncRoute(async (request, response) => response.json(await rewindChat(ctx(request), request.params.id))));

    router.get('/presets', asyncRoute(async (request, response) => response.json(await listPresets(ctx(request), request.query.apiId))));
    router.post('/presets', asyncRoute(async (request, response) => response.status(201).json(await createPreset(ctx(request), request.body))));
    router.post('/presets/import', upload.single('file'), asyncRoute(async (request, response) => {
        const preset = await importPresetJson(ctx(request), {
            apiId: request.body?.apiId || 'openai',
            name: request.body?.name,
            filename: resolveUploadFilename(request),
            buffer: request.file?.buffer,
            text: request.body?.json,
            data: request.body?.preset,
        });
        return response.status(201).json(preset);
    }));

    router.get('/model-profiles', asyncRoute(async (request, response) => {
        const includeSecret = request.query.includeSecret === 'true';
        return response.json(await listModelProfiles(ctx(request), { includeSecret }));
    }));
    router.post('/model-profiles', asyncRoute(async (request, response) => response.status(201).json(await createModelProfile(ctx(request), request.body))));
    router.get('/model-profiles/:id', asyncRoute(async (request, response) => {
        const includeSecret = request.query.includeSecret === 'true';
        return response.json(await readModelProfile(ctx(request), request.params.id, { includeSecret }));
    }));
    router.put('/model-profiles/:id', asyncRoute(async (request, response) => response.json(await updateModelProfile(ctx(request), request.params.id, request.body))));

    router.get('/worldbooks', asyncRoute(async (request, response) => response.json(await listWorldbooks(ctx(request)))));
    router.post('/worldbooks', asyncRoute(async (request, response) => response.status(201).json(await createWorldbook(ctx(request), request.body))));

    router.get('/sessions', (request, response) => response.json(sessions.list()));
    router.get('/sessions/:id', (request, response) => {
        const session = sessions.get(request.params.id);
        if (!session) {
            return response.status(404).json({ error: 'Session not found.' });
        }

        return response.json(session);
    });
    router.post('/sessions', asyncRoute(async (request, response) => {
        const session = await createSessionFromBody({
            body: request.body || {},
            context: ctx(request),
            sessions,
            userHandle: request.headers['x-user-handle'] || null,
        });
        return response.status(201).json(session);
    }));
    router.post('/sessions/:id/config', (request, response) => {
        const session = sessions.update(request.params.id, request.body || {});
        if (!session) {
            return response.status(404).json({ error: 'Session not found.' });
        }

        return response.json(session);
    });

    router.get('/generations', (request, response) => response.json(generations.list()));
    router.post('/generate', asyncRoute(async (request, response) => {
        const session = sessions.get(request.body?.sessionId);
        if (!session) {
            return response.status(404).json({ error: 'Session not found.' });
        }

        const task = generations.start(session, {
            input: request.body?.input || '',
            mode: request.body?.mode || 'new',
            options: request.body?.parameters || {},
            savePartial: request.body?.savePartial,
        });
        return response.status(202).json({ ...task, events: `/api/headless/v1/generations/${task.id}/events` });
    }));
    router.post('/generations/:id/stop', (request, response) => {
        const task = generations.stop(request.params.id, request.body || {});
        if (!task) {
            return response.status(404).json({ error: 'Generation not found.' });
        }

        return response.json(task);
    });
    router.get('/generations/:id/events', (request, response) => generations.subscribe(request.params.id, response));

    return router;
}

function createAdminRouter({ config, generations, sessions }) {
    const router = express.Router();

    router.get('/admin', (request, response) => {
        if (request.query.token !== config.token) {
            return response.status(401).send('Unauthorized');
        }

        return response.type('html').send(`<!doctype html>
<html>
<head><title>SillyTavern Headless</title></head>
<body>
<h1>SillyTavern Headless</h1>
<pre>${JSON.stringify({ sessions: sessions.list(), generations: generations.list() }, null, 2)}</pre>
</body>
</html>`);
    });

    return router;
}

export async function createHeadlessApp(overrides = {}) {
    const config = resolveHeadlessConfig(overrides);
    globalThis.DATA_ROOT = config.dataRoot;

    const contextResolver = new ContextResolver(config);
    const defaultContext = await contextResolver.resolve();

    const sessions = new SessionStore();
    const provider = overrides.providerAdapter || createGenerationProvider(config);
    const resolveContext = (handle) => contextResolver.resolve(handle);
    const generations = new GenerationManager({ context: defaultContext, resolveContext, provider });
    const app = express();

    app.disable('x-powered-by');
    app.use(helmet({ contentSecurityPolicy: false }));
    app.use(compression());
    app.use(express.json({ limit: '50mb' }));
    app.use(express.urlencoded({ extended: true, limit: '50mb' }));
    app.use('/api/headless/v1', createHeadlessRouter({ config, contextResolver, defaultContext, sessions, generations }));

    if (config.adminEnabled) {
        app.use(createAdminRouter({ config, generations, sessions }));
    }

    app.use((error, request, response, next) => {
        const result = createErrorResponse(error);
        console.error('Headless API error:', error);
        return response.status(result.status).json(result.body);
    });

    return { app, config, context: defaultContext, sessions, generations };
}

export async function startHeadlessServer(overrides = {}) {
    const { app, config } = await createHeadlessApp(overrides);
    const server = http.createServer(app);

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
            server.off('error', reject);
            resolve();
        });
    });

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    console.log(`SillyTavern headless API listening on http://${config.host}:${port}`);
    return server;
}
