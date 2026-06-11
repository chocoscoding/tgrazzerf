# TG Monetizer Bot

Automated Telegram monetization system using GramJS (telegram npm package).

## How It Works

1. **Scrapes** source channels starting from the last checkpoint per channel
2. **Finds** messages that are GIFs with captions
3. **Collects** subsequent media (video/photo) messages after each GIF
4. **Forwards** each media file to `@monitizeebot` (sends `/create` first, then forwards without caption/author)
5. **Extracts** the monetization link from the bot's response
6. **Sends** the GIF to target channels
7. **Edits** the sent message to append monetization links at the bottom:
   - Single video: `**Watch full video here (https://t.me/monitizeebot?start=...)**`
   - Multiple videos: `Watch full Part 1 video here (...)\nWatch full Part 2 video here (...)`

## Setup

### 1. Get Telegram API credentials
- Go to https://my.telegram.org/apps
- Create an app and copy `api_id` and `api_hash`

### 2. Configure .env
```env
TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash
TELEGRAM_SESSION=   # leave blank for now
PORT=3000
MONITIZEE_BOT=monitizeebot
```

### 3. Generate Session String
```bash
npm run session
```
Follow the prompts (phone number + OTP). Copy the printed session string into `.env` as `TELEGRAM_SESSION=...`

### 4. Install & Start
```bash
npm install
npm start
```

### 5. Open Control Panel
Visit: http://localhost:3000/control

## Control Panel Features

- **Stats**: Queue summary, all-time stats, scheduler status
- **Config**: Set cron schedule, max items per run, send delay
- **Channels**: Add/remove source (scrape) and target (send) channels
- **Queue**: View all queue items with status filtering and pagination
- **Scheduler**: Start/stop/run-now buttons

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/config | Get current config |
| POST | /api/config | Update config |
| POST | /api/channels/source/add | Add source channel |
| POST | /api/channels/source/remove | Remove source channel |
| POST | /api/channels/target/add | Add target channel |
| POST | /api/channels/target/remove | Remove target channel |
| POST | /api/scheduler/start | Start scheduler |
| POST | /api/scheduler/stop | Stop scheduler |
| POST | /api/scheduler/run-now | Trigger immediate run |
| GET | /api/queue | Get queue items (paginated) |
| GET | /api/stats | Get stats + queue summary |
| GET | /api/health | Health check |

## Default Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Max per run | 50 | Max items processed per cron trigger |
| Cron schedule | `0 0 * * *` | Daily at midnight |
| Send delay | 3000ms | Delay between sends |

## Notes

- Skips text-only messages and messages with buttons
- Skips GIFs without captions
- Checkpoints are saved per channel so restarts resume from where they left off
- Queue persists to disk (`data/queue.json`)
- Config persists to disk (`data/config.json`)
