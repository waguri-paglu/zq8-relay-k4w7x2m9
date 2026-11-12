/**
 * Cloudflare Worker for Telegram to Google Drive On-Demand Downloader
 */

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Telegram Webhook Active. Send POST requests.', { status: 200 });
    }

    try {
      const update = await request.json();
      await handleTelegramUpdate(update, env);
      return new Response('OK', { status: 200 });
    } catch (err) {
      console.error('Error handling request:', err);
      return new Response('Internal Error', { status: 500 });
    }
  }
};

async function handleTelegramUpdate(update, env) {
  // Handle Callback Queries (Inline Buttons)
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  // Handle Messages
  if (!update.message || !update.message.text) {
    return;
  }

  const chatId = update.message.chat.id;
  const text = update.message.text.trim();

  // Command: /start or /help
  if (text === '/start' || text === '/help') {
    await sendStartMenu(chatId, env);
    return;
  }

  // Command: /setfolder <url_or_id>
  if (text.startsWith('/setfolder')) {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await sendMessage(chatId, `⚠️ *Usage:* \`/setfolder <Google Drive Folder Link or ID>\`%0A%0AExample:%0A\`/setfolder 1A2b3C-4D5e6F...\` or send the full Drive folder URL.`, env);
      return;
    }
    const rawInput = parts[1];
    const folderId = extractFolderId(rawInput);
    if (env.SETTINGS_KV) {
      await env.SETTINGS_KV.put(`folder:${chatId}`, folderId);
    }
    await sendMessage(chatId, `✅ *Target folder updated!*%0A📁 *Folder ID:* \`${folderId}\`%0A%0AAll subsequent downloads will be saved here.`, env);
    return;
  }

  // Command: /myfolder
  if (text === '/myfolder') {
    let folderId = 'Root (Default)';
    if (env.SETTINGS_KV) {
      const saved = await env.SETTINGS_KV.get(`folder:${chatId}`);
      if (saved) folderId = saved;
    }
    await sendMessage(chatId, `📁 *Current Target Folder:*%0A\`${folderId}\``, env);
    return;
  }

  // Detect URL
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (!urlMatch) {
    await sendMessage(chatId, `👋 Send me a direct file download link, or use the menu below:`, env, getMainKeyboard());
    return;
  }

  const fileUrl = urlMatch[0];

  // Step 1: Verify direct link via HEAD request
  const verification = await verifyDirectLink(fileUrl);
  if (!verification.valid) {
    await sendMessage(
      chatId,
      `❌ *Invalid Link:* ${escapeMarkdown(verification.reason)}%0A%0APlease make sure the URL points directly to a downloadable file, not a web page.`,
      env
    );
    return;
  }

  // Step 2: Get target folder
  let targetFolder = '';
  if (env.SETTINGS_KV) {
    const saved = await env.SETTINGS_KV.get(`folder:${chatId}`);
    if (saved) targetFolder = saved;
  }

  // Step 3: Send initial progress message to Telegram
  const sizeText = verification.size ? `${verification.size}` : 'Unknown size';
  const initMsg = await sendMessage(
    chatId,
    `⏳ *Queued for Download!*%0A%0A📁 *File:* \`${escapeMarkdown(verification.fileName)}\`%0A📊 *Size:* ${sizeText}%0A📂 *Target Folder:* \`${targetFolder || 'Root'}\`%0A🚀 *Spinning up on-demand GitHub Runner...*`,
    env
  );

  const messageId = initMsg?.result?.message_id || '';

  // Step 4: Dispatch GitHub Actions workflow
  const dispatchSuccess = await triggerGithubAction({
    fileUrl,
    chatId: String(chatId),
    messageId: String(messageId),
    folderId: targetFolder,
    env
  });

  if (!dispatchSuccess) {
    await sendMessage(
      chatId,
      `❌ *Failed to trigger cloud runner.* Please check GitHub token/repository configuration.`,
      env
    );
  }
}

// Inline keyboard callback handler
async function handleCallbackQuery(cb, env) {
  const chatId = cb.message.chat.id;
  const data = cb.data;

  if (data === 'btn_set_folder') {
    await sendMessage(
      chatId,
      `📝 *To set your destination folder:*\nSend \`/setfolder <Folder_Link_or_ID>\`\n\nExample:\n\`/setfolder https://drive.google.com/drive/folders/1xyz...\``,
      env
    );
  } else if (data === 'btn_get_folder') {
    let folderId = 'Root (Default)';
    if (env.SETTINGS_KV) {
      const saved = await env.SETTINGS_KV.get(`folder:${chatId}`);
      if (saved) folderId = saved;
    }
    await sendMessage(chatId, `📁 *Current Target Folder:*\n\`${folderId}\``, env);
  } else if (data === 'btn_reset_folder') {
    if (env.SETTINGS_KV) {
      await env.SETTINGS_KV.delete(`folder:${chatId}`);
    }
    await sendMessage(chatId, `🔄 *Reset successful.* Uploads will now save to the root of your Google Drive.`, env);
  }

  // Answer callback query so Telegram loading state clears
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: cb.id })
    });
  } catch (_) {}
}

function getMainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📁 Set Target Folder', callback_data: 'btn_set_folder' },
        { text: 'ℹ️ View Current Folder', callback_data: 'btn_get_folder' }
      ],
      [
        { text: '🔄 Reset to Root', callback_data: 'btn_reset_folder' }
      ]
    ]
  };
}

async function sendStartMenu(chatId, env) {
  const text = `👋 *Welcome to On-Demand GDrive Downloader!*%0A%0A` +
    `🚀 *Features:*%0A` +
    `• 1-2 Gbps Gigabit Cloud Runner%0A` +
    `• 100% Free on-demand compute%0A` +
    `• Automatic Google Drive mirror & share link%0A%0A` +
    `Simply *send any direct download link* to begin, or manage your destination folder with the buttons below:`;

  await sendMessage(chatId, text, env, getMainKeyboard());
}

// Link validation via HTTP HEAD request
async function verifyDirectLink(url) {
  try {
    const headRes = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      redirect: 'follow'
    });

    const contentType = headRes.headers.get('content-type') || '';
    const contentLength = headRes.headers.get('content-length');
    const contentDisposition = headRes.headers.get('content-disposition') || '';

    // Rejection: HTML or Webpage
    if (contentType.toLowerCase().includes('text/html')) {
      return { valid: false, reason: 'URL points to a webpage, not a direct file download.' };
    }

    // Name extraction
    let fileName = 'file';
    const dispMatch = contentDisposition.match(/filename\*?=['"]?(?:UTF-8'')?([^'";\n]+)['"]?/i);
    if (dispMatch && dispMatch[1]) {
      fileName = decodeURIComponent(dispMatch[1].trim());
    } else {
      try {
        const u = new URL(url);
        const p = u.pathname.split('/').filter(Boolean).pop();
        if (p) fileName = decodeURIComponent(p);
      } catch (_) {}
    }

    // Size calculation
    let sizeStr = null;
    if (contentLength) {
      const bytes = parseInt(contentLength, 10);
      if (!isNaN(bytes)) {
        if (bytes > 1024 * 1024 * 1024) {
          sizeStr = `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
        } else {
          sizeStr = `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
        }
      }
    }

    return { valid: true, fileName, size: sizeStr };
  } catch (err) {
    return { valid: false, reason: `Could not verify link: ${err.message}` };
  }
}

// Trigger GitHub Actions Workflow
async function triggerGithubAction({ fileUrl, chatId, messageId, folderId, env }) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const workflowFile = env.GITHUB_WORKFLOW || 'mirror.yml';
  const token = env.GITHUB_PAT;

  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;

  const payload = {
    ref: 'main',
    inputs: {
      file_url: fileUrl,
      chat_id: chatId,
      message_id: messageId || '',
      folder_id: folderId || ''
    }
  };

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'Telegram-GDrive-Cloudflare-Worker'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error('GitHub API error:', res.status, errorText);
    return false;
  }

  return true;
}

// Utility: Send Message to Telegram
async function sendMessage(chatId, text, env, replyMarkup = null) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown'
  };

  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  return await res.json();
}

function extractFolderId(input) {
  if (!input) return '';
  // Check if it's a Drive URL: /folders/FOLDER_ID
  const match = input.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (match && match[1]) {
    return match[1];
  }
  // Check if it has id=FOLDER_ID
  const idMatch = input.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idMatch && idMatch[1]) {
    return idMatch[1];
  }
  // Otherwise return stripped string
  return input.trim();
}

function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/([_*[\]()~`>#+=|{}.!-])/g, '\\$1');
}
