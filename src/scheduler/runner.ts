import { getClient } from '../telegram/client';
import { scrapeChannel } from '../telegram/scraper';
import { processQueueItem } from '../telegram/sender';
import { getConfig, getQueue, updateStats, incrementStats } from '../utils/store';
import { logger } from '../utils/logger';

let isRunning = false;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Main runner: scrapes source channels, builds queue, processes items.
 */
export async function runJob(): Promise<void> {
  if (isRunning) {
    logger.warn('Job already running, skipping this trigger');
    return;
  }

  const config = getConfig();

  if (!config.active) {
    logger.info('Scheduler is inactive, skipping run');
    return;
  }

  if (config.sourceChannels.length === 0) {
    logger.warn('No source channels configured');
    return;
  }

  if (config.targetChannels.length === 0) {
    logger.warn('No target channels configured');
    return;
  }

  isRunning = true;
  const startTime = Date.now();
  logger.info('=== Job started ===');

  let processedCount = 0;

  try {
    const client = await getClient();

    // Step 1: Scrape all source channels
    let newItems: any[] = [];
    const perChannelMax = Math.ceil(config.maxPerRun / config.sourceChannels.length);

    for (const channel of config.sourceChannels) {
      try {
        const items = await scrapeChannel(client, channel, perChannelMax);
        newItems = newItems.concat(items);
        logger.info(`Scraped ${items.length} items from ${channel}`);
        await sleep(2000);
      } catch (err: any) {
        logger.error(`Error scraping ${channel}: ${err.message}`);
      }
    }

    logger.info(`Total new items scraped: ${newItems.length}`);

    // Step 2: Also pick up any pending items from previous runs
    const allQueue = getQueue();
    const pendingItems = allQueue.filter(q => q.status === 'pending');

    // Combine new + pending, limit to maxPerRun
    const toProcess = [...newItems, ...pendingItems.filter(p => !newItems.find(n => n.id === p.id))]
      .slice(0, config.maxPerRun);

    logger.info(`Processing ${toProcess.length} items this run`);

    // Step 3: Process each item
    for (const item of toProcess) {
      try {
        const success = await processQueueItem(client, item);
        if (success) processedCount++;
        incrementStats('totalProcessed');
        await sleep(config.sendDelayMs);
      } catch (err: any) {
        logger.error(`Error processing item ${item.id}: ${err.message}`);
      }
    }
  } catch (err: any) {
    logger.error(`Job error: ${err.message}`);
  } finally {
    isRunning = false;
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`=== Job finished in ${duration}s. Processed: ${processedCount} ===`);

    updateStats({
      lastRunAt: new Date().toISOString(),
      lastRunProcessed: processedCount,
    });
  }
}

export function getIsRunning(): boolean {
  return isRunning;
}
