import { TelegramClient } from 'telegram';
import { Api } from 'telegram';
import { logger } from '../utils/logger';
import { getConfig, QueueItem, updateQueueItem, incrementStats } from '../utils/store';
import { getMonetizationLink } from './monitizee';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build the caption text with monetization links.
 * If multiple parts, list them as Part 1, Part 2, etc.
 */
function buildCaption(gifCaption: string, links: string[]): string {
  if (links.length === 0) return gifCaption;

  if (links.length === 1) {
    return `${gifCaption}\n\n**Watch full video here (${links[0]})**`;
  }

  const parts = links
    .map((link, idx) => `Watch full Part ${idx + 1} video here (${link})`)
    .join('\n');

  return `${gifCaption}\n\n${parts}`;
}

/**
 * Process a single queue item:
 * 1. For each media file, get a monetization link from monitizee bot
 * 2. Send the GIF+caption to each target channel
 * 3. Edit the sent message to add monetization links
 */
export async function processQueueItem(
  client: TelegramClient,
  item: QueueItem
): Promise<boolean> {
  const config = getConfig();

  logger.info(`Processing queue item ${item.id}: GIF #${item.gifMessageId} with ${item.mediaMessageIds.length} media`);

  updateQueueItem(item.id, { status: 'processing' });

  try {
    // Step 1: Get monetization links for each media file
    const links: string[] = [];

    for (const mediaId of item.mediaMessageIds) {
      const link = await getMonetizationLink(client, item.sourceChannel, mediaId);
      if (link) {
        links.push(link);
      } else {
        logger.warn(`Could not get link for media ${mediaId}, skipping`);
      }
      await sleep(2000); // Be polite to the bot
    }

    if (links.length === 0) {
      logger.warn(`No monetization links obtained for item ${item.id}`);
      updateQueueItem(item.id, { status: 'failed', error: 'No monetization links obtained' });
      incrementStats('totalFailed');
      return false;
    }

    updateQueueItem(item.id, { monitizeeLinks: links });

    // Step 2: Send the GIF to each target channel (without caption first)
    const targetMessageIds: { channel: string; messageId: number }[] = [];

    for (const targetChannel of config.targetChannels) {
      try {
        // Forward the GIF message without author/caption
        const result = await client.forwardMessages(targetChannel, {
          messages: [item.gifMessageId],
          fromPeer: item.sourceChannel,
          dropAuthor: true,
          noforwards: false,
        });

        // Get the message ID of the forwarded message
        let sentMsgId: number | null = null;
        if (Array.isArray(result) && result.length > 0) {
          const firstResult = result[0];
          if (firstResult instanceof Api.Message) {
            sentMsgId = firstResult.id;
          } else if ((firstResult as any)?.updates) {
            // Extract from updates
            const updates = (firstResult as any).updates;
            for (const upd of updates) {
              if (upd instanceof Api.UpdateNewChannelMessage || upd instanceof Api.UpdateNewMessage) {
                sentMsgId = (upd.message as Api.Message).id;
                break;
              }
            }
          }
        }

        if (sentMsgId) {
          targetMessageIds.push({ channel: targetChannel, messageId: sentMsgId });
          logger.info(`Sent GIF to ${targetChannel}, message ID: ${sentMsgId}`);
        } else {
          logger.warn(`Could not determine message ID for ${targetChannel}`);
        }

        await sleep(config.sendDelayMs);
      } catch (err: any) {
        logger.error(`Error sending to ${targetChannel}: ${err.message}`);
      }
    }

    updateQueueItem(item.id, { targetMessageIds });

    // Step 3: Edit each sent message to add monetization links
    const caption = buildCaption(item.gifCaption, links);

    for (const { channel, messageId } of targetMessageIds) {
      try {
        await client.editMessage(channel, {
          message: messageId,
          text: caption,
          parseMode: 'md',
        });
        logger.info(`Edited message ${messageId} in ${channel} with monetization links`);
        await sleep(1000);
      } catch (err: any) {
        logger.error(`Error editing message ${messageId} in ${channel}: ${err.message}`);
      }
    }

    updateQueueItem(item.id, {
      status: 'done',
      processedAt: new Date().toISOString(),
    });

    incrementStats('totalSent');
    logger.info(`Successfully processed item ${item.id}`);
    return true;
  } catch (err: any) {
    logger.error(`Fatal error processing item ${item.id}: ${err.message}`);
    updateQueueItem(item.id, { status: 'failed', error: err.message });
    incrementStats('totalFailed');
    return false;
  }
}
