/**
 * Realistic smoke test for the messaging module.
 *
 * Unlike a synthetic test, this calls the REAL `processQueueItem` (sender.ts) —
 * the exact function the scheduler uses in production — with two constructed
 * QueueItems, so it exercises the whole pipeline: forwarding a short GIF/trailer,
 * requesting monetization links from the real bot (single link vs multiple
 * links), and editing the sent message with the real caption/hashtag logic.
 * It does NOT touch the queue.json/ad-creation system — items are transient
 * and only passed directly to processQueueItem.
 *
 * Usage:
 *   npx tsx src/telegram/testMessaging.ts \
 *     --source=<sourceChannel> --target=<targetChannel> \
 *     --gif1=<gifMessageId> --media1=<mediaMessageId> \
 *     --gif2=<gifMessageId> --media2=<mediaId1,mediaId2>
 *
 * --source1/--source2 can be used instead of --source if the two scenarios
 * come from different source channels.
 */
import { getClient, disconnectClient } from "./client";
import { processQueueItem } from "./sender";
import { getConfig, saveConfig, QueueItem } from "../utils/store";
import { logger } from "../utils/logger";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

function generateId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

async function fetchCaption(client: any, channel: string, messageId: number): Promise<string> {
  try {
    const msgs = await client.getMessages(channel, { ids: [messageId] });
    const msg = msgs?.[0];
    return msg?.message || "";
  } catch (err: any) {
    logger.warn(`Could not fetch caption for ${channel}#${messageId}: ${err.message}`);
    return "";
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const target = args.target;
  const source1 = args.source1 || args.source;
  const source2 = args.source2 || args.source;
  const gif1 = args.gif1 ? parseInt(args.gif1, 10) : null;
  const gif2 = args.gif2 ? parseInt(args.gif2, 10) : null;
  const media1 = (args.media1 || "").split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean);
  const media2 = (args.media2 || "").split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean);

  if (!target || !source1 || !source2 || !gif1 || !gif2 || media1.length === 0 || media2.length === 0) {
    console.error(
      "Usage: npx tsx src/telegram/testMessaging.ts --source=<channel> --target=<channel> --gif1=<id> --media1=<id> --gif2=<id> --media2=<id1,id2>",
    );
    process.exit(1);
  }

  const client = await getClient();
  const originalConfig = getConfig();

  try {
    // Point targetChannels at the test channel for the duration of the test,
    // but keep the real hashtags/removePhrases so the caption logic matches production.
    saveConfig({ ...originalConfig, targetChannels: [target] });

    const scenarios: { label: string; item: QueueItem }[] = [
      {
        label: "single video link",
        item: {
          id: generateId(),
          sourceChannel: source1,
          gifMessageId: gif1,
          gifCaption: await fetchCaption(client, source1, gif1),
          mediaMessageIds: media1,
          status: "pending",
          monitizeeLinks: [],
          targetMessageIds: [],
          createdAt: new Date().toISOString(),
        },
      },
      {
        label: "multiple video links",
        item: {
          id: generateId(),
          sourceChannel: source2,
          gifMessageId: gif2,
          gifCaption: await fetchCaption(client, source2, gif2),
          mediaMessageIds: media2,
          status: "pending",
          monitizeeLinks: [],
          targetMessageIds: [],
          createdAt: new Date().toISOString(),
        },
      },
    ];

    for (const { label, item } of scenarios) {
      logger.info(`=== Running scenario: ${label} (item ${item.id}) ===`, {
        sourceChannel: item.sourceChannel,
        gifMessageId: item.gifMessageId,
        mediaMessageIds: item.mediaMessageIds,
      });

      const ok = await processQueueItem(client, item);

      logger.info(`=== Scenario "${label}" ${ok ? "SUCCEEDED" : "FAILED"} ===`);
    }
  } finally {
    saveConfig(originalConfig);
    await disconnectClient();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
