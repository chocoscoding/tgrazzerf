import { TelegramClient } from 'telegram';
import { Api } from 'telegram';
import { logger } from '../utils/logger';
import { getCheckpoints, saveCheckpoint, addToQueue, QueueItem } from '../utils/store';
import { v4 as uuidv4 } from 'crypto';

// Simple UUID generator without external dep
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Check if a message is a GIF (animated document or animation)
 */
function isGifMessage(msg: Api.Message): boolean {
  if (!msg.media) return false;

  // Check for MessageMediaDocument with gif/animation
  if (msg.media instanceof Api.MessageMediaDocument) {
    const doc = msg.media.document;
    if (doc instanceof Api.Document) {
      const attrs = doc.attributes || [];
      for (const attr of attrs) {
        if (attr instanceof Api.DocumentAttributeAnimated) return true;
        if (attr instanceof Api.DocumentAttributeVideo) {
          // round videos / gifs
          if ((attr as any).roundMessage) return true;
        }
      }
      // Check mime type
      if (doc.mimeType === 'image/gif') return true;
      if (doc.mimeType === 'video/mp4' && attrs.some(a => a instanceof Api.DocumentAttributeAnimated)) return true;
    }
  }

  return false;
}

/**
 * Check if a message has video/photo media (not a GIF)
 */
function isMediaMessage(msg: Api.Message): boolean {
  if (!msg.media) return false;

  if (msg.media instanceof Api.MessageMediaPhoto) return true;

  if (msg.media instanceof Api.MessageMediaDocument) {
    const doc = msg.media.document;
    if (doc instanceof Api.Document) {
      const attrs = doc.attributes || [];
      const isAnimated = attrs.some(a => a instanceof Api.DocumentAttributeAnimated);
      if (isAnimated) return false; // That's a GIF
      const isVideo = attrs.some(a => a instanceof Api.DocumentAttributeVideo);
      if (isVideo) return true;
      // Also allow general documents that are video mime types
      if (doc.mimeType && doc.mimeType.startsWith('video/')) return true;
    }
  }

  return false;
}

/**
 * Check if a message should be skipped (text-only or has buttons)
 */
function shouldSkip(msg: Api.Message): boolean {
  // Skip if has reply markup (buttons)
  if (msg.replyMarkup) return true;
  // Skip if no media at all (text only)
  if (!msg.media) return true;
  return false;
}

/**
 * Scrape a channel starting from the last checkpoint.
 * Finds GIF+caption messages and collects subsequent media messages.
 */
export async function scrapeChannel(
  client: TelegramClient,
  channelUsername: string,
  maxItems: number
): Promise<QueueItem[]> {
  const checkpoints = getCheckpoints();
  const lastId = checkpoints[channelUsername] || 0;

  logger.info(`Scraping channel: ${channelUsername} from message ID: ${lastId}`);

  const items: QueueItem[] = [];

  try {
    // Fetch messages after the checkpoint
    const messages: Api.Message[] = [];

    // Get messages in batches
    const iter = client.iterMessages(channelUsername, {
      minId: lastId,
      limit: 500,
      reverse: true, // oldest first so we process in order
    });

    for await (const msg of iter) {
      if (msg instanceof Api.Message) {
        messages.push(msg);
      }
    }

    logger.info(`Fetched ${messages.length} messages from ${channelUsername}`);

    let i = 0;
    let newCheckpointId = lastId;

    while (i < messages.length && items.length < maxItems) {
      const msg = messages[i];

      // Update checkpoint as we go
      if (msg.id > newCheckpointId) {
        newCheckpointId = msg.id;
      }

      // Skip text-only or button messages
      if (shouldSkip(msg)) {
        i++;
        continue;
      }

      // Look for GIF with caption
      if (isGifMessage(msg) && msg.message && msg.message.trim().length > 0) {
        const gifMessageId = msg.id;
        const gifCaption = msg.message.trim();
        const mediaMessageIds: number[] = [];

        // Look forward for consecutive media messages
        let j = i + 1;
        while (j < messages.length) {
          const nextMsg = messages[j];

          // Stop if next message is another GIF (start of new group)
          if (isGifMessage(nextMsg)) break;

          // Stop if text-only or has buttons
          if (shouldSkip(nextMsg)) {
            j++;
            continue;
          }

          // Collect media messages
          if (isMediaMessage(nextMsg)) {
            mediaMessageIds.push(nextMsg.id);
            if (nextMsg.id > newCheckpointId) newCheckpointId = nextMsg.id;
          }

          j++;

          // Stop collecting if we hit another GIF or too many
          if (mediaMessageIds.length >= 20) break;
        }

        if (mediaMessageIds.length > 0) {
          const item: QueueItem = {
            id: generateId(),
            sourceChannel: channelUsername,
            gifMessageId,
            gifCaption,
            mediaMessageIds,
            status: 'pending',
            monitizeeLinks: [],
            targetMessageIds: [],
            createdAt: new Date().toISOString(),
          };
          items.push(item);
          addToQueue(item);
          logger.info(`Queued item: GIF #${gifMessageId} with ${mediaMessageIds.length} media files`);

          // Skip past the media we already collected
          i = j;
        } else {
          i++;
        }
      } else {
        i++;
      }
    }

    // Save checkpoint
    if (newCheckpointId > lastId) {
      saveCheckpoint(channelUsername, newCheckpointId);
      logger.info(`Checkpoint updated for ${channelUsername}: ${newCheckpointId}`);
    }
  } catch (err: any) {
    logger.error(`Error scraping channel ${channelUsername}: ${err.message}`);
  }

  return items;
}
