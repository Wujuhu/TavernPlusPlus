# Headless Tavern + Telegram Gateway Usage

## 1. Edit The Config File

Runtime settings are read from:

```text
config/headless-gateway.config.json
```

Do not use environment variables for normal operation. Edit this file instead.

If the file does not exist, the default startup creates it. A template is available at:

```text
config/headless-gateway.config.example.json
```

Minimal useful config:

```json
{
    "headless": {
        "apiToken": "change-this-local-token",
        "host": "127.0.0.1",
        "port": 8001,
        "dataRoot": "./data-headless",
        "userHandle": "default-user",
        "adminEnabled": false,
        "provider": "mock",
        "mockDelayMs": 0,
        "openAiBaseUrl": "",
        "openAiApiKey": "",
        "openAiModel": "gpt-4o-mini"
    },
    "telegram": {
        "enabled": true,
        "botToken": "123456:telegram-bot-token",
        "registerCommands": true,
        "pollTimeoutSeconds": 25
    }
}
```

If `headless.apiToken` is empty, the first default start generates one and writes it back to this config file.

## 2. Runtime Modes

Default mode runs the headless SillyTavern API plus the Telegram gateway:

```powershell
npm.cmd start
```

Original SillyTavern Web UI runs only when explicitly requested:

```powershell
npm.cmd run start:original
```

You can use another config path if needed:

```powershell
node server.js --headlessConfig .\config\my-headless-config.json
```

## 3. Telegram Commands

When `telegram.registerCommands` is `true`, startup calls Telegram `setMyCommands` and replaces the old command list shown in the Telegram app for this bot.

- `/help` shows the command list.
- Upload a PNG SillyTavern character card as a file/document to import and select it. Do not send it as a compressed Telegram photo, because photo uploads strip the PNG metadata used by character cards.
- Upload a JSON preset file as a file/document to import it as an OpenAI-compatible preset and select it.
- `/setmodel name baseUrl apiKey model` saves and selects a model API profile.
- `/models` lists saved model API profiles.
- `/model id` switches model API profile.
- `/characters` lists imported character cards.
- `/character id` switches character.
- `/presets` lists imported OpenAI-compatible presets.
- `/preset id` switches preset.
- `/newchat` starts a new chat on the next message.
- `/status` shows the current Telegram chat configuration.

Example model setup:

```text
/setmodel main https://api.openai.com/v1 sk-... gpt-4o-mini
```

OpenAI-compatible local model example:

```text
/setmodel local http://127.0.0.1:11434/v1 ollama llama3.1
```

After a character and model profile are selected, normal Telegram messages are sent to the headless generation API and the reply is returned in Telegram.

## 4. Data Storage

Persistent runtime data is stored under:

```text
data-headless/
```

This includes imported character cards, JSON presets, chats, model profiles, and Telegram chat selections. Users do not need to re-enter their model API, selected character, or selected preset for every conversation.

## 5. Troubleshooting

When the gateway is running, the command line prints Telegram update, file import, command, and generation status logs. It does not print API keys.

If a PNG upload has no import result, check how it was sent in Telegram:

- Sending as a photo shows a bot message asking you to resend the card as a file/document.
- Sending as a file/document imports the card and replies with `Character card imported and selected`.

If a chat message shows `Generating...` and then fails, the bot replies with the backend error returned by the headless generation stream. Check the command-line log for the matching `Generation started` and failure lines.
