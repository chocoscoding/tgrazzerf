/**
 * Run this script ONCE to generate your Telegram session string.
 * Usage: npx tsx src/generate-session.ts
 *
 * It will prompt for your phone number and the OTP code.
 * Copy the printed session string into your .env as TELEGRAM_SESSION=...
 */
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import * as readline from 'readline';
import dotenv from 'dotenv';

dotenv.config();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (q: string): Promise<string> => new Promise(resolve => rl.question(q, resolve));

async function main() {
  const apiId = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
  const apiHash = process.env.TELEGRAM_API_HASH || '';

  if (!apiId || !apiHash) {
    console.error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first!');
    process.exit(1);
  }

  const session = new StringSession('');
  const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 3 });

  await client.start({
    phoneNumber: async () => question('Enter your phone number (with country code): '),
    password: async () => question('Enter your 2FA password (if any, else press Enter): '),
    phoneCode: async () => question('Enter the OTP code you received: '),
    onError: (err) => console.error('Auth error:', err),
  });

  const sessionString = client.session.save() as unknown as string;
  console.log('\n✅ Session generated successfully!');
  console.log('\nAdd this to your .env file:');
  console.log(`TELEGRAM_SESSION=${sessionString}`);

  await client.disconnect();
  rl.close();
}

main().catch(console.error);
