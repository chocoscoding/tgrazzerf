import { Router, Request, Response } from "express";
import { getConfig, saveConfig, getQueue, getStats, getCheckpoints, saveCheckpoints, AppConfig, defaultConfig, getXStats, getXCheckpoints } from "../utils/store";
import { runJob, getIsRunning } from "../scheduler/runner";
import { runXJob, getXIsRunning } from "../scheduler/xRunner";
import { startXAuth, completeXAuth } from "../twitter/auth";
import { startScheduler, stopScheduler, restartScheduler, startXScheduler, stopXScheduler } from "../scheduler/cron";
import { logger } from "../utils/logger";

const router = Router();

// ─── Config ──────────────────────────────────────────────────────────────────

router.get("/config", (req: Request, res: Response) => {
  res.json(getConfig());
});

router.post("/config", (req: Request, res: Response) => {
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

  // Restart X scheduler if X settings changed
  const xSettingsChanged =
    req.body.xEnabled !== undefined ||
    (req.body.xCronSchedule && req.body.xCronSchedule !== current.xCronSchedule);
  if (xSettingsChanged) {
    if (updated.xEnabled && updated.xCronSchedule) {
      startXScheduler();
    } else {
      stopXScheduler();
    }
  }

  logger.info("Config updated", updated);
  res.json({ success: true, config: updated });
});

// ─── Channels ─────────────────────────────────────────────────────────────────

router.post("/channels/source/add", (req: Request, res: Response) => {
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: "channel required" });
  const config = getConfig();
  if (!config.sourceChannels.includes(channel)) {
    config.sourceChannels.push(channel);
    saveConfig(config);
  }
  res.json({ success: true, sourceChannels: config.sourceChannels });
});

router.post("/channels/source/remove", (req: Request, res: Response) => {
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: "channel required" });
  const config = getConfig();
  config.sourceChannels = config.sourceChannels.filter((c) => c !== channel);
  if (config.sourceStartFrom && config.sourceStartFrom[channel] !== undefined) {
    delete config.sourceStartFrom[channel];
  }
  saveConfig(config);

  const checkpoints = getCheckpoints();
  if (checkpoints[channel] !== undefined) {
    delete checkpoints[channel];
    saveCheckpoints(checkpoints);
  }

  res.json({ success: true, sourceChannels: config.sourceChannels });
});

router.post("/channels/source/start-from", (req: Request, res: Response) => {
  const { channel, startFrom } = req.body;
  if (!channel) return res.status(400).json({ error: "channel required" });

  const parsed = Number(startFrom);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return res.status(400).json({ error: "startFrom must be a non-negative number" });
  }

  const config = getConfig();
  config.sourceStartFrom = config.sourceStartFrom || {};
  config.sourceStartFrom[channel] = parsed;
  saveConfig(config);

  // Force next scrape to start from this position by resetting checkpoint for this channel
  const checkpoints = getCheckpoints();
  checkpoints[channel] = parsed;
  saveCheckpoints(checkpoints);

  res.json({ success: true, channel, startFrom: parsed, sourceStartFrom: config.sourceStartFrom, checkpoints });
});

router.post("/channels/source/end-at", (req: Request, res: Response) => {
  const { channel, endAt } = req.body;
  if (!channel) return res.status(400).json({ error: "channel required" });

  const parsed = Number(endAt);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return res.status(400).json({ error: "endAt must be a non-negative number (0 = no limit)" });
  }

  const config = getConfig();
  config.sourceEndAt = config.sourceEndAt || {};
  config.sourceEndAt[channel] = parsed;
  saveConfig(config);

  res.json({ success: true, channel, endAt: parsed, sourceEndAt: config.sourceEndAt });
});

router.post("/channels/target/add", (req: Request, res: Response) => {
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: "channel required" });
  const config = getConfig();
  if (!config.targetChannels.includes(channel)) {
    config.targetChannels.push(channel);
    saveConfig(config);
  }
  res.json({ success: true, targetChannels: config.targetChannels });
});

router.post("/channels/target/remove", (req: Request, res: Response) => {
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: "channel required" });
  const config = getConfig();
  config.targetChannels = config.targetChannels.filter((c) => c !== channel);
  saveConfig(config);
  res.json({ success: true, targetChannels: config.targetChannels });
});

// ─── Scheduler ────────────────────────────────────────────────────────────────

router.post("/scheduler/start", (req: Request, res: Response) => {
  const config = getConfig();
  config.active = true;
  saveConfig(config);
  startScheduler();
  res.json({ success: true, message: "Scheduler started" });
});

router.post("/scheduler/stop", (req: Request, res: Response) => {
  const config = getConfig();
  config.active = false;
  saveConfig(config);
  stopScheduler();
  res.json({ success: true, message: "Scheduler stopped" });
});

router.post("/scheduler/run-now", async (req: Request, res: Response) => {
  if (getIsRunning()) {
    return res.status(409).json({ error: "Job already running" });
  }
  const count = req.body?.count;
  const maxGroups = Number.isFinite(Number(count)) && Number(count) > 0 ? Number(count) : undefined;
  res.json({ success: true, message: maxGroups ? `Job triggered (max ${maxGroups} groups)` : "Job triggered" });
  runJob(maxGroups).catch((err) => logger.error("Manual run error: " + err.message));
});

// ─── Queue ────────────────────────────────────────────────────────────────────

router.get("/queue", (req: Request, res: Response) => {
  const queue = getQueue();
  const status = req.query.status as string | undefined;
  const filtered = status ? queue.filter((q) => q.status === status) : queue;
  const page = parseInt((req.query.page as string) || "1", 10);
  const limit = parseInt((req.query.limit as string) || "50", 10);
  const start = (page - 1) * limit;
  res.json({
    total: filtered.length,
    page,
    limit,
    items: filtered.slice(start, start + limit),
  });
});

// ─── Stats ────────────────────────────────────────────────────────────────────

router.get("/stats", (req: Request, res: Response) => {
  const stats = getStats();
  const queue = getQueue();
  const checkpoints = getCheckpoints();
  res.json({
    ...stats,
    isRunning: getIsRunning(),
    queueSummary: {
      total: queue.length,
      pending: queue.filter((q) => q.status === "pending").length,
      processing: queue.filter((q) => q.status === "processing").length,
      done: queue.filter((q) => q.status === "done").length,
      failed: queue.filter((q) => q.status === "failed").length,
    },
    checkpoints,
  });
});

// ─── X (Twitter) ──────────────────────────────────────────────────────────────

router.get("/x/stats", (req: Request, res: Response) => {
  const config = getConfig();
  res.json({
    enabled: config.xEnabled,
    postsPerDay: config.xPostsPerDay,
    xSourceChannels: config.xSourceChannels,
    isRunning: getXIsRunning(),
    checkpoints: getXCheckpoints(),
    ...getXStats(),
  });
});

router.post("/x/run-now", async (req: Request, res: Response) => {
  if (getXIsRunning()) {
    return res.status(409).json({ error: "X job already running" });
  }
  const count = req.body?.count;
  const maxPosts = Number.isFinite(Number(count)) && Number(count) > 0 ? Number(count) : undefined;
  res.json({ success: true, message: maxPosts ? `X job triggered (max ${maxPosts} posts)` : "X job triggered" });
  runXJob(maxPosts).catch((err) => logger.error("Manual X run error: " + err.message));
});

router.post("/x/channels/add", (req: Request, res: Response) => {
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: "channel required" });
  const config = getConfig();
  config.xSourceChannels = config.xSourceChannels || [];
  if (!config.xSourceChannels.includes(channel)) {
    config.xSourceChannels.push(channel);
    saveConfig(config);
  }
  res.json({ success: true, xSourceChannels: config.xSourceChannels });
});

router.post("/x/channels/remove", (req: Request, res: Response) => {
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: "channel required" });
  const config = getConfig();
  config.xSourceChannels = (config.xSourceChannels || []).filter((c) => c !== channel);
  saveConfig(config);
  res.json({ success: true, xSourceChannels: config.xSourceChannels });
});

// ─── X OAuth (3-legged, dynamic token generation) ─────────────────────────────

/**
 * The public base URL the X callback must return to. In production set
 * PUBLIC_URL to the deployed backend URL (this exact host must also be
 * registered as a Callback URI in the X developer portal).
 */
function getPublicUrl(req: Request): string {
  const fromEnv = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
  return fromEnv || `${req.protocol}://${req.get("host")}`;
}

router.get("/x/auth/start", async (req: Request, res: Response) => {
  try {
    const callbackUrl = `${getPublicUrl(req)}/api/x/auth/callback`;
    const url = await startXAuth(callbackUrl);
    res.redirect(url);
  } catch (err: any) {
    logger.error(`[x-auth] Start failed: ${err.message}`);
    res.status(500).send(`X login could not be started: ${err.message}`);
  }
});

router.get("/x/auth/callback", async (req: Request, res: Response) => {
  const { oauth_token, oauth_verifier, denied } = req.query;

  if (denied) {
    return res.status(200).send(authResultPage("❌ Authorization was cancelled on X.", false));
  }
  if (typeof oauth_token !== "string" || typeof oauth_verifier !== "string") {
    return res.status(400).send(authResultPage("❌ Missing oauth_token/oauth_verifier in callback.", false));
  }

  try {
    const screenName = await completeXAuth(oauth_token, oauth_verifier);
    res.send(authResultPage(`✅ Connected as @${screenName}. Tokens saved — posting is ready.`, true));
  } catch (err: any) {
    logger.error(`[x-auth] Callback failed: ${err.message}`);
    res.status(500).send(authResultPage(`❌ Token exchange failed: ${err.message}`, false));
  }
});

router.get("/x/auth/status", (req: Request, res: Response) => {
  const config = getConfig();
  res.json({
    connected: !!(config.xAccessToken && config.xAccessTokenSecret),
    user: config.xConnectedUser || null,
  });
});

function authResultPage(message: string, success: boolean): string {
  return `<!doctype html><html><body style="font-family:sans-serif;background:#0f1115;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
    <div style="text-align:center;max-width:480px;">
      <p style="font-size:1.1rem;">${message}</p>
      <p><a href="/control" style="color:#4da3ff;">← Back to control panel</a></p>
      ${success ? '<script>setTimeout(()=>{location.href="/control"},2500)</script>' : ""}
    </div>
  </body></html>`;
}

// ─── Health ───────────────────────────────────────────────────────────────────

router.get("/health", (req: Request, res: Response) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

export default router;
