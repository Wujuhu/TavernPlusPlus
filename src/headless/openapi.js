export const openApiDocument = Object.freeze({
    openapi: '3.1.0',
    info: {
        title: 'SillyTavern Headless API',
        version: '1.0.0',
    },
    security: [{ bearerAuth: [] }],
    components: {
        securitySchemes: {
            bearerAuth: {
                type: 'http',
                scheme: 'bearer',
            },
        },
    },
    paths: {
        '/api/headless/v1/health': { get: { summary: 'Health check' } },
        '/api/headless/v1/characters': { get: { summary: 'List characters' }, post: { summary: 'Create character' } },
        '/api/headless/v1/characters/import': { post: { summary: 'Import PNG character card' } },
        '/api/headless/v1/characters/{id}': { get: { summary: 'Get character' } },
        '/api/headless/v1/chats': { get: { summary: 'List chats' }, post: { summary: 'Create chat' } },
        '/api/headless/v1/chats/{id}': { get: { summary: 'Get chat' } },
        '/api/headless/v1/chats/{id}/messages': { post: { summary: 'Append chat message' } },
        '/api/headless/v1/chats/{id}/regenerate': { post: { summary: 'Regenerate last assistant message' } },
        '/api/headless/v1/chats/{id}/continue': { post: { summary: 'Continue generation' } },
        '/api/headless/v1/presets': { get: { summary: 'List presets' }, post: { summary: 'Create preset' } },
        '/api/headless/v1/presets/import': { post: { summary: 'Import preset JSON file' } },
        '/api/headless/v1/model-profiles': { get: { summary: 'List model API profiles' }, post: { summary: 'Create model API profile' } },
        '/api/headless/v1/model-profiles/{id}': { get: { summary: 'Get model API profile' }, put: { summary: 'Update model API profile' } },
        '/api/headless/v1/worldbooks': { get: { summary: 'List worldbooks' }, post: { summary: 'Create worldbook' } },
        '/api/headless/v1/sessions': { get: { summary: 'List sessions' }, post: { summary: 'Create session' } },
        '/api/headless/v1/sessions/{id}': { get: { summary: 'Get session' } },
        '/api/headless/v1/sessions/{id}/config': { post: { summary: 'Update session configuration' } },
        '/api/headless/v1/generate': { post: { summary: 'Create generation task' } },
        '/api/headless/v1/generations': { get: { summary: 'List generation tasks' } },
        '/api/headless/v1/generations/{id}/stop': { post: { summary: 'Stop generation task' } },
        '/api/headless/v1/generations/{id}/events': { get: { summary: 'Stream generation events' } },
    },
});
