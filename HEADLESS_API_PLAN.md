# SillyTavern Headless API-First v1 Plan

## Summary

- Keep the original SillyTavern Web UI, plugins, character cards, world info, presets, chats, and user experience available through an explicit original-mode startup.
- Make the default runtime a headless SillyTavern API plus an integrated Telegram gateway.
- Use REST for resource control and SSE for streaming output in v1, because it is simple to debug and easy for external agents to consume.
- Use an independent data directory in v1. Sharing or bidirectional sync with the original SillyTavern instance is explicitly out of scope for the first phase.

## Runtime Shape

- Original instance:
  - Runs only with `node server.js --original` or `npm run start:original`.
  - Keeps the existing configured port, defaulting to `8000`.
  - Keeps the original browser-based access path.
- Headless plus gateway instance:
  - Runs by default with `node server.js`, `npm start`, or `npm run start:headless`.
  - Default bind address: `127.0.0.1`.
  - Default port: `8001`.
  - Default data root: `./data-headless`.
  - Does not launch the browser or serve the full SillyTavern Web UI.
  - Starts the Telegram gateway when `telegram.botToken` is configured in `config/headless-gateway.config.json`.
- Security:
  - Require `Authorization: Bearer <token>` on all headless API routes.
  - Read the token from `headless.apiToken` in `config/headless-gateway.config.json`.
  - Fail startup if no token is configured.
  - Keep CORS disabled by default.

## API Surface

Use `/api/headless/v1` as the stable public prefix.

- `GET /health`
- `GET /characters`
- `POST /characters`
- `GET /characters/:id`
- `POST /characters/import`
- `GET /chats`
- `POST /chats`
- `GET /chats/:id`
- `POST /chats/:id/messages`
- `POST /chats/:id/regenerate`
- `POST /chats/:id/continue`
- `GET /presets`
- `POST /presets`
- `POST /presets/import`
- `GET /model-profiles`
- `POST /model-profiles`
- `GET /model-profiles/:id`
- `PUT /model-profiles/:id`
- `GET /worldbooks`
- `POST /worldbooks`
- `POST /sessions`
- `GET /sessions/:id`
- `POST /sessions/:id/config`
- `POST /generate`
- `POST /generations/:id/stop`
- `GET /generations/:id/events`

SSE event names are fixed:

- `meta`
- `token`
- `message`
- `done`
- `error`

Generation control behavior:

- `POST /generate` creates a generation task and returns a `generationId`.
- `GET /generations/:id/events` streams output for that task.
- `POST /generations/:id/stop` cancels the task with `AbortController`.
- Stop saves the partial assistant message by default.
- The caller can pass `savePartial: false` to discard partial output.

## Implementation Plan

- Add `src/headless/` modules for server setup, auth, sessions, characters, chats, presets, model profiles, worldbooks, generation, and SSE.
- Add `src/gateway/` modules for Telegram Bot API polling, file import, command handling, persistent chat selections, and headless API calls.
- Reuse SillyTavern's existing file formats wherever possible:
  - character cards remain compatible with existing character storage;
  - chats remain JSONL-compatible;
  - world info and presets keep their existing JSON storage shape.
- Add stable message IDs under `extra.headless.id` so external clients can target messages without breaking existing SillyTavern chat files.
- Build a v1 prompt compiler that reads character, chat history, preset, and world info data and produces deterministic model input.
- Prioritize OpenAI-compatible/chat-completions style backends first. Other SillyTavern backend adapters can be added after the API contract is stable.
- Telegram users can upload PNG character cards, upload JSON presets, save model API profiles, switch character/preset/model configuration, and chat without re-entering those settings on every message.

## Data Policy

- v1 uses `./data-headless` by default.
- Headless API token, model profiles, imported files, chats, and Telegram gateway state are persisted under `./data-headless`.
- Do not require real-time sync with the original `./data`.
- Provide a one-time copy/import script later for selected assets:
  - characters;
  - world info;
  - presets;
  - chats.
- Do not copy secrets by default. API keys and backend credentials should be configured explicitly for the headless instance.

## Test Plan

- Unit tests:
  - bearer token auth;
  - session lifecycle;
  - JSONL chat read/write;
  - stable message IDs;
  - world info trigger selection;
  - prompt compilation;
  - SSE event ordering;
  - stop, regenerate, and continue behavior.
- Integration tests:
  - run the headless server with a temporary `data-headless`;
  - use a mock LLM backend;
  - create a character;
  - create a chat;
  - send a user message;
  - stream an assistant response;
  - stop generation;
  - regenerate the last assistant response;
  - continue generation.
- Coexistence test:
  - run default headless plus gateway mode;
  - run explicit original SillyTavern mode separately;
  - confirm the selected mode is exclusive;
  - confirm headless writes only to `data-headless`.

## Assumptions

- v1 optimizes for stability, low intrusion, and external agent control rather than perfect parity with every Web UI generation path.
- The original SillyTavern code remains the upstream base.
- The default `server.js` startup path is now headless plus gateway. Original SillyTavern mode remains available behind an explicit original-mode parameter.
- First phase does not promise live bidirectional sync with the original SillyTavern instance.
