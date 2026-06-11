import cron from 'node-cron';
import { getConfig } from '../utils/store';
import { runJob } from './runner';
import { logger } from '../utils/logger';

let currentTask: cron.ScheduledTask | null = null;

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
