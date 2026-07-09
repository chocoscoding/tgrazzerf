import { getClient } from "../telegram/client";
import { scrapeChannel } from "../telegram/scraper";
import { processQueueItem } from "../telegram/sender";
import {
  getConfig,
  getQueue,
  addToQueue,
  updateQueueItem,
  updateStats,
  incrementStats,
  getLastScrapedChannel,
  saveLastScrapedChannel,
  QueueItem,
} from "../utils/store";

// Fallback cap when maxPerRun is unset/zero — effectively unlimited
const MAX_GROUPS_PER_CHANNEL = 10_000;
import { logger } from "../utils/logger";

let isRunning = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main runner.
 *
 * Flow per run:
 *   1. Drain any items left "pending" in the persistent queue from earlier runs.
 *   2. Round-robin the source channels: scrape ONE complete group (trailer +
 *      media) from a channel, post it, then move to the next channel, wrapping
 *      around until the run cap is met or every channel has nothing new.
 *      The rotation position persists across runs, so the next job resumes
 *      from the channel after the last one scraped.
 *
 * @param maxGroups  Optional cap on how many groups to process this run.
 *                   Omit (or pass undefined) to use the configured maxPerRun.
 */
export async function runJob(maxGroups?: number): Promise<void> {
  if (isRunning) {
    logger.warn("Job already running, skipping this trigger");
    return;
  }

  const config = getConfig();

  if (!config.active) {
    logger.info("Scheduler is inactive, skipping run");
    return;
  }

  if (config.sourceChannels.length === 0) {
    logger.warn("No source channels configured");
    return;
  }

  if (config.targetChannels.length === 0) {
    logger.warn("No target channels configured");
    return;
  }

  isRunning = true;
  const startTime = Date.now();
  logger.info("=== Job started ===");

  let processedCount = 0; // successful posts
  let attempted = 0; // items counted against the run cap

  try {
    const client = await getClient();

    // Explicit maxGroups (manual run) wins; otherwise honour the configured maxPerRun
    const configuredMax = config.maxPerRun > 0 ? config.maxPerRun : MAX_GROUPS_PER_CHANNEL;
    const cap = maxGroups ?? configuredMax;

    const stopRequested = () => !getConfig().active;

    const handleItem = async (item: QueueItem) => {
      updateQueueItem(item.id, { status: "processing" });
      try {
        const success = await processQueueItem(client, item);
        if (success) processedCount++;
        updateQueueItem(item.id, {
          status: success ? "done" : "failed",
          processedAt: new Date().toISOString(),
        });
        incrementStats("totalProcessed");
      } catch (err: any) {
        logger.error(`Error processing item ${item.id}: ${err.message}`);
        updateQueueItem(item.id, {
          status: "failed",
          error: err.message,
          processedAt: new Date().toISOString(),
        });
      }
      attempted++;
      await sleep(config.sendDelayMs);
    };

    // ── 1. Drain items left pending from earlier runs ────────────────────────
    let aborted = false;
    for (const item of getQueue().filter((q) => q.status === "pending")) {
      if (attempted >= cap) break;
      if (stopRequested()) {
        aborted = true;
        break;
      }
      await handleItem(item);
    }

    // ── 2. Round-robin the source channels: one group each, rotating ─────────
    const channels = config.sourceChannels;
    const lastUsed = getLastScrapedChannel();
    // Resume from the channel after the last one scraped (indexOf → -1 falls back to 0)
    let idx = lastUsed ? (channels.indexOf(lastUsed) + 1) % channels.length : 0;
    const exhausted = new Set<string>();

    while (!aborted && attempted < cap && exhausted.size < channels.length) {
      if (stopRequested()) {
        aborted = true;
        break;
      }

      const channel = channels[idx];
      idx = (idx + 1) % channels.length;
      if (exhausted.has(channel)) continue;

      let scraped: QueueItem[] = [];
      try {
        scraped = await scrapeChannel(client, channel, 1);
      } catch (err: any) {
        logger.error(`Error scraping ${channel}: ${err.message}`);
      }

      if (scraped.length === 0) {
        logger.info(`[rotation] ${channel} has nothing new — out of rotation for this run`);
        exhausted.add(channel);
        continue;
      }

      const item = scraped[0];
      addToQueue(item);
      saveLastScrapedChannel(channel);
      logger.info(`[rotation] 1 group from ${channel} → processing`);
      await handleItem(item);
    }

    if (aborted) {
      logger.warn("Scheduler deactivated mid-run — aborting remaining items");
    } else if (attempted === 0) {
      logger.info("No items to process this run");
    }
  } catch (err: any) {
    logger.error(`Job error: ${err.message}`);
  } finally {
    isRunning = false;
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`=== Job finished in ${duration}s. Processed: ${processedCount} ===`);
    updateStats({ lastRunAt: new Date().toISOString(), lastRunProcessed: processedCount });
  }
}

export function getIsRunning(): boolean {
  return isRunning;
}
