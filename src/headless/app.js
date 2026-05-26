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
    updateModelProfile,
} from './storage.js';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024,
    },
});

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

async function createSessionFromBody({ body, context, sessions }) {
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

function createHeadlessRouter({ config, context, sessions, generations }) {
    const router = express.Router();

    router.use(bearerAuth(config.token));
    router.get('/openapi.json', (request, response) => response.json(openApiDocument));
    router.get('/health', (request, response) => response.json({
        ok: true,
        mode: 'headless',
        dataRoot: context.dataRoot,
        provider: config.provider,
    }));

    router.get('/characters', asyncRoute(async (request, response) => response.json(await listCharacters(context))));
    router.post('/characters', asyncRoute(async (request, response) => response.status(201).json(await createCharacter(context, request.body))));
    router.post('/characters/import', upload.single('file'), asyncRoute(async (request, response) => {
        if (!request.file) {
            return response.status(400).json({ error: 'PNG character card file is required.' });
        }

        const character = await importCharacterCard(context, {
            buffer: request.file.buffer,
            filename: request.file.originalname,
            id: request.body?.id,
        });
        return response.status(201).json(character);
    }));
    router.get('/characters/:id', asyncRoute(async (request, response) => response.json(await readCharacter(context, request.params.id))));

    router.get('/chats', asyncRoute(async (request, response) => response.json(await listChats(context))));
    router.post('/chats', asyncRoute(async (request, response) => response.status(201).json(await createChatFromBody({ body: request.body, context }))));
    router.post('/chats/:id/messages', asyncRoute(async (request, response) => {
        const message = await appendChatMessage(context, request.params.id, request.body);
        return response.status(201).json(message);
    }));
    router.post('/chats/:id/regenerate', asyncRoute(async (request, response) => {
        const chat = await readChat(context, request.params.id);
        const session = sessions.create({
            characterId: request.body?.characterId || chat.characterId,
            chatId: request.params.id,
            worldbookIds: request.body?.worldbookIds,
            presetId: request.body?.presetId,
        });
        const task = generations.start(session, {
            mode: 'regenerate',
            options: request.body?.parameters || {},
            savePartial: request.body?.savePartial,
        });
        return response.status(202).json({ ...task, events: `/api/headless/v1/generations/${task.id}/events` });
    }));
    router.post('/chats/:id/continue', asyncRoute(async (request, response) => {
        const chat = await readChat(context, request.params.id);
        const session = sessions.create({
            characterId: request.body?.characterId || chat.characterId,
            chatId: request.params.id,
            worldbookIds: request.body?.worldbookIds,
            presetId: request.body?.presetId,
        });
        const task = generations.start(session, {
            mode: 'continue',
            options: request.body?.parameters || {},
            savePartial: request.body?.savePartial,
        });
        return response.status(202).json({ ...task, events: `/api/headless/v1/generations/${task.id}/events` });
    }));
    router.get('/chats/:id', asyncRoute(async (request, response) => response.json(await readChat(context, request.params.id))));

    router.get('/presets', asyncRoute(async (request, response) => response.json(await listPresets(context, request.query.apiId))));
    router.post('/presets', asyncRoute(async (request, response) => response.status(201).json(await createPreset(context, request.body))));
    router.post('/presets/import', upload.single('file'), asyncRoute(async (request, response) => {
        const preset = await importPresetJson(context, {
            apiId: request.body?.apiId || 'openai',
            name: request.body?.name,
            filename: request.file?.originalname || request.body?.filename,
            buffer: request.file?.buffer,
            text: request.body?.json,
            data: request.body?.preset,
        });
        return response.status(201).json(preset);
    }));

    router.get('/model-profiles', asyncRoute(async (request, response) => response.json(await listModelProfiles(context))));
    router.post('/model-profiles', asyncRoute(async (request, response) => response.status(201).json(await createModelProfile(context, request.body))));
    router.get('/model-profiles/:id', asyncRoute(async (request, response) => response.json(await readModelProfile(context, request.params.id))));
    router.put('/model-profiles/:id', asyncRoute(async (request, response) => response.json(await updateModelProfile(context, request.params.id, request.body))));

    router.get('/worldbooks', asyncRoute(async (request, response) => response.json(await listWorldbooks(context))));
    router.post('/worldbooks', asyncRoute(async (request, response) => response.status(201).json(await createWorldbook(context, request.body))));

    router.get('/sessions', (request, response) => response.json(sessions.list()));
    router.get('/sessions/:id', (request, response) => {
        const session = sessions.get(request.params.id);
        if (!session) {
            return response.status(404).json({ error: 'Session not found.' });
        }

        return response.json(session);
    });
    router.post('/sessions', asyncRoute(async (request, response) => {
        const session = await createSessionFromBody({ body: request.body || {}, context, sessions });
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

    const context = createHeadlessContext(config);
    await ensureHeadlessData(context);

    const sessions = new SessionStore();
    const provider = overrides.providerAdapter || createGenerationProvider(config);
    const generations = new GenerationManager({ context, provider });
    const app = express();

    app.disable('x-powered-by');
    app.use(helmet({ contentSecurityPolicy: false }));
    app.use(compression());
    app.use(express.json({ limit: '50mb' }));
    app.use(express.urlencoded({ extended: true, limit: '50mb' }));
    app.use('/api/headless/v1', createHeadlessRouter({ config, context, sessions, generations }));

    if (config.adminEnabled) {
        app.use(createAdminRouter({ config, generations, sessions }));
    }

    app.use((error, request, response, next) => {
        const result = createErrorResponse(error);
        console.error('Headless API error:', error);
        return response.status(result.status).json(result.body);
    });

    return { app, config, context, sessions, generations };
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
