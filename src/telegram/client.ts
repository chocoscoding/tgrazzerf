import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { logger } from '../utils/logger';
import dotenv from 'dotenv';

dotenv.config();

let client: TelegramClient | null = null;

export async function getClient(): Promise<TelegramClient> {
  if (client && client.connected) return client;

  const apiId = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
  const apiHash = process.env.TELEGRAM_API_HASH || '';
  const sessionStr = process.env.TELEGRAM_SESSION || '';

  if (!apiId || !apiHash) {
    throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in .env');
  }

  const session = new StringSession(sessionStr);
  client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    retryDelay: 1000,
    autoReconnect: true,
    requestRetries: 3,
  });

  await client.connect();
  logger.info('Telegram client connected');
  return client;
}

export async function disconnectClient() {
  if (client) {
    await client.disconnect();
    client = null;
    logger.info('Telegram client disconnected');
  }
}
