import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import apiRoutes from './api/routes';
import { startScheduler, startXScheduler } from './scheduler/cron';
import { getConfig } from './utils/store';
import { logger } from './utils/logger';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Auth ─────────────────────────────────────────────────────────────────────
// Protects the control panel and API with HTTP Basic auth when PANEL_USER and
// PANEL_PASS are set. Required when the server is exposed on a public URL:
// /api/config returns the X API keys and lets callers reconfigure everything.
const PANEL_USER = process.env.PANEL_USER || '';
const PANEL_PASS = process.env.PANEL_PASS || '';

if (PANEL_USER && PANEL_PASS) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
      const [user, ...passParts] = Buffer.from(header.slice(6), 'base64').toString('utf-8').split(':');
      if (user === PANEL_USER && passParts.join(':') === PANEL_PASS) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Control Panel"');
    res.status(401).send('Authentication required');
  });
} else {
  logger.warn('PANEL_USER/PANEL_PASS not set — control panel and API are UNPROTECTED. Do not expose this server publicly.');
}

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api', apiRoutes);

// ─── Control Panel ────────────────────────────────────────────────────────────
app.get('/control', (req, res) => {
  res.sendFile(path.join(__dirname, 'control', 'panel.html'));
});

// Redirect root to control panel
app.get('/', (req, res) => {
  res.redirect('/control');
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`Server running on http://localhost:${PORT}`);
  logger.info(`Control panel: http://localhost:${PORT}/control`);

  // Auto-start schedulers if configured
  const config = getConfig();
  if (config.active) {
    logger.info('Auto-starting scheduler (was active)');
    startScheduler();
  } else {
    logger.info('Scheduler is inactive. Enable it from the control panel.');
  }
  if (config.xEnabled && config.xCronSchedule) {
    startXScheduler();
  }
});

export default app;
