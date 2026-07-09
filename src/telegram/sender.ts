import { TelegramClient } from "telegram";
import { Api } from "telegram";
import { logger } from "../utils/logger";
import { getConfig, QueueItem, incrementStats } from "../utils/store";
import { getMonetizationLink } from "./monitizee";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripConfiguredPhrases(text: string, phrases: string[]): string {
  if (!text || !phrases || phrases.length === 0) return text;

  let output = text;
  for (const phrase of phrases) {
    const trimmed = (phrase || "").trim();
    if (!trimmed) continue;
    const pattern = new RegExp(escapeRegex(trimmed), "gi");
    output = output.replace(pattern, "");
  }

  return output;
}

/** Strip trailer marker text from a caption so it doesn't appear in the outgoing post. */
function stripTrailerMarkers(text: string): string {
  return text
    .replace(/⬇️\s*FULL(?:\s*⬇️)*/gu, "") // ⬇️FULL / ⬇️FULL⬇️ / ⬇️ FULL ⬇️ etc.
    .replace(/(?:👇🔤*)+/gu, "") // 👇🔤🔤🔤🔤 (old marker)
    .replace(/(?:👇){2,}/gu, "") // 👇👇👇 (new marker)
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Pull every #hashtag out of raw caption text. */
function extractHashtags(text: string): string[] {
  const found = text.match(/#[^\s#]+/g) || [];
  return [...new Set(found)];
}

/** Remove #hashtags from text (they'll appear in the dedicated section). */
function stripHashtags(text: string): string {
  return text
    .replace(/#[^\s#]+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripExternalLinks(text: string): string {
  if (!text) return "";

  let cleaned = text;

  // Remove full URLs
  cleaned = cleaned.replace(/https?:\/\/[^\s]+/gi, "");

  // Remove t.me style links without protocol
  cleaned = cleaned.replace(/(?:^|\s)(t\.me\/[^\s]+)/gi, " ");

  // Remove bare domains like ordergirls.com, sub.domain.co/path
  cleaned = cleaned.replace(/(?:^|\s)([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?)/gi, " ");

  // Normalize whitespace and clean dangling separators
  cleaned = cleaned
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return cleaned;
}

function buildCaptionWithEntities(
  gifCaption: string,
  links: string[],
  removePhrases: string[],
  configHashtags: string[],
): { text: string; entities?: Api.TypeMessageEntity[] } {
  // Extract hashtags from raw caption before any stripping
  const captionHashtags = extractHashtags(gifCaption);

  // Build base caption: strip markers → remove configured phrases → strip hashtags → strip links
  const withoutMarkers = stripTrailerMarkers(gifCaption);
  const withoutPhrases = stripConfiguredPhrases(withoutMarkers, removePhrases);
  const withoutHashtags = stripHashtags(withoutPhrases);
  const baseCaption = stripExternalLinks(withoutHashtags);

  // Merge caption hashtags + configured global hashtags, deduplicated, normalised with #
  const normalise = (h: string) => (h.startsWith("#") ? h : `#${h}`);
  const allHashtags = [...new Set([...captionHashtags, ...configHashtags.map(normalise)])].filter(Boolean);
  const hashtagLine = allHashtags.length > 0 ? allHashtags.join(" ") : null;

  if (links.length === 0) {
    const parts: string[] = [baseCaption];
    if (hashtagLine) parts.push("", hashtagLine);
    return { text: parts.join("\n") };
  }

  // Final layout:
  //   [caption body]
  //
  //   #hashtags          ← only if any
  //
  //
  //   👇👇👇
  //   • Watch full video here
  //   👆👆👆

  const lines: string[] = [];
  const entities: Api.TypeMessageEntity[] = [];

  if (baseCaption.length > 0) {
    lines.push(baseCaption);
    lines.push("");
  }

  if (hashtagLine) {
    lines.push(hashtagLine);
    lines.push("");
    lines.push("");
  }

  links.forEach((link, idx) => {
    const label = links.length === 1 ? "Watch full video here" : `Watch full Part ${idx + 1} video here`;
    const line = `👉👉 ${label}`;

    const currentOffset = lines.join("\n").length + (lines.length > 0 ? 1 : 0);
    const boldOffset = currentOffset + 4; // after "• "
    const boldLength = label.length;

    lines.push(line);

    entities.push(new Api.MessageEntityBold({ offset: boldOffset, length: boldLength }));
    entities.push(new Api.MessageEntityTextUrl({ offset: boldOffset, length: boldLength, url: link }));
  });

  return { text: lines.join("\n"), entities };
}

/**
 * Process a single queue item:
 * 1. For each media file, get a monetization link from monitizee bot
 * 2. Send the GIF+caption to each target channel
 * 3. Edit the sent message to add monetization links
 */
export async function processQueueItem(client: TelegramClient, item: QueueItem): Promise<boolean> {
  const config = getConfig();

  logger.info(`Processing queue item ${item.id}: GIF #${item.gifMessageId} with ${item.mediaMessageIds.length} media`);

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
      incrementStats("totalFailed");
      return false;
    }

    // Step 2: Send the GIF to each target channel (without caption first)
    const targetMessageIds: { channel: string; messageId: number }[] = [];

    for (const targetChannel of config.targetChannels) {
      try {
        // Forward the GIF message without author/caption
        const result = await client.invoke(
          new Api.messages.ForwardMessages({
            fromPeer: item.sourceChannel,
            id: [item.gifMessageId],
            toPeer: targetChannel,
            dropAuthor: true,
            noforwards: false,
          }),
        );

        // Get the message ID of the forwarded message
        let sentMsgId: number | null = null;

        if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
          for (const upd of result.updates) {
            if (upd instanceof Api.UpdateNewChannelMessage || upd instanceof Api.UpdateNewMessage) {
              const m = upd.message;
              if (m instanceof Api.Message) {
                sentMsgId = m.id;
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

    // Step 3: Edit each sent message to add monetization links
    const captionPayload = buildCaptionWithEntities(item.gifCaption, links, config.removePhrases || [], config.hashtags || []);

    for (const { channel, messageId } of targetMessageIds) {
      try {
        await client.invoke(
          new Api.messages.EditMessage({
            peer: channel,
            id: messageId,
            message: captionPayload.text,
            entities: captionPayload.entities,
            noWebpage: true,
          }),
        );
        logger.info(`Edited message ${messageId} in ${channel} with monetization links`);
        await sleep(1000);
      } catch (err: any) {
        logger.error(`Error editing message ${messageId} in ${channel}: ${err.message}`);
      }
    }

    incrementStats("totalSent");
    logger.info(`Successfully processed item ${item.id}`);
    return true;
  } catch (err: any) {
    logger.error(`Fatal error processing item ${item.id}: ${err.message}`);
    incrementStats("totalFailed");
    return false;
  }
}
