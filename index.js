require('dotenv').config();

const http = require('node:http');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const env = {
  discordBotToken: process.env.DISCORD_BOT_TOKEN,
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  openaiApiBaseUrl: process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1',
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 20000),
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
  if (!env.openaiApiKey) missing.push('OPENAI_API_KEY');
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

function buildGeminiPrompt({ content, username, replyToText }) {
  return [
    'You are a professional bilingual writing assistant for software and product communication.',
    '',
    'Your task is to rewrite short Discord messages for a Vietnamese software developer.',
    '',
    'Rules:',
    '- Detect language automatically.',
    '- If the input is Vietnamese: rewrite it into natural, concise, professional English for chatting with a PM, PO, designer, or teammate.',
    '- If the input is English: translate it into natural Vietnamese used by Vietnamese developers in daily work chat.',
    '- Output only the final message.',
    '- No explanations, no notes, no quotes, no markdown.',
    '- Preserve intent, urgency, and speaker perspective exactly.',
    '- Keep technical terms natural and unchanged when appropriate: API, UI, endpoint, PR, bug, staging, production, payload, response, config.',
    '- Preserve identifiers, code, paths, URLs, emails, commands, and error text exactly when present.',
    '- When output is English, do not use contractions.',
    '- Do not add greetings or sign-offs unless they already exist in the source.',
    '',
    'Optional context:',
    `reply_to: ${replyToText || ''}`,
    `username: ${username || ''}`,
    '',
    'User message:',
    content,
  ].join('\n');
}

function extractOpenAIText(data) {
  if (data?.error) {
    throw new Error(`OpenAI API Error: ${data.error.message || JSON.stringify(data.error)}`);
  }
  
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (text) return text;

  const finishReason = data?.choices?.[0]?.finish_reason;
  
  // Debug raw response if choices is empty
  const rawDebug = JSON.stringify(data).slice(0, 300);
  throw new Error(`OpenAI API returned no text. finish_reason=${finishReason || 'unknown'}. Raw: ${rawDebug}`);
}

async function callOpenAI(payload) {
  const prompt = buildGeminiPrompt({
    content: payload.content,
    username: payload.author?.username || '',
    replyToText: payload.replyTo?.content || '',
  });

  const url = `${env.openaiApiBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 
      'content-type': 'application/json',
      'authorization': `Bearer ${env.openaiApiKey}`
    },
    body: JSON.stringify({
      model: env.openaiModel,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: payload.content }
      ],
      temperature: 0.2,
      max_tokens: 220,
      stream: false,
    }),
    signal: AbortSignal.timeout(env.requestTimeoutMs),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`OpenAI API failed (${response.status}): ${text.slice(0, 500)}`);
  }

  return extractOpenAIText(data);
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
      res.end(JSON.stringify({ ok: true, service: 'discord-9router-relay' }));
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

      log('info', 'Processing Discord message with 9Router/OpenAI', {
        messageId: message.id,
        channelId: message.channelId,
        model: env.openaiModel,
      });

      const reply = await callOpenAI(payload);
      if (!reply) {
        log('warn', 'OpenAI returned empty reply', { messageId: message.id });
        return;
      }

      await sendReply(message, reply);
    } catch (error) {
      log('error', 'Failed to process Discord message', error.message || String(error));
      try {
        await message.reply({
          content: 'Tao gọi qua 9Router/OpenAI bị lỗi rồi, check logs giúp tao',
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
