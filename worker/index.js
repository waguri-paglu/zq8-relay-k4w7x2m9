/**
 * Cloudflare Worker for Multi-User Telegram to Google Drive Mirror Bot
 * Features:
 * - Per-user Google Drive OAuth2 login (/login, /logout, /oauth/callback)
 * - Interactive Google Drive Folder Browser (/setdldir) with Up, Select, New Folder & Pagination
 * - Full Task Options Menu (Start Mirror, Rename, Upload Folder, Extract, Create ZIP, Select, Cancel, ButtonMode)
 * - Pre-flight Google Drive quota & runner workspace verification with smart fallback
 * - Secure job handoff to GitHub Actions (public-repo safe: only job_id passed in workflow_dispatch)
 * - Task status & cancellation via GitHub Actions API (/tasks, /cancel_<id>)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Google OAuth2 Callback
    if (request.method === 'GET' && url.pathname === '/oauth/callback') {
      return await handleOAuthCallback(url, env);
    }

    // 2. Internal Runner Endpoints (authenticated by JOB_SECRET)
    if (request.method === 'POST' && url.pathname.startsWith('/internal/')) {
      return await handleInternalRunner(request, url.pathname, env);
    }

    // 3. Telegram Webhook
    if (request.method !== 'POST') {
      return new Response('Mirror Bot Webhook Active.', { status: 200 });
    }

    try {
      const update = await request.json();
      await handleTelegramUpdate(update, env);
      return new Response('OK', { status: 200 });
    } catch (err) {
      console.error('Webhook error:', err);
      return new Response('OK', { status: 200 });
    }
  }
};

// ============================================================================
// GOOGLE OAUTH2 & DRIVE API HELPERS
// ============================================================================

function getWorkerBaseUrl(env) {
  return (env.WORKER_URL || 'https://telegram-gdrive-bot.yashdaive.workers.dev').replace(/\/$/, '');
}

async function createOAuthUrl(chatId, userId, username, env) {
  const state = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  await env.SETTINGS_KV.put(
    `oauth_state:${state}`,
    JSON.stringify({ chatId, userId, username, createdAt: Date.now() }),
    { expirationTtl: 1800 }
  );

  const redirectUri = `${getWorkerBaseUrl(env)}/oauth/callback`;
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email',
    access_type: 'offline',
    prompt: 'consent',
    state: state
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function handleOAuthCallback(url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return htmlResponse('Login Cancelled', `Google returned an error: ${escapeHtml(error)}. You can close this tab.`);
  }
  if (!code || !state) {
    return htmlResponse('Invalid Request', 'Missing OAuth code or state parameter.');
  }

  const stateRaw = await env.SETTINGS_KV.get(`oauth_state:${state}`);
  if (!stateRaw) {
    return htmlResponse('Session Expired', 'This login link has expired. Please run /login again in Telegram.');
  }
  await env.SETTINGS_KV.delete(`oauth_state:${state}`);
  const stateData = JSON.parse(stateRaw);

  const redirectUri = `${getWorkerBaseUrl(env)}/oauth/callback`;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  });

  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    return htmlResponse('Login Failed', `Could not exchange authorization code. Please try /login again.`);
  }

  const accessToken = tokenData.access_token;
  const refreshToken = tokenData.refresh_token;

  // Fetch user's email & Drive info
  let email = 'Connected Account';
  const aboutRes = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName),storageQuota', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (aboutRes.ok) {
    const aboutData = await aboutRes.json();
    email = aboutData?.user?.emailAddress || aboutData?.user?.displayName || email;
  }

  // Load any existing user profile so we keep refresh_token if Google didn't re-send one
  const existing = await getUserProfile(stateData.userId, env);
  const finalRefresh = refreshToken || existing?.refreshToken;

  const userProfile = {
    userId: stateData.userId,
    chatId: stateData.chatId,
    username: stateData.username || '',
    email,
    refreshToken: finalRefresh,
    accessToken,
    tokenExpiry: Date.now() + ((tokenData.expires_in || 3500) - 120) * 1000,
    folderId: existing?.folderId || 'root',
    folderName: existing?.folderName || 'My Drive',
    buttonMode: existing?.buttonMode !== undefined ? existing.buttonMode : true
  };

  await saveUserProfile(stateData.userId, userProfile, env);

  // Immediately prompt user in Telegram to select a folder
  await sendMessage(
    stateData.chatId,
    `✅ <b>Google Drive Connected!</b>\n👤 <b>Account:</b> <code>${escapeHtml(email)}</code>\n\n📂 <b>Select your download folder below:</b>`,
    env
  );
  await openFolderBrowser(stateData.chatId, stateData.userId, 'root', null, null, env);

  return htmlResponse(
    'Google Drive Connected!',
    `Successfully linked <b>${escapeHtml(email)}</b>.<br><br>Return to Telegram to choose your target download folder.`
  );
}

async function getValidAccessToken(userId, env) {
  const profile = await getUserProfile(userId, env);
  if (!profile || !profile.refreshToken) return null;

  if (profile.accessToken && profile.tokenExpiry && Date.now() < profile.tokenExpiry) {
    return profile.accessToken;
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: profile.refreshToken,
      grant_type: 'refresh_token'
    })
  });

  if (!res.ok) return null;
  const data = await res.json();
  if (!data.access_token) return null;

  profile.accessToken = data.access_token;
  profile.tokenExpiry = Date.now() + ((data.expires_in || 3500) - 120) * 1000;
  await saveUserProfile(userId, profile, env);
  return profile.accessToken;
}

async function getDriveQuota(accessToken) {
  const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota,user(emailAddress)', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return null;
  const data = await res.json();
  const q = data.storageQuota || {};
  const limit = q.limit ? parseInt(q.limit, 10) : null; // null means unlimited (Workspace/Enterprise)
  const usage = q.usage ? parseInt(q.usage, 10) : 0;
  const free = limit !== null ? Math.max(0, limit - usage) : Infinity;
  return { limit, usage, free, email: data?.user?.emailAddress };
}

async function getUserProfile(userId, env) {
  const raw = await env.SETTINGS_KV.get(`user:${userId}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveUserProfile(userId, profile, env) {
  await env.SETTINGS_KV.put(`user:${userId}`, JSON.stringify(profile));
}

// ============================================================================
// INTERACTIVE GOOGLE DRIVE FOLDER BROWSER (/setdldir)
// ============================================================================

async function openFolderBrowser(chatId, userId, folderId, editMsgId = null, returnTaskId = null, env, page = 0) {
  const accessToken = await getValidAccessToken(userId, env);
  if (!accessToken) {
    await sendMessage(chatId, `🔑 Please connect your Google Drive first using /login.`, env);
    return;
  }

  const targetId = folderId || 'root';
  let folderName = 'My Drive';
  let parentId = null;

  if (targetId !== 'root') {
    const metaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(targetId)}?fields=id,name,parents`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (metaRes.ok) {
      const meta = await metaRes.json();
      folderName = meta.name || 'Folder';
      parentId = (meta.parents && meta.parents[0]) ? meta.parents[0] : 'root';
    }
  }

  // Query folders and files inside targetId in My Drive
  const q = `'${targetId}' in parents and trashed = false`;
  const listParams = new URLSearchParams({
    q,
    fields: 'files(id,name,mimeType,size)',
    orderBy: 'folder,name',
    pageSize: '60'
  });

  const listRes = await fetch(`https://www.googleapis.com/drive/v3/files?${listParams.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const listData = listRes.ok ? await listRes.json() : { files: [] };
  const rawFiles = listData.files || [];

  const items = rawFiles.map(f => ({
    id: f.id,
    name: f.name,
    isFolder: f.mimeType === 'application/vnd.google-apps.folder',
    size: f.size ? parseInt(f.size, 10) : 0
  }));

  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));

  // Save browser state in KV so callback_data stays tiny (<64 bytes)
  const browserState = {
    currentId: targetId,
    currentName: folderName,
    parentId,
    page: safePage,
    returnTaskId: returnTaskId || null,
    items
  };
  await env.SETTINGS_KV.put(`browser:${userId}`, JSON.stringify(browserState), { expirationTtl: 3600 });

  const pageItems = items.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const rows = [];

  for (let i = 0; i < pageItems.length; i++) {
    const idx = safePage * pageSize + i;
    const item = pageItems[i];
    const icon = item.isFolder ? '📁' : '📄';
    const label = `${icon} ${truncate(item.name, 34)}`;
    rows.push([{ text: label, callback_data: item.isFolder ? `fb_open:${idx}` : `fb_file:${idx}` }]);
  }

  // Pagination Row
  if (totalPages > 1) {
    const navRow = [];
    if (safePage > 0) navRow.push({ text: '⬅️ Prev', callback_data: `fb_page:${safePage - 1}` });
    navRow.push({ text: `📄 ${safePage + 1}/${totalPages}`, callback_data: 'fb_noop' });
    if (safePage < totalPages - 1) navRow.push({ text: 'Next ➡️', callback_data: `fb_page:${safePage + 1}` });
    rows.push(navRow);
  }

  // Up Row
  if (targetId !== 'root') {
    rows.push([{ text: '⬆️ Go Up One Level', callback_data: 'fb_up' }]);
  }

  // Bottom Actions: Select Folder & Create New Folder
  rows.push([
    { text: '✅ Select This Folder', callback_data: 'fb_sel' },
    { text: '➕ Create New Folder', callback_data: 'fb_mkdir' }
  ]);

  if (returnTaskId) {
    rows.push([{ text: '↩️ Back to Task Menu', callback_data: `fb_back:${returnTaskId}` }]);
  } else {
    rows.push([{ text: '✖️ Close', callback_data: 'fb_close' }]);
  }

  const folderCount = items.filter(x => x.isFolder).length;
  const fileCount = items.length - folderCount;
  const headerText =
    `📂 <b>Google Drive Folder Browser</b>\n\n` +
    `📍 <b>Current Folder:</b> <code>${escapeHtml(folderName)}</code>\n` +
    `📊 <b>Contents:</b> ${folderCount} folders, ${fileCount} files\n\n` +
    `<i>Tap a folder to open it, or click <b>Select This Folder</b> below:</i>`;

  const markup = { inline_keyboard: rows };
  if (editMsgId) {
    await editMessage(chatId, editMsgId, headerText, env, markup);
  } else {
    await sendMessage(chatId, headerText, env, markup);
  }
}

// ============================================================================
// TASK OPTIONS MENU (Image 1 Reference Flow)
// ============================================================================

function buildTaskMenuMessage(task) {
  const uname = task.username ? task.username.toUpperCase() : 'USER';
  const shortUrl = truncate(task.fileUrl, 48);
  const displayFileName = task.customName || task.detectedName || 'Unknown';
  const sizeStr = task.fileSize > 0 ? fmtBytes(task.fileSize) : 'Unknown size';

  let modeLabel = 'Normal (Direct Mirror)';
  if (task.mode === 'extract') modeLabel = '📂 Extract Archive';
  if (task.mode === 'zip') modeLabel = '🗜️ Create ZIP Archive';

  const filterLine = task.selectFilter ? `\n🔍 <b>Select Filter:</b> <code>${escapeHtml(task.selectFilter)}</code>` : '';

  return (
    `【 <b>${escapeHtml(uname)}</b> 】\n` +
    `<code>/m ${escapeHtml(shortUrl)}</code>\n\n` +
    `📌 <b>Choose option for your task?</b>\n\n` +
    `✓ <b>Custom Upload:</b> <code>${escapeHtml(task.folderName || 'My Drive')}</code>\n` +
    `📄 <b>File Name:</b> <code>${escapeHtml(displayFileName)}</code>\n` +
    `📊 <b>File Size:</b> <code>${sizeStr}</code>\n` +
    `⚙️ <b>Mode:</b> ${modeLabel}${filterLine}\n\n` +
    `⏰ <b>Timeout:</b> 2m40s`
  );
}

function buildTaskMenuKeyboard(task) {
  const tid = task.taskId;
  const extPrefix = task.mode === 'extract' ? '✓ ' : '';
  const zipPrefix = task.mode === 'zip' ? '✓ ' : '';
  const folderShort = truncate(task.folderName || 'My Drive', 16);

  return {
    inline_keyboard: [
      [{ text: '▶️ START MIRROR', callback_data: `tm_start:${tid}` }],
      [
        { text: task.customName ? '✓ Rename' : 'Rename', callback_data: `tm_ren:${tid}` },
        { text: `Upload: ${folderShort}`, callback_data: `tm_dir:${tid}` }
      ],
      [
        { text: `${extPrefix}Extract`, callback_data: `tm_ext:${tid}` },
        { text: `${zipPrefix}Create ZIP`, callback_data: `tm_zip:${tid}` }
      ],
      [
        { text: task.selectFilter ? '✓ Select' : 'Select', callback_data: `tm_sel:${tid}` },
        { text: 'File Info', callback_data: `tm_info:${tid}` }
      ],
      [
        { text: '↩️ Back', callback_data: `tm_back:${tid}` },
        { text: '⛔ Cancel', callback_data: `tm_cancel:${tid}` }
      ],
      [{ text: '🚫 Disable ButtonMode', callback_data: `tm_nobtn:${tid}` }]
    ]
  };
}

// ============================================================================
// TELEGRAM UPDATE DISPATCHER
// ============================================================================

async function handleTelegramUpdate(update, env) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  if (!update.message || !update.message.text) return;

  const msg = update.message;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name || 'User';
  const text = msg.text.trim();

  // Check if user is in an interactive text prompt state (Rename, New Folder, Select Filter)
  const promptRaw = await env.SETTINGS_KV.get(`prompt:${userId}`);
  if (promptRaw) {
    if (text === '/cancel') {
      await env.SETTINGS_KV.delete(`prompt:${userId}`);
      await sendMessage(chatId, `✖️ Input cancelled.`, env);
      return;
    }
    const promptState = JSON.parse(promptRaw);
    await env.SETTINGS_KV.delete(`prompt:${userId}`);
    await handleUserPromptInput(chatId, userId, text, promptState, env);
    return;
  }

  // Command: /start or /help
  if (text === '/start' || text.startsWith('/start ') || text === '/help') {
    await sendStartScreen(chatId, userId, username, env);
    return;
  }

  // Command: /login
  if (text === '/login') {
    const authUrl = await createOAuthUrl(chatId, userId, username, env);
    await sendMessage(
      chatId,
      `🔑 <b>Connect Your Google Drive</b>\n\n` +
        `Click the button below to sign in with Google and grant Drive access.\n` +
        `<i>Note: If Google shows an "unverified app" screen, tap <b>Advanced → Go to Mirror Bot (unsafe)</b> to proceed.</i>`,
      env,
      { inline_keyboard: [[{ text: '🔑 Connect Google Drive', url: authUrl }]] }
    );
    return;
  }

  // Command: /logout
  if (text === '/logout') {
    await env.SETTINGS_KV.delete(`user:${userId}`);
    await sendMessage(chatId, `🚪 <b>Logged out.</b> Your Google Drive credentials have been removed.`, env);
    return;
  }

  // Command: /setdldir
  if (text === '/setdldir' || text === '/setfolder') {
    const profile = await getUserProfile(userId, env);
    if (!profile || !profile.refreshToken) {
      const authUrl = await createOAuthUrl(chatId, userId, username, env);
      await sendMessage(
        chatId,
        `⚠️ You must connect your Google Drive first before selecting a download folder.`,
        env,
        { inline_keyboard: [[{ text: '🔑 Connect Google Drive', url: authUrl }]] }
      );
      return;
    }
    await openFolderBrowser(chatId, userId, profile.folderId || 'root', null, null, env);
    return;
  }

  // Command: /settings
  if (text === '/settings') {
    const profile = await getUserProfile(userId, env);
    if (!profile) {
      await sendMessage(chatId, `Please /login first to configure settings.`, env);
      return;
    }
    await sendSettingsMenu(chatId, userId, profile, null, env);
    return;
  }

  // Command: /tasks or /status
  if (text === '/tasks' || text === '/status') {
    await sendActiveTasks(chatId, userId, env);
    return;
  }

  // Command: /cancel_<jobId>
  if (text.startsWith('/cancel_')) {
    const jobId = text.replace('/cancel_', '').split('@')[0].trim();
    await cancelActiveJob(chatId, jobId, env);
    return;
  }

  // Detect mirror command (/m <url>, /mirror <url>) or direct URL
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (!urlMatch) {
    if (text.startsWith('/m')) {
      await sendMessage(chatId, `⚠️ <b>Usage:</b> <code>/m https://example.com/file.mkv</code>`, env);
    }
    return;
  }

  const fileUrl = urlMatch[0];

  // Require user to be logged in to their Google Drive
  const profile = await getUserProfile(userId, env);
  if (!profile || !profile.refreshToken) {
    const authUrl = await createOAuthUrl(chatId, userId, username, env);
    await sendMessage(
      chatId,
      `🔒 <b>Authentication Required</b>\n\nPlease connect your Google Drive account first so files can be mirrored directly to your Drive:`,
      env,
      { inline_keyboard: [[{ text: '🔑 Connect Google Drive', url: authUrl }]] }
    );
    return;
  }

  const checkingMsg = await sendMessage(chatId, `🔍 <b>Inspecting link...</b>`, env, null, msg.message_id);
  const checkingMsgId = checkingMsg?.result?.message_id;

  const verification = await verifyDirectLink(fileUrl);
  if (!verification.valid) {
    const errText =
      `❌ <b>Invalid Download Link</b>\n` +
      `⚠️ <b>Reason:</b> ${escapeHtml(verification.reason)}\n\n` +
      `<i>Please send a direct downloadable link, not an HTML webpage.</i>`;
    if (checkingMsgId) {
      await editMessage(chatId, checkingMsgId, errText, env);
    } else {
      await sendMessage(chatId, errText, env, null, msg.message_id);
    }
    return;
  }

  const taskId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const task = {
    taskId,
    userId,
    username,
    chatId,
    replyToMsgId: msg.message_id,
    menuMsgId: checkingMsgId,
    fileUrl,
    detectedName: verification.fileName,
    customName: '',
    fileSize: verification.sizeBytes || 0,
    contentType: verification.contentType || 'application/octet-stream',
    acceptRanges: verification.acceptRanges || false,
    folderId: profile.folderId || 'root',
    folderName: profile.folderName || 'My Drive',
    mode: 'normal',
    selectFilter: '',
    createdAt: Date.now()
  };

  await env.SETTINGS_KV.put(`task:${taskId}`, JSON.stringify(task), { expirationTtl: 7200 });

  // If user disabled ButtonMode, launch mirror immediately
  if (profile.buttonMode === false) {
    await launchMirrorTask(task, env);
    return;
  }

  const menuText = buildTaskMenuMessage(task);
  const menuKb = buildTaskMenuKeyboard(task);

  if (checkingMsgId) {
    await editMessage(chatId, checkingMsgId, menuText, env, menuKb);
  } else {
    const sent = await sendMessage(chatId, menuText, env, menuKb, msg.message_id);
    task.menuMsgId = sent?.result?.message_id;
    await env.SETTINGS_KV.put(`task:${taskId}`, JSON.stringify(task), { expirationTtl: 7200 });
  }
}

// ============================================================================
// HANDLE INTERACTIVE PROMPTS (Rename, Create Folder, Select Filter)
// ============================================================================

async function handleUserPromptInput(chatId, userId, text, promptState, env) {
  if (promptState.type === 'rename') {
    const raw = await env.SETTINGS_KV.get(`task:${promptState.taskId}`);
    if (!raw) {
      await sendMessage(chatId, `⚠️ Task session expired.`, env);
      return;
    }
    const task = JSON.parse(raw);
    task.customName = text.replace(/[/\\?%*:|"<>]/g, '_').trim();
    await env.SETTINGS_KV.put(`task:${task.taskId}`, JSON.stringify(task), { expirationTtl: 7200 });

    if (task.menuMsgId) {
      await editMessage(chatId, task.menuMsgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
    }
    await sendMessage(chatId, `✅ File renamed to: <code>${escapeHtml(task.customName)}</code>`, env);
    return;
  }

  if (promptState.type === 'select_filter') {
    const raw = await env.SETTINGS_KV.get(`task:${promptState.taskId}`);
    if (!raw) return;
    const task = JSON.parse(raw);
    task.selectFilter = text.toLowerCase() === 'all' ? '' : text.trim();
    await env.SETTINGS_KV.put(`task:${task.taskId}`, JSON.stringify(task), { expirationTtl: 7200 });

    if (task.menuMsgId) {
      await editMessage(chatId, task.menuMsgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
    }
    await sendMessage(
      chatId,
      task.selectFilter
        ? `✅ Extension filter set to: <code>${escapeHtml(task.selectFilter)}</code>`
        : `✅ Filter cleared (all extracted files will be uploaded).`,
      env
    );
    return;
  }

  if (promptState.type === 'mkdir') {
    const accessToken = await getValidAccessToken(userId, env);
    if (!accessToken) {
      await sendMessage(chatId, `⚠️ Please /login first.`, env);
      return;
    }
    const newFolderName = text.trim();
    const parentId = promptState.parentId || 'root';
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: newFolderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId]
      })
    });

    if (!createRes.ok) {
      await sendMessage(chatId, `❌ Failed to create folder on Google Drive.`, env);
      return;
    }
    const created = await createRes.json();
    await sendMessage(chatId, `📁 Created folder <b>${escapeHtml(created.name)}</b>! Opening it now...`, env);
    await openFolderBrowser(chatId, userId, created.id, promptState.browserMsgId || null, promptState.returnTaskId || null, env);
  }
}

// ============================================================================
// CALLBACK QUERY HANDLER (Buttons for Folder Browser, Task Menu, Status Card)
// ============================================================================

async function handleCallbackQuery(cb, env) {
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;
  const userId = cb.from.id;
  const data = cb.data || '';

  // --- Folder Browser Callbacks ---
  if (data.startsWith('fb_')) {
    const bRaw = await env.SETTINGS_KV.get(`browser:${userId}`);
    if (!bRaw && data !== 'fb_close') {
      await answerCb(cb.id, 'Browser session expired. Run /setdldir again.', true, env);
      return;
    }
    const bState = bRaw ? JSON.parse(bRaw) : null;

    if (data === 'fb_close') {
      await deleteMessage(chatId, msgId, env);
      await answerCb(cb.id, 'Closed', false, env);
      return;
    }
    if (data === 'fb_noop') {
      await answerCb(cb.id, '', false, env);
      return;
    }
    if (data.startsWith('fb_open:')) {
      const idx = parseInt(data.split(':')[1], 10);
      const item = bState.items[idx];
      if (!item || !item.isFolder) {
        await answerCb(cb.id, 'Not a folder', false, env);
        return;
      }
      await answerCb(cb.id, `Opening ${item.name}...`, false, env);
      await openFolderBrowser(chatId, userId, item.id, msgId, bState.returnTaskId, env, 0);
      return;
    }
    if (data.startsWith('fb_file:')) {
      const idx = parseInt(data.split(':')[1], 10);
      const item = bState.items[idx];
      if (item) {
        await answerCb(cb.id, `📄 ${item.name} (${fmtBytes(item.size)})`, true, env);
      }
      return;
    }
    if (data.startsWith('fb_page:')) {
      const nextPage = parseInt(data.split(':')[1], 10);
      await answerCb(cb.id, `Page ${nextPage + 1}`, false, env);
      await openFolderBrowser(chatId, userId, bState.currentId, msgId, bState.returnTaskId, env, nextPage);
      return;
    }
    if (data === 'fb_up') {
      await answerCb(cb.id, 'Going up...', false, env);
      await openFolderBrowser(chatId, userId, bState.parentId || 'root', msgId, bState.returnTaskId, env, 0);
      return;
    }
    if (data === 'fb_mkdir') {
      await env.SETTINGS_KV.put(
        `prompt:${userId}`,
        JSON.stringify({
          type: 'mkdir',
          parentId: bState.currentId,
          browserMsgId: msgId,
          returnTaskId: bState.returnTaskId
        }),
        { expirationTtl: 600 }
      );
      await answerCb(cb.id, 'Send the new folder name', false, env);
      await sendMessage(
        chatId,
        `➕ <b>Create New Folder</b> inside <code>${escapeHtml(bState.currentName)}</code>:\n\nSend the new folder name now (or /cancel):`,
        env
      );
      return;
    }
    if (data === 'fb_sel') {
      const profile = await getUserProfile(userId, env);
      if (profile) {
        profile.folderId = bState.currentId;
        profile.folderName = bState.currentName;
        await saveUserProfile(userId, profile, env);
      }

      if (bState.returnTaskId) {
        const tRaw = await env.SETTINGS_KV.get(`task:${bState.returnTaskId}`);
        if (tRaw) {
          const task = JSON.parse(tRaw);
          task.folderId = bState.currentId;
          task.folderName = bState.currentName;
          await env.SETTINGS_KV.put(`task:${task.taskId}`, JSON.stringify(task), { expirationTtl: 7200 });
          await answerCb(cb.id, `Selected: ${bState.currentName}`, false, env);
          await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
          return;
        }
      }

      await answerCb(cb.id, `Folder set to ${bState.currentName}!`, false, env);
      await editMessage(
        chatId,
        msgId,
        `✅ <b>Download Folder Updated!</b>\n\n` +
          `📁 <b>Selected Folder:</b> <code>${escapeHtml(bState.currentName)}</code>\n\n` +
          `<i>Send any direct link or <code>/m &lt;link&gt;</code> to start mirroring. Use /setdldir anytime to change it.</i>`,
        env
      );
      return;
    }
    if (data.startsWith('fb_back:')) {
      const tid = data.split(':')[1];
      const tRaw = await env.SETTINGS_KV.get(`task:${tid}`);
      if (tRaw) {
        const task = JSON.parse(tRaw);
        await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      }
      await answerCb(cb.id, 'Back to menu', false, env);
      return;
    }
  }

  // --- Task Options Menu Callbacks ---
  if (data.startsWith('tm_')) {
    const [action, tid] = data.split(':');
    const tRaw = await env.SETTINGS_KV.get(`task:${tid}`);
    if (!tRaw) {
      await answerCb(cb.id, 'This task menu has expired.', true, env);
      return;
    }
    const task = JSON.parse(tRaw);
    task.menuMsgId = msgId;

    if (action === 'tm_cancel') {
      await env.SETTINGS_KV.delete(`task:${tid}`);
      await editMessage(chatId, msgId, `⛔ <b>Task Cancelled.</b>`, env);
      await answerCb(cb.id, 'Cancelled', false, env);
      return;
    }

    if (action === 'tm_back') {
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, 'Refreshed', false, env);
      return;
    }

    if (action === 'tm_ext') {
      task.mode = task.mode === 'extract' ? 'normal' : 'extract';
      await env.SETTINGS_KV.put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Extract mode: ${task.mode === 'extract' ? 'ON' : 'OFF'}`, false, env);
      return;
    }

    if (action === 'tm_zip') {
      task.mode = task.mode === 'zip' ? 'normal' : 'zip';
      await env.SETTINGS_KV.put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Create ZIP mode: ${task.mode === 'zip' ? 'ON' : 'OFF'}`, false, env);
      return;
    }

    if (action === 'tm_ren') {
      await env.SETTINGS_KV.put(
        `prompt:${userId}`,
        JSON.stringify({ type: 'rename', taskId: tid }),
        { expirationTtl: 600 }
      );
      await answerCb(cb.id, 'Send the new file name', false, env);
      await sendMessage(
        chatId,
        `✏️ <b>Rename File</b>\nCurrent: <code>${escapeHtml(task.customName || task.detectedName)}</code>\n\nSend the new file name (with extension) now, or /cancel:`,
        env
      );
      return;
    }

    if (action === 'tm_sel') {
      await env.SETTINGS_KV.put(
        `prompt:${userId}`,
        JSON.stringify({ type: 'select_filter', taskId: tid }),
        { expirationTtl: 600 }
      );
      await answerCb(cb.id, 'Send file filter', false, env);
      await sendMessage(
        chatId,
        `📋 <b>Select File Filter (for Extracted Archives)</b>\n\nSend comma-separated file extensions to keep (e.g. <code>.mkv, .mp4, .srt</code>) or send <code>all</code> to keep everything:`,
        env
      );
      return;
    }

    if (action === 'tm_dir') {
      await answerCb(cb.id, 'Opening Folder Browser...', false, env);
      await openFolderBrowser(chatId, userId, task.folderId || 'root', msgId, tid, env, 0);
      return;
    }

    if (action === 'tm_info') {
      const infoMsg =
        `ℹ️ <b>Link Inspection Details</b>\n\n` +
        `📄 <b>Detected Name:</b> <code>${escapeHtml(task.detectedName)}</code>\n` +
        `📊 <b>Exact Size:</b> <code>${fmtBytes(task.fileSize)}</code> (${task.fileSize.toLocaleString()} bytes)\n` +
        `📦 <b>MIME Type:</b> <code>${escapeHtml(task.contentType)}</code>\n` +
        `⚡ <b>Multi-Conn Range Support:</b> ${task.acceptRanges ? '✅ Yes (16x parallel)' : '⚠️ Single stream'}`;
      await editMessage(chatId, msgId, infoMsg, env, {
        inline_keyboard: [[{ text: '↩️ Back to Options', callback_data: `tm_back:${tid}` }]]
      });
      await answerCb(cb.id, 'File Info', false, env);
      return;
    }

    if (action === 'tm_nobtn') {
      const profile = await getUserProfile(userId, env);
      if (profile) {
        profile.buttonMode = false;
        await saveUserProfile(userId, profile, env);
      }
      await answerCb(cb.id, 'ButtonMode disabled! Starting mirror...', false, env);
      await launchMirrorTask(task, env);
      return;
    }

    if (action === 'tm_start') {
      await answerCb(cb.id, 'Verifying space & starting mirror...', false, env);
      await launchMirrorTask(task, env);
      return;
    }
  }

  // --- Live Status Card Callbacks ---
  if (data.startsWith('st_')) {
    const [action, jobId] = data.split(':');
    if (action === 'st_close') {
      await deleteMessage(chatId, msgId, env);
      await answerCb(cb.id, 'Closed status panel', false, env);
      return;
    }
    if (action === 'st_ref') {
      await answerCb(cb.id, '⚡ Live updates refresh automatically every ~2.5s!', false, env);
      return;
    }
    if (action === 'st_cancel') {
      await answerCb(cb.id, 'Cancelling task...', false, env);
      await cancelActiveJob(chatId, jobId, env);
      return;
    }
  }

  // --- Settings Callbacks ---
  if (data.startsWith('cfg_')) {
    const profile = await getUserProfile(userId, env);
    if (!profile) return;
    if (data === 'cfg_toggle_btn') {
      profile.buttonMode = !profile.buttonMode;
      await saveUserProfile(userId, profile, env);
      await answerCb(cb.id, `ButtonMode: ${profile.buttonMode ? 'ON' : 'OFF'}`, false, env);
      await sendSettingsMenu(chatId, userId, profile, msgId, env);
      return;
    }
    if (data === 'cfg_dir') {
      await answerCb(cb.id, 'Opening folder browser...', false, env);
      await openFolderBrowser(chatId, userId, profile.folderId || 'root', msgId, null, env, 0);
      return;
    }
  }
}

// ============================================================================
// PRE-FLIGHT SPACE VERIFICATION & WORKFLOW LAUNCH
// ============================================================================

async function launchMirrorTask(task, env) {
  const { chatId, userId, taskId, menuMsgId } = task;
  const accessToken = await getValidAccessToken(userId, env);
  if (!accessToken) {
    await editMessage(chatId, menuMsgId, `❌ <b>Google Drive session expired.</b> Please run /login again.`, env);
    return;
  }

  // 1. Check User's Google Drive Free Space & Runner Workspace Limits (~112 GiB usable)
  const quota = await getDriveQuota(accessToken);
  const fileSize = task.fileSize || 0;
  const runnerLimitBytes = 112 * 1024 * 1024 * 1024; // 112 GiB after cleanup

  let fallbackNotice = '';

  if (fileSize > 0 && quota && quota.free !== Infinity) {
    // Check if even raw file upload exceeds user's Google Drive free space
    if (fileSize > quota.free) {
      const msg =
        `❌ <b>Insufficient Google Drive Space!</b>\n\n` +
        `📄 <b>File:</b> <code>${escapeHtml(task.customName || task.detectedName)}</code>\n` +
        `📦 <b>Required Space:</b> <code>${fmtBytes(fileSize)}</code>\n` +
        `💾 <b>Your Drive Free Space:</b> <code>${fmtBytes(quota.free)}</code>\n\n` +
        `<i>Due to insufficient space in your Google Drive, this upload cannot proceed. Free up space in your Drive and try again.</i>`;
      await editMessage(chatId, menuMsgId, msg, env);
      return;
    }

    // If Extract or ZIP selected, verify workspace (~2x file size needed on runner)
    if (task.mode === 'extract' || task.mode === 'zip') {
      const workspaceNeeded = fileSize * 2.1;
      if (workspaceNeeded > runnerLimitBytes) {
        fallbackNotice =
          `⚠️ <b>Workspace Size Notice:</b> Performing <b>${task.mode.toUpperCase()}</b> requires ~<code>${fmtBytes(workspaceNeeded)}</code> temporary space, which exceeds the runner's 112 GiB workspace.\n` +
          `➡️ Automatically switching to <b>Direct File Upload</b> (Drive Free: <code>${fmtBytes(quota.free)}</code>).\n\n`;
        task.mode = 'normal';
      }
    }
  }

  // Check if single file exceeds runner disk
  if (fileSize > runnerLimitBytes) {
    await editMessage(
      chatId,
      menuMsgId,
      `❌ <b>File Exceeds Runner Capacity:</b> File size is <code>${fmtBytes(fileSize)}</code>, which exceeds the 112 GiB runner disk limit.`,
      env
    );
    return;
  }

  const quotaLine =
    quota && quota.free !== Infinity
      ? `💾 <b>Drive Space Left:</b> <code>${fmtBytes(quota.free)}</code> (Need: <code>${fmtBytes(fileSize)}</code>)\n`
      : '';

  const bootText =
    `${fallbackNotice}` +
    `📄 <b>Name :</b> <code>${escapeHtml(task.customName || task.detectedName)}</code>\n\n` +
    `┌ <b>Status :</b> Booting Cloud Runner.. (0.00%)\n` +
    `├ [□□□□□□□□□□□□]\n` +
    `├ <b>By :</b> @${escapeHtml(task.username)}\n` +
    `├ <b>UserID :</b> [<code>${userId}</code>]\n` +
    `├ <b>Size :</b> ${fileSize > 0 ? fmtBytes(fileSize) : 'Unknown'}\n` +
    `├ <b>Folder :</b> ${escapeHtml(task.folderName)}\n` +
    `├ <b>Mode :</b> #${task.mode === 'extract' ? 'Extract' : task.mode === 'zip' ? 'ArchiveZIP' : 'Mirror'}\n` +
    `└ ⛔ /cancel_${taskId}\n\n` +
    `${quotaLine}` +
    `<i>⚡ Runner is waking up (~10–15s)... Live speed updates will appear here automatically.</i>`;

  await editMessage(chatId, menuMsgId, bootText, env, {
    inline_keyboard: [
      [
        { text: '🔄 Refresh', callback_data: `st_ref:${taskId}` },
        { text: '🔽 Close', callback_data: `st_close:${taskId}` }
      ],
      [{ text: '⛔ Cancel Task', callback_data: `st_cancel:${taskId}` }]
    ]
  });

  // Save job record in KV for the runner to pull securely
  const jobData = {
    jobId: taskId,
    userId,
    username: task.username,
    chatId,
    messageId: menuMsgId,
    fileUrl: task.fileUrl,
    detectedName: task.detectedName,
    customName: task.customName,
    fileSize: task.fileSize,
    folderId: task.folderId,
    folderName: task.folderName,
    mode: task.mode,
    selectFilter: task.selectFilter,
    status: 'booting',
    cancelled: false,
    createdAt: Date.now()
  };

  await env.SETTINGS_KV.put(`job:${taskId}`, JSON.stringify(jobData), { expirationTtl: 25200 });
  await addActiveJobForUser(userId, taskId, env);

  // Trigger GitHub Actions workflow with ONLY job_id
  const dispatched = await triggerGithubWorkflow(taskId, env);
  if (!dispatched) {
    await editMessage(
      chatId,
      menuMsgId,
      `❌ <b>Failed to dispatch GitHub Actions workflow.</b> Please verify repository & token settings.`,
      env
    );
  }
}

async function triggerGithubWorkflow(jobId, env) {
  const apiUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW || 'mirror.yml'}/dispatches`;
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      'User-Agent': 'Telegram-GDrive-Worker'
    },
    body: JSON.stringify({
      ref: 'main',
      inputs: { job_id: jobId }
    })
  });
  return res.ok;
}

// ============================================================================
// INTERNAL RUNNER ENDPOINTS
// ============================================================================

async function handleInternalRunner(request, path, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.JOB_SECRET || auth !== `Bearer ${env.JOB_SECRET}`) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  }

  const body = await request.json();
  const jobId = body.job_id;
  if (!jobId) return jsonResponse({ ok: false, error: 'Missing job_id' }, 400);

  const jRaw = await env.SETTINGS_KV.get(`job:${jobId}`);
  if (!jRaw) return jsonResponse({ ok: false, error: 'Job not found' }, 404);
  const job = JSON.parse(jRaw);

  if (path === '/internal/job') {
    if (body.run_id) {
      job.runId = String(body.run_id);
      job.status = 'running';
      await env.SETTINGS_KV.put(`job:${jobId}`, JSON.stringify(job), { expirationTtl: 25200 });
    }
    const accessToken = await getValidAccessToken(job.userId, env);
    if (!accessToken) {
      return jsonResponse({ ok: false, error: 'Could not mint Google access token for user' }, 400);
    }
    return jsonResponse({
      ok: true,
      job: { ...job, accessToken }
    });
  }

  if (path === '/internal/refresh') {
    const accessToken = await getValidAccessToken(job.userId, env);
    return jsonResponse({ ok: !!accessToken, accessToken });
  }

  if (path === '/internal/job-status') {
    return jsonResponse({ ok: true, cancelled: !!job.cancelled, status: job.status });
  }

  if (path === '/internal/complete') {
    job.status = body.status || 'completed';
    await env.SETTINGS_KV.put(`job:${jobId}`, JSON.stringify(job), { expirationTtl: 3600 });
    await removeActiveJobForUser(job.userId, jobId, env);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: 'Unknown path' }, 404);
}

// ============================================================================
// ACTIVE TASKS & CANCELLATION
// ============================================================================

async function addActiveJobForUser(userId, jobId, env) {
  const raw = await env.SETTINGS_KV.get(`active:${userId}`);
  const list = raw ? JSON.parse(raw) : [];
  if (!list.includes(jobId)) list.push(jobId);
  await env.SETTINGS_KV.put(`active:${userId}`, JSON.stringify(list), { expirationTtl: 25200 });
}

async function removeActiveJobForUser(userId, jobId, env) {
  const raw = await env.SETTINGS_KV.get(`active:${userId}`);
  if (!raw) return;
  const list = JSON.parse(raw).filter(id => id !== jobId);
  await env.SETTINGS_KV.put(`active:${userId}`, JSON.stringify(list), { expirationTtl: 25200 });
}

async function cancelActiveJob(chatId, jobId, env) {
  const jRaw = await env.SETTINGS_KV.get(`job:${jobId}`);
  if (!jRaw) {
    await sendMessage(chatId, `ℹ️ Task <code>${escapeHtml(jobId)}</code> is no longer active.`, env);
    return;
  }
  const job = JSON.parse(jRaw);
  job.cancelled = true;
  job.status = 'cancelled';
  await env.SETTINGS_KV.put(`job:${jobId}`, JSON.stringify(job), { expirationTtl: 3600 });
  await removeActiveJobForUser(job.userId, jobId, env);

  // Also call GitHub API to cancel workflow run immediately if runId is known
  if (job.runId) {
    await fetch(
      `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/runs/${job.runId}/cancel`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${env.GITHUB_PAT}`,
          'User-Agent': 'Telegram-GDrive-Worker'
        }
      }
    );
  }

  await sendMessage(chatId, `⛔ Cancellation signal sent for task <code>${escapeHtml(jobId)}</code>.`, env);
}

async function sendActiveTasks(chatId, userId, env) {
  const raw = await env.SETTINGS_KV.get(`active:${userId}`);
  const list = raw ? JSON.parse(raw) : [];
  if (!list.length) {
    await sendMessage(chatId, `📭 <b>No active tasks running right now.</b>`, env);
    return;
  }

  const lines = [`📋 <b>Active Tasks (${list.length}):</b>\n`];
  for (const jid of list) {
    const jr = await env.SETTINGS_KV.get(`job:${jid}`);
    if (jr) {
      const j = JSON.parse(jr);
      lines.push(
        `• <code>${escapeHtml(j.customName || j.detectedName)}</code> (${fmtBytes(j.fileSize)})\n` +
          `  Status: <b>${escapeHtml(j.status)}</b> | ⛔ /cancel_${jid}`
      );
    }
  }
  await sendMessage(chatId, lines.join('\n'), env);
}

// ============================================================================
// MENUS & LINK VERIFICATION
// ============================================================================

async function sendStartScreen(chatId, userId, username, env) {
  const profile = await getUserProfile(userId, env);
  if (!profile || !profile.refreshToken) {
    const authUrl = await createOAuthUrl(chatId, userId, username, env);
    const text =
      `👋 <b>Welcome to High-Speed Cloud Mirror Bot!</b>\n\n` +
      `🚀 <b>Features:</b>\n` +
      `• Multi-connection Gigabit Download (~1.8 Gbps)\n` +
      `• Direct Upload to <b>Your Own Google Drive</b>\n` +
      `• Interactive Folder Browser (<code>/setdldir</code>)\n` +
      `• Rename, Extract Archives & Create ZIP\n` +
      `• Live 2.5s Progress Bar & System Monitor\n\n` +
      `🔑 <b>To get started, connect your Google Drive account below:</b>`;
    await sendMessage(chatId, text, env, {
      inline_keyboard: [[{ text: '🔑 Connect Google Drive', url: authUrl }]]
    });
    return;
  }

  const text =
    `👋 <b>Welcome back, ${escapeHtml(username)}!</b>\n\n` +
    `✅ <b>Connected Drive:</b> <code>${escapeHtml(profile.email)}</code>\n` +
    `📁 <b>Current Folder:</b> <code>${escapeHtml(profile.folderName || 'My Drive')}</code>\n` +
    `🎛️ <b>Button Mode:</b> <code>${profile.buttonMode !== false ? 'Enabled' : 'Disabled'}</code>\n\n` +
    `📌 <b>Commands:</b>\n` +
    `• Send any direct link or <code>/m &lt;link&gt;</code> to mirror\n` +
    `• /setdldir — Browse & select target Drive folder\n` +
    `• /tasks — View running mirror tasks\n` +
    `• /settings — Toggle ButtonMode & preferences\n` +
    `• /logout — Disconnect your Google Drive`;

  await sendMessage(chatId, text, env, {
    inline_keyboard: [
      [
        { text: '📁 Change Folder (/setdldir)', callback_data: 'cfg_dir' },
        { text: `🎛️ ButtonMode: ${profile.buttonMode !== false ? 'ON' : 'OFF'}`, callback_data: 'cfg_toggle_btn' }
      ]
    ]
  });
}

async function sendSettingsMenu(chatId, userId, profile, editMsgId, env) {
  const text =
    `⚙️ <b>Bot Settings</b>\n\n` +
    `👤 <b>Drive Account:</b> <code>${escapeHtml(profile.email)}</code>\n` +
    `📁 <b>Target Folder:</b> <code>${escapeHtml(profile.folderName || 'My Drive')}</code>\n` +
    `🎛️ <b>Task Options Menu (ButtonMode):</b> <code>${profile.buttonMode !== false ? 'ON' : 'OFF'}</code>`;
  const kb = {
    inline_keyboard: [
      [{ text: '📁 Browse / Change Folder', callback_data: 'cfg_dir' }],
      [{ text: `🎛️ Toggle ButtonMode (${profile.buttonMode !== false ? 'ON' : 'OFF'})`, callback_data: 'cfg_toggle_btn' }]
    ]
  };
  if (editMsgId) {
    await editMessage(chatId, editMsgId, text, env, kb);
  } else {
    await sendMessage(chatId, text, env, kb);
  }
}

async function verifyDirectLink(url) {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': ua },
      redirect: 'follow'
    });

    // Fallback to Range GET if server blocks HEAD (common on Google usercontent & presigned URLs)
    if (!res.ok || res.status === 405 || res.status === 403) {
      const controller = new AbortController();
      res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': ua, Range: 'bytes=0-0' },
        redirect: 'follow',
        signal: controller.signal
      });
      controller.abort();
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const contentDisp = res.headers.get('content-disposition') || '';
    const acceptRanges = (res.headers.get('accept-ranges') || '').toLowerCase() === 'bytes' || res.status === 206;

    let sizeBytes = 0;
    const contentRange = res.headers.get('content-range') || '';
    const rangeMatch = contentRange.match(/\/(\d+)$/);
    if (rangeMatch) {
      sizeBytes = parseInt(rangeMatch[1], 10);
    } else {
      const cl = res.headers.get('content-length');
      if (cl) sizeBytes = parseInt(cl, 10) || 0;
    }

    if (contentType.includes('text/html') && !contentDisp.toLowerCase().includes('attachment')) {
      return { valid: false, reason: 'URL points to an HTML webpage instead of a direct file stream.' };
    }

    let fileName = 'download.bin';
    const dispMatch = contentDisp.match(/filename\*?=['"]?(?:UTF-8'')?([^'";\n]+)['"]?/i);
    if (dispMatch && dispMatch[1]) {
      try {
        fileName = decodeURIComponent(dispMatch[1].trim());
      } catch (_) {
        fileName = dispMatch[1].trim();
      }
    } else {
      try {
        const u = new URL(res.url || url);
        const seg = u.pathname.split('/').filter(Boolean).pop();
        if (seg && seg.length < 180) {
          fileName = decodeURIComponent(seg);
        }
      } catch (_) {}
    }

    return {
      valid: true,
      fileName,
      sizeBytes,
      contentType,
      acceptRanges
    };
  } catch (err) {
    return { valid: false, reason: `Connection error: ${err.message}` };
  }
}

// ============================================================================
// TELEGRAM & FORMATTING UTILITIES
// ============================================================================

async function sendMessage(chatId, text, env, replyMarkup = null, replyToMsgId = null) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (replyToMsgId) payload.reply_to_message_id = replyToMsgId;

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return await res.json();
}

async function editMessage(chatId, messageId, text, env, replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return await res.json();
}

async function deleteMessage(chatId, messageId, env) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId })
  });
}

async function answerCb(cbId, text, showAlert, env) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: cbId,
      text: text || undefined,
      show_alert: !!showAlert
    })
  });
}

function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return '0.00 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let val = bytes;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(2)} ${units[i]}`;
}

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function htmlResponse(title, bodyHtml) {
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}.card{background:#1e293b;padding:32px;border-radius:16px;max-width:420px;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.4)}h1{margin-top:0;color:#38bdf8;font-size:1.5rem}p{color:#cbd5e1;line-height:1.6}</style></head><body><div class="card"><h1>${escapeHtml(title)}</h1><p>${bodyHtml}</p></div></body></html>`;
  return new Response(page, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
