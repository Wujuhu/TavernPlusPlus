export class TelegramApi {
    constructor({ token, fetchImpl = fetch }) {
        this.token = token;
        this.fetch = fetchImpl;
        this.baseUrl = `https://api.telegram.org/bot${token}`;
    }

    async call(method, payload = {}) {
        const response = await this.fetch(`${this.baseUrl}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await response.json();

        if (!response.ok || !data.ok) {
            throw new Error(`Telegram API ${method} failed: ${JSON.stringify(data)}`);
        }

        return data.result;
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
