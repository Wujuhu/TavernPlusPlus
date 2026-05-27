export class TelegramApi {
    constructor({ token, fetchImpl = fetch }) {
        this.token = token;
        this.fetch = fetchImpl;
        this.baseUrl = `https://api.telegram.org/bot${token}`;
    }

    async call(method, payload = {}, retries = 3) {
        for (let attempt = 0; ; attempt++) {
            const response = await this.fetch(`${this.baseUrl}/${method}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await response.json();

            if (data.ok) {
                return data.result;
            }

            if (data.error_code === 429 && attempt < retries) {
                const wait = Math.min((data.parameters?.retry_after ?? 1) * 1000, 30000);
                console.warn(`Telegram 429 on ${method}: retrying in ${wait}ms (attempt ${attempt + 1}/${retries})`);
                await new Promise(r => setTimeout(r, wait));
                continue;
            }

            throw new Error(`Telegram API ${method} failed: ${JSON.stringify(data)}`);
        }
    }

    getUpdates({ offset, timeout }) {
        return this.call('getUpdates', {
            offset,
            timeout,
            allowed_updates: ['message'],
        });
    }

    sendMessage(chatId, text, extra = {}) {
        return this.call('sendMessage', {
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
            ...extra,
        });
    }

    editMessageText(chatId, messageId, text, extra = {}) {
        return this.call('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text,
            disable_web_page_preview: true,
            ...extra,
        });
    }

    sendChatAction(chatId, action = 'typing', extra = {}) {
        return this.call('sendChatAction', { chat_id: chatId, action, ...extra });
    }

    setMyCommands(commands) {
        return this.call('setMyCommands', { commands });
    }

    async downloadFile(fileId) {
        const file = await this.call('getFile', { file_id: fileId });
        const response = await this.fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);

        if (!response.ok) {
            throw new Error(`Telegram file download failed: ${response.status}`);
        }

        return Buffer.from(await response.arrayBuffer());
    }
}
