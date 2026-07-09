import { getClient } from "../telegram/client";
import { scrapeChannel } from "../telegram/scraper";
import { processQueueItem } from "../telegram/sender";
import { getConfig, getQueue, updateStats, incrementStats, QueueItem } from "../utils/store";

// Scrape at most this many groups per channel per run — effectively unlimited
const MAX_GROUPS_PER_CHANNEL = 10_000;
import { logger } from "../utils/logger";

let isRunning = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main runner: scrapes all source channels then processes found groups.
 * @param maxGroups  Optional cap on how many groups to process this run.
 *                   Omit (or pass undefined) to process everything available.
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

  let processedCount = 0;

  try {
    const client = await getClient();
    // ── 1. Collect items to process ──────────────────────────────────────────
    // Start with anything already pending in the persistent queue
    const existingPending = getQueue().filter((q) => q.status === "pending");
    const itemsToProcess: QueueItem[] = [...existingPending];

    // Scrape every source channel — find groups since last checkpoint
    const groupCap = maxGroups ?? MAX_GROUPS_PER_CHANNEL;
    for (const channel of config.sourceChannels) {
      if (itemsToProcess.length >= groupCap) break;
      try {
        const remaining = groupCap - itemsToProcess.length;
        const scraped = await scrapeChannel(client, channel, remaining);
        logger.info(`Scraped ${scraped.length} item(s) from ${channel}`);
        itemsToProcess.push(...scraped);
        if (scraped.length > 0) await sleep(1500);
      } catch (err: any) {
        logger.error(`Error scraping ${channel}: ${err.message}`);
      }
    }

    // Honour the cap on the total list (includes pre-existing pending)
    if (maxGroups && itemsToProcess.length > maxGroups) {
      itemsToProcess.splice(maxGroups);
    }

    if (itemsToProcess.length === 0) {
      logger.info("No items to process this run");
      return;
    }

    logger.info(`Processing ${itemsToProcess.length} item(s) this run`);

    // ── 2. Process each item sequentially ────────────────────────────────────
    for (const item of itemsToProcess) {
      try {
        const success = await processQueueItem(client, item);
        if (success) processedCount++;
        incrementStats("totalProcessed");
      } catch (err: any) {
        logger.error(`Error processing item ${item.id}: ${err.message}`);
      }
      await sleep(config.sendDelayMs);
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
