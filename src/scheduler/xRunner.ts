import { getClient } from "../telegram/client";
import { scanChannelForXPosts } from "../twitter/channelScanner";
import { postMediaToX, replyToX, XCredentials } from "../twitter/poster";
import { getConfig, getXCheckpoints, saveXCheckpoint, getXStats, saveXStats } from "../utils/store";
import { logger } from "../utils/logger";

let xIsRunning = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Run one X posting job.
 * @param maxPosts  Override how many posts to make this run (ignores daily cap if set).
 *                  Omit to respect the daily posts-per-day limit.
 */
export async function runXJob(maxPosts?: number): Promise<void> {
  if (xIsRunning) {
    logger.warn("[x] Job already running, skipping");
    return;
  }

  const config = getConfig();

  if (!config.xEnabled) {
    logger.info("[x] X posting disabled");
    return;
  }

  const missingCreds = !config.xApiKey || !config.xApiSecret || !config.xAccessToken || !config.xAccessTokenSecret;
  if (missingCreds) {
    logger.warn("[x] API credentials not configured");
    return;
  }

  if (!config.xSourceChannels || config.xSourceChannels.length === 0) {
    logger.warn("[x] No X source channels configured");
    return;
  }

  xIsRunning = true;
  logger.info("[x] === X job started ===");
  let postedCount = 0;

  try {
    // ── Daily limit ────────────────────────────────────────────────────────────
    const stats = getXStats();
    const today = todayUTC();

    if (stats.lastResetDate !== today) {
      stats.postsToday = 0;
      stats.lastResetDate = today;
      saveXStats(stats);
    }

    const postsPerDay = config.xPostsPerDay || 10;
    const allowedThisRun = maxPosts ?? (postsPerDay - stats.postsToday);

    if (allowedThisRun <= 0) {
      logger.info(`[x] Daily limit reached (${stats.postsToday}/${postsPerDay}), skipping`);
      return;
    }

    // ── Scan & post ────────────────────────────────────────────────────────────
    const client = await getClient();
    const xCheckpoints = getXCheckpoints();
    const creds: XCredentials = {
      apiKey: config.xApiKey,
      apiSecret: config.xApiSecret,
      accessToken: config.xAccessToken,
      accessTokenSecret: config.xAccessTokenSecret,
    };

    for (const channel of config.xSourceChannels) {
      if (postedCount >= allowedThisRun) break;

      const fromId = xCheckpoints[channel] || 0;
      const remaining = allowedThisRun - postedCount;
      const posts = await scanChannelForXPosts(client, channel, fromId, remaining);

      for (const post of posts) {
        if (postedCount >= allowedThisRun) break;

        const buffer = await client.downloadMedia(post.message, {});

        // Always advance checkpoint regardless of success so we don't retry spam
        saveXCheckpoint(channel, post.messageId);

        if (!buffer || typeof buffer === "string") {
          logger.warn(`[x] Could not download media for msg ${post.messageId}, skipping`);
          continue;
        }

        const tweetId = await postMediaToX(creds, post.tweetText, { buffer, mimeType: post.mimeType });

        if (tweetId) {
          await replyToX(creds, tweetId, post.commentText);

          postedCount++;
          stats.postsToday++;
          stats.totalPosted++;
          stats.lastPostedAt = new Date().toISOString();
          saveXStats(stats);
          logger.info(`[x] ✓ msg ${post.messageId} posted (${stats.postsToday}/${postsPerDay} today)`);
        }

        await sleep(3000); // polite gap between tweets
      }
    }
  } catch (err: any) {
    logger.error(`[x] Job error: ${err.message}`);
  } finally {
    xIsRunning = false;
    logger.info(`[x] === X job done. Posted: ${postedCount} ===`);
  }
}

export function getXIsRunning(): boolean {
  return xIsRunning;
}
