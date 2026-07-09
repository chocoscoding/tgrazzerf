import cron, { ScheduledTask } from 'node-cron';
import { getConfig } from '../utils/store';
import { runJob } from './runner';
import { runXJob } from './xRunner';
import { logger } from '../utils/logger';

let currentTask: ScheduledTask | null = null;
let currentXTask: ScheduledTask | null = null;

export function startScheduler() {
  const config = getConfig();
  const schedule = config.cronSchedule || '0 0 * * *';

  if (currentTask) {
    currentTask.stop();
    currentTask = null;
  }

  logger.info(`Starting scheduler with cron: ${schedule}`);

  currentTask = cron.schedule(schedule, async () => {
    logger.info('Cron triggered, starting job...');
    await runJob();
  });

  logger.info('Scheduler started');
}

export function stopScheduler() {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
    logger.info('Scheduler stopped');
  }
}

export function restartScheduler() {
  stopScheduler();
  startScheduler();
}

export function startXScheduler() {
  const config = getConfig();
  if (!config.xEnabled || !config.xCronSchedule) return;

  if (currentXTask) {
    currentXTask.stop();
    currentXTask = null;
  }

  if (!cron.validate(config.xCronSchedule)) {
    logger.warn(`[x] Invalid X cron schedule: ${config.xCronSchedule}`);
    return;
  }

  logger.info(`[x] Starting X scheduler with cron: ${config.xCronSchedule}`);
  currentXTask = cron.schedule(config.xCronSchedule, async () => {
    logger.info('[x] X cron triggered');
    await runXJob();
  });
}

export function stopXScheduler() {
  if (currentXTask) {
    currentXTask.stop();
    currentXTask = null;
    logger.info('[x] X scheduler stopped');
  }
}

export function restartXScheduler() {
  stopXScheduler();
  startXScheduler();
}
