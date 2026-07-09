import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const DATA_DIR = path.join(process.cwd(), "data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const CHECKPOINTS_FILE = path.join(DATA_DIR, "checkpoints.json");
const QUEUE_FILE = path.join(DATA_DIR, "queue.json");
const STATS_FILE = path.join(DATA_DIR, "stats.json");
const X_CHECKPOINTS_FILE = path.join(DATA_DIR, "x-checkpoints.json");
const X_STATS_FILE = path.join(DATA_DIR, "x-stats.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export interface AppConfig {
  // Source channels to scrape GIFs+media from
  sourceChannels: string[];
  // Target channels to send processed messages to
  targetChannels: string[];
  // Max messages to process per cron run
  maxPerRun: number;
  // Cron schedule (default: every 24h)
  cronSchedule: string;
  // Whether the scheduler is active
  active: boolean;
  // Delay between sends in ms
  sendDelayMs: number;
  // Monitizee bot username
  monitizeeBot: string;
  // Words/sentences to remove from outgoing captions
  removePhrases: string[];
  // Global hashtags appended to every outgoing post (e.g. ["#brazzers", "#hd"])
  hashtags: string[];
  // Per-source channel message id to start scraping from (used before checkpoint exists)
  sourceStartFrom: Record<string, number>;
  // Optional per-source channel message id to stop scraping at (0 = no limit)
  sourceEndAt: Record<string, number>;
  // X (Twitter) cross-posting
  xEnabled: boolean;
  xApiKey: string;
  xApiSecret: string;
  xAccessToken: string;
  xAccessTokenSecret: string;
  // Handle of the X account the tokens belong to (set by the OAuth connect flow)
  xConnectedUser: string;
  xPostsPerDay: number;
  xCronSchedule: string;
  // Telegram channels to read from when building X posts (usually the same as targetChannels)
  xSourceChannels: string[];
}

export interface Checkpoint {
  // channelId -> last processed message id
  [channelId: string]: number;
}

export interface QueueItem {
  id: string;
  sourceChannel: string;
  gifMessageId: number;
  gifCaption: string;
  mediaMessageIds: number[];
  status: "pending" | "processing" | "done" | "failed";
  monitizeeLinks: string[];
  targetMessageIds: { channel: string; messageId: number }[];
  createdAt: string;
  processedAt?: string;
  error?: string;
}

export interface Stats {
  totalProcessed: number;
  totalSent: number;
  totalFailed: number;
  lastRunAt?: string;
  lastRunProcessed?: number;
}

function readJson<T>(file: string, defaultVal: T): T {
  ensureDir();
  if (!fs.existsSync(file)) return defaultVal;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return defaultVal;
  }
}

function writeJson(file: string, data: any) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

export const defaultConfig: AppConfig = {
  sourceChannels: [],
  targetChannels: [],
  maxPerRun: 50,
  cronSchedule: "0 0 * * *", // midnight daily
  active: false,
  sendDelayMs: 3000,
  monitizeeBot: process.env.MONITIZEE_BOT || "monitizeebot",
  removePhrases: [],
  hashtags: [],
  sourceStartFrom: {},
  sourceEndAt: {},
  xEnabled: false,
  xApiKey: process.env.X_API_KEY || "",
  xApiSecret: process.env.X_API_SECRET || "",
  xAccessToken: process.env.X_ACCESS_TOKEN || "",
  xAccessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET || "",
  xConnectedUser: "",
  xPostsPerDay: 10,
  xCronSchedule: "0 * * * *", // every hour
  xSourceChannels: [],
};

export function getConfig(): AppConfig {
  const stored = readJson<Partial<AppConfig>>(CONFIG_FILE, {});
  return { ...defaultConfig, ...stored };
}

export function saveConfig(config: AppConfig) {
  writeJson(CONFIG_FILE, config);
}

export function getCheckpoints(): Checkpoint {
  return readJson<Checkpoint>(CHECKPOINTS_FILE, {});
}

export function saveCheckpoint(channelId: string, messageId: number) {
  const cp = getCheckpoints();
  cp[channelId] = messageId;
  writeJson(CHECKPOINTS_FILE, cp);
}

export function saveCheckpoints(checkpoints: Checkpoint) {
  writeJson(CHECKPOINTS_FILE, checkpoints);
}

export function getQueue(): QueueItem[] {
  return readJson<QueueItem[]>(QUEUE_FILE, []);
}

export function saveQueue(queue: QueueItem[]) {
  writeJson(QUEUE_FILE, queue);
}

export function addToQueue(item: QueueItem) {
  const queue = getQueue();
  queue.push(item);
  writeJson(QUEUE_FILE, queue);
}

export function updateQueueItem(id: string, updates: Partial<QueueItem>) {
  const queue = getQueue();
  const idx = queue.findIndex((q) => q.id === id);
  if (idx !== -1) {
    queue[idx] = { ...queue[idx], ...updates };
    writeJson(QUEUE_FILE, queue);
  }
}

export function getStats(): Stats {
  return readJson<Stats>(STATS_FILE, { totalProcessed: 0, totalSent: 0, totalFailed: 0 });
}

export function updateStats(updates: Partial<Stats>) {
  const stats = getStats();
  writeJson(STATS_FILE, { ...stats, ...updates });
}

export function incrementStats(field: "totalProcessed" | "totalSent" | "totalFailed") {
  const stats = getStats();
  stats[field] = (stats[field] || 0) + 1;
  writeJson(STATS_FILE, stats);
}

// ── X (Twitter) checkpoints ────────────────────────────────────────────────────

export interface XStats {
  postsToday: number;
  lastResetDate: string; // YYYY-MM-DD
  totalPosted: number;
  lastPostedAt?: string;
}

export function getXCheckpoints(): Record<string, number> {
  return readJson<Record<string, number>>(X_CHECKPOINTS_FILE, {});
}

export function saveXCheckpoint(channel: string, messageId: number) {
  const cp = getXCheckpoints();
  cp[channel] = messageId;
  writeJson(X_CHECKPOINTS_FILE, cp);
}

export function getXStats(): XStats {
  return readJson<XStats>(X_STATS_FILE, { postsToday: 0, lastResetDate: "", totalPosted: 0 });
}

export function saveXStats(stats: XStats) {
  writeJson(X_STATS_FILE, stats);
}
