# discord-gemini-relay

Discord relay bot that rewrites selected Discord messages with Gemini and replies directly in Discord.

## Environment

- `DISCORD_BOT_TOKEN` - Discord bot token
- `GEMINI_API_KEY` - Gemini API key
- `GEMINI_MODEL` - optional, default `gemini-2.5-flash`
- `GEMINI_API_BASE_URL` - optional, default `https://generativelanguage.googleapis.com/v1beta`
- `REQUEST_TIMEOUT_MS` - optional, default `20000`
- `PORT` - healthcheck port, default `3000`
- `ALLOWED_CHANNEL_ID` - optional, only process one channel/thread
- `TRIGGER_PREFIX` - optional prefix filter, default `tr `
- `REPLY_MODE` - `reply` or `send`
- `LOG_LEVEL` - `error|warn|info|debug`

## Local run

```bash
cp .env.example .env
npm install
npm start
```

## Notes

- Bot ignores other bots.
- If `TRIGGER_PREFIX` is non-empty, only messages starting with that prefix are processed.
- If `ALLOWED_CHANNEL_ID` is set, only that channel is processed.
- Health endpoint: `/healthz`
