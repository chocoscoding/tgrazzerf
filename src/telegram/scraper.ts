import { TelegramClient } from "telegram";
import { Api } from "telegram";
import { logger } from "../utils/logger";
import { getCheckpoints, saveCheckpoint, QueueItem, getConfig } from "../utils/store";

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

// Channel 1: "⬇️FULL" / "⬇️ FULL" (any whitespace between)
// Channel 2: "👇🔤🔤🔤🔤" (pointing hand + letter blocks)
const TRAILER_MARKER = /⬇️\s*FULL|👇🔤+/i;

/**
 * Trailer: any media message whose caption contains the FULL download marker.
 * Can be an animated GIF, a short video clip, or a photo — the marker is what matters.
 */
function isTrailerMessage(msg: Api.Message): boolean {
  if (!msg.media) return false;
  return TRAILER_MARKER.test(msg.message || "");
}

/**
 * Content media: the actual full video/photo that gets put behind the paywall.
 * Must have media, must NOT carry the trailer marker, and must not be an animated GIF.
 */
function isContentMedia(msg: Api.Message): boolean {
  if (!msg.media) return false;
  if (TRAILER_MARKER.test(msg.message || "")) return false;

  if (msg.media instanceof Api.MessageMediaPhoto) return true;

  if (msg.media instanceof Api.MessageMediaDocument) {
    const doc = msg.media.document;
    if (!(doc instanceof Api.Document)) return false;
    const attrs = doc.attributes || [];
    if (attrs.some((a) => a instanceof Api.DocumentAttributeAnimated)) return false;
    if (attrs.some((a) => a instanceof Api.DocumentAttributeVideo)) return true;
    if (doc.mimeType && doc.mimeType.startsWith("video/")) return true;
  }

  return false;
}

interface PendingGroup {
  trailerMessageId: number;
  trailerCaption: string;
  mediaMessageIds: number[];
  /** checkpoint value that was in effect BEFORE we saw this trailer */
  checkpointBeforeTrailer: number;
}

function buildQueueItem(channelUsername: string, group: PendingGroup): QueueItem {
  return {
    id: generateId(),
    sourceChannel: channelUsername,
    gifMessageId: group.trailerMessageId,
    gifCaption: group.trailerCaption,
    mediaMessageIds: [...group.mediaMessageIds],
    status: "pending",
    monitizeeLinks: [],
    targetMessageIds: [],
    createdAt: new Date().toISOString(),
  };
}

/**
 * Scrape a channel sequentially from the last checkpoint.
 *
 * Processing rules (one message at a time, in order):
 *   trailer  → start a new pending group; finalize previous group first if it had content
 *   content  → attach to current pending group (if one is open)
 *   other    → finalize current pending group (if it has content); advance checkpoint past this message
 *
 * Checkpoint is saved:
 *   - after each completed group (set to the last content media ID in the group)
 *   - after each "other" message (set to that message's ID)
 *   - NEVER mid-group, so an interrupted run always re-discovers the pending trailer
 */
export async function scrapeChannel(client: TelegramClient, channelUsername: string, maxItems: number): Promise<QueueItem[]> {
  const checkpoints = getCheckpoints();
  const config = getConfig();
  const configuredStart = config.sourceStartFrom?.[channelUsername] ?? 0;
  const configuredEnd = config.sourceEndAt?.[channelUsername] ?? 0;
  const checkpointValue = checkpoints[channelUsername];
  const lastId = checkpointValue || configuredStart || 0;
  const startSource =
    checkpointValue != null && checkpointValue !== 0 ? "checkpoint" : configuredStart !== 0 ? "config.sourceStartFrom" : "default(0)";

  logger.info(`[scrape] channel=${channelUsername} startId=${lastId} source=${startSource}${configuredEnd ? ` endId=${configuredEnd}` : ""}`);

  const items: QueueItem[] = [];
  let currentCheckpoint = lastId;
  let pending: PendingGroup | null = null;

  const finalizeGroup = (group: PendingGroup) => {
    const item = buildQueueItem(channelUsername, group);
    items.push(item);
    const lastContentId = Math.max(...group.mediaMessageIds);
    currentCheckpoint = lastContentId;
    saveCheckpoint(channelUsername, currentCheckpoint);
    logger.info(
      `[group-complete] trailer #${group.trailerMessageId} + ${group.mediaMessageIds.length} content(s) [${group.mediaMessageIds.join(", ")}] → queued as ${item.id}`,
    );
  };

  try {
    const iter = client.iterMessages(channelUsername, {
      minId: lastId,
      reverse: true, // oldest → newest
    });

    for await (const rawMsg of iter) {
      if (!(rawMsg instanceof Api.Message)) continue;
      const msg = rawMsg as Api.Message;
      if (msg.id <= lastId) continue;

      // Optional hard stop
      if (configuredEnd && msg.id > configuredEnd) {
        logger.info(`[scrape] reached sourceEndAt=${configuredEnd}, stopping`);
        break;
      }

      const caption = msg.message || "";
      const trailer = isTrailerMessage(msg);
      const content = !trailer && isContentMedia(msg);
      const msgType: "trailer" | "content" | "other" = trailer ? "trailer" : content ? "content" : "other";

      // ── Per-message log ───────────────────────────────────────────────────
      logger.info(`[msg ${msg.id}] type=${msgType} | caption="${caption.replace(/\n/g, " ").substring(0, 100)}"`);
      // ─────────────────────────────────────────────────────────────────────

      if (trailer) {
        // Finalize any complete pending group before starting a new one
        if (pending && pending.mediaMessageIds.length > 0) {
          finalizeGroup(pending);
          if (items.length >= maxItems) break;
        }
        // If the pending trailer had no content: discard it silently.
        // Checkpoint stays at checkpointBeforeTrailer — the next run will re-discover that trailer.

        // Open new pending group; record checkpoint BEFORE the trailer so we can roll back if needed
        pending = {
          trailerMessageId: msg.id,
          trailerCaption: caption,
          mediaMessageIds: [],
          checkpointBeforeTrailer: currentCheckpoint,
        };
      } else if (content && pending) {
        // Accumulate full-video content for the open group
        pending.mediaMessageIds.push(msg.id);
      } else {
        // "other" message (text-only, button row, unrelated media)
        if (pending && pending.mediaMessageIds.length > 0) {
          // The group is complete — an unrelated message signals its boundary
          finalizeGroup(pending);
          pending = null;
          if (items.length >= maxItems) break;
        } else if (pending) {
          // Empty pending trailer followed by an unrelated message: discard trailer
          pending = null;
        }
        // Advance checkpoint past this irrelevant message so we never re-scan it
        if (msg.id > currentCheckpoint) {
          currentCheckpoint = msg.id;
          saveCheckpoint(channelUsername, currentCheckpoint);
        }
      }
    }

    // End of iterator — finalize any trailing complete group
    if (pending && pending.mediaMessageIds.length > 0 && items.length < maxItems) {
      finalizeGroup(pending);
    }
    // If pending trailer has no content at end: checkpoint stays before it so next run re-discovers it

  } catch (err: any) {
    logger.error(`Error scraping channel ${channelUsername}: ${err.message}`);
  }

  logger.info(`[scrape] done. found=${items.length} checkpoint=${currentCheckpoint}`);
  return items;
}
