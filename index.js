require('dotenv').config();

const http = require('node:http');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const env = {
  discordBotToken: process.env.DISCORD_BOT_TOKEN,
  n8nWebhookUrl: process.env.N8N_WEBHOOK_URL,
  port: Number(process.env.PORT || 3000),
  allowedChannelId: process.env.ALLOWED_CHANNEL_ID || '',
  triggerPrefix: process.env.TRIGGER_PREFIX ?? 'tr ',
  replyMode: (process.env.REPLY_MODE || 'reply').toLowerCase(),
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

function log(level, message, extra) {
  const levels = ['error', 'warn', 'info', 'debug'];
  if (levels.indexOf(level) > levels.indexOf(env.logLevel)) return;
  const stamp = new Date().toISOString();
  if (extra === undefined) {
    console.log(`[${stamp}] [${level}] ${message}`);
  } else {
    console.log(`[${stamp}] [${level}] ${message}`, extra);
  }
}

function validateEnv() {
  const missing = [];
  if (!env.discordBotToken) missing.push('DISCORD_BOT_TOKEN');
  if (!env.n8nWebhookUrl) missing.push('N8N_WEBHOOK_URL');
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}

function shouldProcess(message) {
  if (message.author?.bot) return false;
  if (!message.content?.trim()) return false;
  if (env.allowedChannelId && message.channelId !== env.allowedChannelId) return false;
  if (env.triggerPrefix && !message.content.startsWith(env.triggerPrefix)) return false;
  return true;
}

function buildPromptContent(message) {
  if (!env.triggerPrefix) return message.content.trim();
  return message.content.slice(env.triggerPrefix.length).trim();
}

async function getReplyReference(message) {
  if (!message.reference?.messageId) return null;
  try {
    const referenced = await message.fetchReference();
    return {
      id: referenced.id,
      content: referenced.content || '',
      author: {
        id: referenced.author?.id || '',
        username: referenced.author?.username || '',
        bot: Boolean(referenced.author?.bot),
      },
    };
  } catch (error) {
    log('warn', 'Could not fetch referenced Discord message', error.message || String(error));
    return null;
  }
}

async function callN8n(payload) {
  const response = await fetch(env.n8nWebhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`n8n webhook failed (${response.status}): ${text.slice(0, 500)}`);
  }

  return data;
}

async function sendReply(message, reply) {
  if (!reply) return;
  if (env.replyMode === 'send') {
    await message.channel.send(reply);
    return;
  }
  await message.reply({ content: reply, allowedMentions: { repliedUser: false } });
}

async function main() {
  validateEnv();

  const healthServer = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'discord-n8n-relay' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
  });

  healthServer.listen(env.port, '0.0.0.0', () => {
    log('info', `Health server listening on ${env.port}`);
  });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.once('ready', () => {
    log('info', `Discord bot logged in as ${client.user?.tag || 'unknown-user'}`);
  });

  client.on('messageCreate', async (message) => {
    try {
      if (!shouldProcess(message)) return;

      const content = buildPromptContent(message);
      if (!content) return;

      const replyTo = await getReplyReference(message);

      const payload = {
        content,
        channelId: message.channelId,
        threadId: message.channel?.isThread?.() ? message.channel.id : '',
        messageId: message.id,
        guildId: message.guildId || '',
        author: {
          id: message.author?.id || '',
          username: message.author?.username || '',
          bot: Boolean(message.author?.bot),
        },
        replyTo,
        raw: {
          url: message.url,
          createdTimestamp: message.createdTimestamp,
        },
      };

      log('info', 'Forwarding Discord message to n8n', {
        messageId: message.id,
        channelId: message.channelId,
      });

      const result = await callN8n(payload);
      const action = result?.action || 'reply';
      const reply = (result?.reply || '').toString().trim();

      if (action === 'ignore') {
        log('debug', 'n8n returned ignore action', { messageId: message.id });
        return;
      }

      if (!reply) {
        log('warn', 'n8n returned no reply text', result);
        return;
      }

      await sendReply(message, reply);
    } catch (error) {
      log('error', 'Failed to process Discord message', error.message || String(error));
      try {
        await message.reply({
          content: 'Tao gọi n8n bị lỗi rồi, check logs giúp tao',
          allowedMentions: { repliedUser: false },
        });
      } catch (replyError) {
        log('error', 'Failed to send Discord error reply', replyError.message || String(replyError));
      }
    }
  });

  await client.login(env.discordBotToken);
}

main().catch((error) => {
  log('error', 'Fatal startup error', error.message || String(error));
  process.exit(1);
});
