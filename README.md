# discord-n8n-relay

Discord relay bot that forwards selected Discord messages to an n8n webhook and posts the workflow reply back to Discord.

## Environment

- `DISCORD_BOT_TOKEN` - Discord bot token
- `N8N_WEBHOOK_URL` - Production webhook URL from n8n
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
- If `TRIGGER_PREFIX` is non-empty, only messages starting with that prefix are forwarded.
- If `ALLOWED_CHANNEL_ID` is set, only that channel is processed.
- Health endpoint: `/healthz`
