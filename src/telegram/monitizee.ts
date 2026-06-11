import { TelegramClient } from 'telegram';
import { Api } from 'telegram';
import { NewMessage } from 'telegram/events';
import { logger } from '../utils/logger';

const MONITIZEE_BOT = process.env.MONITIZEE_BOT || 'monitizeebot';
const LINK_REGEX = /https:\/\/t\.me\/monitizeebot\?start=\S+/;

/**
 * Wait for a response from the monitizee bot after forwarding media.
 * Returns the monetization link or null on timeout.
 */
async function waitForBotResponse(client: TelegramClient, timeoutMs = 30000): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        client.removeEventHandler(handler, new NewMessage({ fromUsers: [MONITIZEE_BOT] }));
        resolve(null);
      }
    }, timeoutMs);

    const handler = async (event: any) => {
      if (resolved) return;
      const msg = event.message;
      if (!msg || !msg.message) return;

      const text: string = msg.message;
      const match = text.match(LINK_REGEX);
      if (match) {
        resolved = true;
        clearTimeout(timer);
        client.removeEventHandler(handler, new NewMessage({ fromUsers: [MONITIZEE_BOT] }));
        resolve(match[0]);
      }
    };

    client.addEventHandler(handler, new NewMessage({ fromUsers: [MONITIZEE_BOT] }));
  });
}

/**
 * Send /create to monitizee bot, forward the media message, then wait for the link.
 */
export async function getMonetizationLink(
  client: TelegramClient,
  sourceChannel: string,
  mediaMessageId: number
): Promise<string | null> {
  try {
    logger.info(`Getting monetization link for message ${mediaMessageId} from ${sourceChannel}`);

    // Send /create command to bot
    await client.sendMessage(MONITIZEE_BOT, { message: '/create' });
    await sleep(1500);

    // Start listening for bot response BEFORE forwarding
    const linkPromise = waitForBotResponse(client, 45000);

    // Forward the media message (without caption/sender) to the bot
    await client.forwardMessages(MONITIZEE_BOT, {
      messages: [mediaMessageId],
      fromPeer: sourceChannel,
      dropAuthor: true,
      noforwards: false,
    });

    logger.info(`Forwarded message ${mediaMessageId} to ${MONITIZEE_BOT}, waiting for response...`);

    const link = await linkPromise;

    if (link) {
      logger.info(`Got monetization link: ${link}`);
    } else {
      logger.warn(`Timeout waiting for monetization link for message ${mediaMessageId}`);
    }

    return link;
  } catch (err: any) {
    logger.error(`Error getting monetization link: ${err.message}`);
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
