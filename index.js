require('dotenv').config();

const http = require('node:http');
const https = require('node:https');

const httpsAgent = new https.Agent({ keepAlive: true });
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const env = {
  discordBotToken: process.env.DISCORD_BOT_TOKEN,
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  openaiApiBaseUrl: process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1',
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 20000),
  port: Number(process.env.PORT || 3000),
  allowedChannelId: process.env.ALLOWED_CHANNEL_ID || '',
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
  return true;
}

function parseMessage(content) {
  if (content === '/clear') return { isClearCommand: true };
  const text = content ? content.trim() : '';
  if (!text) return { targetLang: 'en', textToProcess: '' };
  
  if (text.toLowerCase().startsWith('vi ')) {
    return { targetLang: 'vi', textToProcess: text.slice(3).trim() };
  }
  if (text.toLowerCase().startsWith('en ')) {
    return { targetLang: 'en', textToProcess: text.slice(3).trim() };
  }
  // Mặc định dịch sang tiếng Anh nếu không có prefix
  return { targetLang: 'en', textToProcess: text }; 
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

function buildOpenAIPrompt({ content, username, replyToText, targetLang }) {
  const rules = targetLang === 'vi'
    ? [
        '- Target language: Vietnamese.',
        '- Translate the input text into natural Vietnamese.',
        '- If the input is already Vietnamese, improve it to sound more natural and correct any spelling/grammar errors, suitable for a daily work chat among Vietnamese developers.',
      ]
    : [
        '- Target language: English.',
        '- Translate the input text into professional, natural English.',
        '- If the input is already English (broken or not), correct the grammar and rewrite it to sound natural and native.',
        '- Keep it concise, suitable for chatting with a PM, PO, designer, or teammate.',
        '- Do not use contractions.',
      ];

  return [
    'You are a professional bilingual writing assistant for software and product communication.',
    '',
    'Rules:',
    ...rules,
    '- Output only the final message.',
    '- Maintain IT and technical terms in English (e.g. API, deploy, server, frontend) unless there is a very common Vietnamese equivalent.',
    '- Never enclose the final output in quotes or markdown code blocks.',
    '- Do not provide explanations, notes, or acknowledge the request.',
  ].join('\n');
}

function extractOpenAIText(data) {
  if (data?.error) {
    throw new Error(`OpenAI API Error: ${data.error.message || JSON.stringify(data.error)}`);
  }
  
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (text) return text;

  const finishReason = data?.choices?.[0]?.finish_reason;
  
  const rawDebug = JSON.stringify(data).slice(0, 300);
  throw new Error(`OpenAI API returned no text. finish_reason=${finishReason || 'unknown'}. Raw: ${rawDebug}`);
}

async function callOpenAI(payload, targetLang) {
  const prompt = buildOpenAIPrompt({
    content: payload.content,
    username: payload.author?.username || '',
    replyToText: payload.replyTo?.content || '',
    targetLang
  });

  const url = `${env.openaiApiBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const response = await fetch(url, {
    agent: url.startsWith('https') ? httpsAgent : undefined,
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
      temperature: 0,
      max_tokens: 2048,
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

  client.once('ready', async () => {
    log('info', `Discord bot logged in as ${client.user?.tag || 'unknown-user'}`);
    try {
      // Register global slash commands
      await client.application.commands.set([
        {
          name: 'clear',
          description: 'Xoá tối đa 100 tin nhắn gần nhất trong channel (không quá 14 ngày)',
        }
      ]);
      log('info', 'Successfully registered slash commands.');
    } catch (error) {
      log('error', 'Failed to register slash commands', error.message);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'clear') {
      log('info', 'Executing /clear slash command', { channelId: interaction.channelId });
      // Tell Discord we are working on it so it doesn't timeout
      await interaction.deferReply({ ephemeral: true });
      
      try {
        const messages = await interaction.channel.messages.fetch({ limit: 100 });
        await interaction.channel.bulkDelete(messages);
        await interaction.editReply('✅ Đã dọn dẹp tin nhắn cũ.');
      } catch (err) {
        log('error', 'Failed to clear messages via slash command', err.message);
        await interaction.editReply('❌ Lỗi khi xoá tin nhắn. (Lưu ý: bot không thể xoá tin nhắn cũ hơn 14 ngày).');
      }
    }
  });

  client.on('messageCreate', async (message) => {
    try {
      if (!shouldProcess(message)) return;

            if (message.content === '/clear') {
        log('info', 'Executing /clear command', { channelId: message.channelId });
        try {
          const messages = await message.channel.messages.fetch({ limit: 100 });
          await message.channel.bulkDelete(messages);
          const reply = await message.channel.send('✅ Đã dọn dẹp tin nhắn cũ.');
          setTimeout(() => reply.delete().catch(() => {}), 3000);
        } catch (err) {
          log('error', 'Failed to clear messages', err.message);
          await message.reply('❌ Lỗi khi xoá tin nhắn. (Lưu ý: bot không thể xoá tin nhắn cũ hơn 14 ngày).');
        }
        return;
      }

      const { targetLang, textToProcess } = parseMessage(message.content);
      if (!textToProcess) return;

      const replyTo = await getReplyReference(message);
      const payload = {
        content: textToProcess,
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

      log('info', `Processing Discord message (${targetLang}) with 9Router/OpenAI`, {
        messageId: message.id,
        channelId: message.channelId,
        model: env.openaiModel,
        targetLang
      });

      const startTime = Date.now();
      const replyText = await callOpenAI(payload, targetLang);
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      
      if (!replyText) {
        log('warn', 'OpenAI returned empty reply', { messageId: message.id });
        return;
      }

      const formattedReply = `\n🤖 \`${env.openaiModel}\` | ⏱️ \`${duration}s\`\n\n\`\`\`text\n${replyText}\n\`\`\``;

      await sendReply(message, formattedReply);
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
