import { resolveTelegramGatewayConfig } from './config.js';
import { TelegramGateway } from './telegram-gateway.js';

export async function startTelegramGateway(options = {}) {
    const config = resolveTelegramGatewayConfig(options);
    const gateway = await TelegramGateway.create(config, options);
    await gateway.start();
    return gateway;
}
