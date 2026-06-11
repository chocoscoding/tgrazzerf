import { Router, Request, Response } from 'express';
import {
  getConfig,
  saveConfig,
  getQueue,
  getStats,
  getCheckpoints,
  AppConfig,
  defaultConfig,
} from '../utils/store';
import { runJob, getIsRunning } from '../scheduler/runner';
import { startScheduler, stopScheduler, restartScheduler } from '../scheduler/cron';
import { logger } from '../utils/logger';

const router = Router();

// ─── Config ──────────────────────────────────────────────────────────────────

router.get('/config', (req: Request, res: Response) => {
  res.json(getConfig());
});

router.post('/config', (req: Request, res: Response) => {
  const current = getConfig();
  const updated: AppConfig = { ...current, ...req.body };
  saveConfig(updated);

  // Restart scheduler if schedule changed
  if (req.body.cronSchedule && req.body.cronSchedule !== current.cronSchedule) {
    restartScheduler();
  }

  // Start/stop based on active flag
  if (req.body.active === true && !current.active) {
    startScheduler();
  } else if (req.body.active === false && current.active) {
    stopScheduler();
  }

  logger.info('Config updated', updated);
  res.json({ success: true, config: updated });
});

// ─── Channels ─────────────────────────────────────────────────────────────────

router.post('/channels/source/add', (req: Request, res: Response) => {
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: 'channel required' });
  const config = getConfig();
  if (!config.sourceChannels.includes(channel)) {
    config.sourceChannels.push(channel);
    saveConfig(config);
  }
  res.json({ success: true, sourceChannels: config.sourceChannels });
});

router.post('/channels/source/remove', (req: Request, res: Response) => {
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: 'channel required' });
  const config = getConfig();
  config.sourceChannels = config.sourceChannels.filter(c => c !== channel);
  saveConfig(config);
  res.json({ success: true, sourceChannels: config.sourceChannels });
});

router.post('/channels/target/add', (req: Request, res: Response) => {
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: 'channel required' });
  const config = getConfig();
  if (!config.targetChannels.includes(channel)) {
    config.targetChannels.push(channel);
    saveConfig(config);
  }
  res.json({ success: true, targetChannels: config.targetChannels });
});

router.post('/channels/target/remove', (req: Request, res: Response) => {
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: 'channel required' });
  const config = getConfig();
  config.targetChannels = config.targetChannels.filter(c => c !== channel);
  saveConfig(config);
  res.json({ success: true, targetChannels: config.targetChannels });
});

// ─── Scheduler ────────────────────────────────────────────────────────────────

router.post('/scheduler/start', (req: Request, res: Response) => {
  const config = getConfig();
  config.active = true;
  saveConfig(config);
  startScheduler();
  res.json({ success: true, message: 'Scheduler started' });
});

router.post('/scheduler/stop', (req: Request, res: Response) => {
  const config = getConfig();
  config.active = false;
  saveConfig(config);
  stopScheduler();
  res.json({ success: true, message: 'Scheduler stopped' });
});

router.post('/scheduler/run-now', async (req: Request, res: Response) => {
  if (getIsRunning()) {
    return res.status(409).json({ error: 'Job already running' });
  }
  res.json({ success: true, message: 'Job triggered' });
  // Run async after response
  runJob().catch(err => logger.error('Manual run error: ' + err.message));
});

// ─── Queue ────────────────────────────────────────────────────────────────────

router.get('/queue', (req: Request, res: Response) => {
  const queue = getQueue();
  const status = req.query.status as string | undefined;
  const filtered = status ? queue.filter(q => q.status === status) : queue;
  const page = parseInt(req.query.page as string || '1', 10);
  const limit = parseInt(req.query.limit as string || '50', 10);
  const start = (page - 1) * limit;
  res.json({
    total: filtered.length,
    page,
    limit,
    items: filtered.slice(start, start + limit),
  });
});

// ─── Stats ────────────────────────────────────────────────────────────────────

router.get('/stats', (req: Request, res: Response) => {
  const stats = getStats();
  const queue = getQueue();
  const checkpoints = getCheckpoints();
  res.json({
    ...stats,
    isRunning: getIsRunning(),
    queueSummary: {
      total: queue.length,
      pending: queue.filter(q => q.status === 'pending').length,
      processing: queue.filter(q => q.status === 'processing').length,
      done: queue.filter(q => q.status === 'done').length,
      failed: queue.filter(q => q.status === 'failed').length,
    },
    checkpoints,
  });
});

// ─── Health ───────────────────────────────────────────────────────────────────

router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

export default router;
