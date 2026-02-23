import { BridgeClient } from './bridgeClient';
import { loadConfig } from './config';
import { Logger } from './logger';
import { StateStore } from './stateStore';
import { TelegramBridgeBot } from './botService';
import { TelegramClient } from './telegramClient';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger();

  const stateStore = new StateStore(config.telegram.statePath, logger);
  const bridge = new BridgeClient({
    url: config.bridge.wsUrl,
    authToken: config.bridge.authToken,
    requestTimeoutMs: config.bridge.requestTimeoutMs,
    logger,
  });
  const telegram = new TelegramClient({
    apiBaseUrl: config.telegram.apiBaseUrl,
    botToken: config.telegram.botToken,
    logger,
  });

  const bot = new TelegramBridgeBot({
    config,
    logger,
    bridge,
    telegram,
    stateStore,
  });

  let stopping = false;

  const stop = (signal: string): void => {
    if (stopping) {
      return;
    }

    stopping = true;
    logger.info(`Received ${signal}. Stopping telegram bot.`);
    bot.stop();
  };

  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  await bot.start();
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[telegram-bot] Fatal error: ${message}`);
  process.exit(1);
});
