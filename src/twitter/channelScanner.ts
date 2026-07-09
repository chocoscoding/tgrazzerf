import { TelegramClient } from "telegram";
import { Api } from "telegram";
import { logger } from "../utils/logger";

const MAX_TWEET_LENGTH = 280;

const X_HASHTAGS = "#nsfwtwt #nsfw #needy #egirl #porn #chudai #horny #wet #sex #wataa #goonette";

/**
 * Build the public Telegram link for a message.
 * Public channel: t.me/username/id
 * Private channel (numeric id like -1001234567890): t.me/c/1234567890/id
 */
function buildTelegramLink(channel: string, messageId: number): string {
  if (channel.startsWith("@")) {
    return `https://t.me/${channel.slice(1)}/${messageId}`;
  }
  // Strip the -100 prefix from numeric channel IDs
  const numId = channel.replace(/^-100/, "");
  return `https://t.me/c/${numId}/${messageId}`;
}

/**
 * Determine whether a message carries media we can upload to X, and which
 * MIME type to upload it as. Returns null for messages with no usable media
 * (text-only, audio, generic files, etc).
 */
function getXMedia(msg: Api.Message): { mimeType: string } | null {
  const media = msg.media;

  if (media instanceof Api.MessageMediaPhoto) {
    return { mimeType: "image/jpeg" };
  }

  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const mimeType = media.document.mimeType || "";
    if (mimeType.startsWith("video/") || mimeType.startsWith("image/")) {
      return { mimeType };
    }
  }

  return null;
}

/**
 * Strip everything added by the sender (monetisation links, arrow emojis,
 * watch-link lines) so only the clean caption + hashtags remain.
 */
function cleanCaptionForX(text: string): string {
  return text
    .replace(/https?:\/\/t\.me\/monitizeebot[^\s]*/gi, "")
    .replace(/https?:\/\/[^\s]+/gi, "")          // any remaining URLs
    .replace(/^👉+\s*.*/gim, "")                  // "👉 Watch full..." lines
    .replace(/^👈+\s*$/gim, "")                   // standalone 👈 lines
    .replace(/^•\s*Watch full.*/gim, "")           // fallback bullet lines
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface XPost {
  messageId: number;
  channel: string;
  message: Api.Message;
  mimeType: string;
  tweetText: string;
  commentText: string;
  telegramLink: string;
}

/**
 * Scan a Telegram channel for media messages that haven't been cross-posted to X yet.
 * Returns one XPost per message that has a usable media attachment and a non-empty caption.
 */
export async function scanChannelForXPosts(
  client: TelegramClient,
  channel: string,
  fromMessageId: number,
  maxPosts: number,
): Promise<XPost[]> {
  const posts: XPost[] = [];

  try {
    const iter = client.iterMessages(channel, {
      minId: fromMessageId,
      reverse: true,
    });

    for await (const rawMsg of iter) {
      if (!(rawMsg instanceof Api.Message)) continue;
      const msg = rawMsg as Api.Message;
      if (msg.id <= fromMessageId) continue;
      if (posts.length >= maxPosts) break;

      const media = getXMedia(msg);
      if (!media) continue; // skip messages with no usable media

      const rawCaption = msg.message || "";
      if (!rawCaption.trim()) continue; // skip messages with no caption

      const telegramLink = buildTelegramLink(channel, msg.id);
      const cleanCaption = cleanCaptionForX(rawCaption);

      // Append the fixed X hashtag set, truncating the caption (never the hashtags) to fit 280 chars
      const hashtagsBlock = `\n\n${X_HASHTAGS}`;
      const maxCaption = MAX_TWEET_LENGTH - hashtagsBlock.length;
      const caption = cleanCaption.length > maxCaption
        ? cleanCaption.slice(0, maxCaption - 1) + "…"
        : cleanCaption;

      const tweetText = caption ? `${caption}${hashtagsBlock}` : X_HASHTAGS;
      const commentText = `Full video on telegram:\n${telegramLink}`;

      logger.info(`[x-scan] msg ${msg.id} from ${channel} → ready`);

      posts.push({ messageId: msg.id, channel, message: msg, mimeType: media.mimeType, tweetText, commentText, telegramLink });
    }
  } catch (err: any) {
    logger.error(`[x] Error scanning ${channel}: ${err.message}`);
  }

  return posts;
}
