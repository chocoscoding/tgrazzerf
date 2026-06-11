import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import apiRoutes from './api/routes';
import { startScheduler } from './scheduler/cron';
import { getConfig } from './utils/store';
import { logger } from './utils/logger';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

  // Auto-start scheduler if it was active
  const config = getConfig();
  if (config.active) {
    logger.info('Auto-starting scheduler (was active)');
    startScheduler();
  } else {
    logger.info('Scheduler is inactive. Enable it from the control panel.');
  }
});

export default app;
