/**
 * Cloudflare Worker for Multi-User Telegram to Google Drive Mirror Bot
 * - Normal Roboto (native Telegram UI text) for prose, labels, and names
 * - Monospace (<code> / <pre>) for filenames, metrics, commands, and system telemetry
 * - Native <blockquote> cards, <pre><code> blocks, and colored InlineKeyboardButtons
 */

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const RUNNER_LIMIT_BYTES = 112 * 1024 * 1024 * 1024;
const MAX_BATCH_URLS = 50;
const MAX_HISTORY_ITEMS = 15;

const YT_QUALITY_LABELS = {
  best: 'Best Video',
  '2160': '4K (2160p)',
  '1440': '2K (1440p)',
  '1080': '1080p HD',
  '720': '720p HD',
  '480': '480p SD',
  '360': '360p',
  mp3: 'Audio MP3',
  m4a: 'Audio M4A',
  opus: 'Audio Opus',
  flac: 'Audio FLAC'
};
const YT_AUDIO_QUALITIES = new Set(['mp3', 'm4a', 'opus', 'flac']);
const YT_CONTAINERS = ['mp4', 'mkv', 'auto'];
const MEDIA_DOMAINS = new Set([
  'youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
  'instagram.com', 'tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com',
  'twitter.com', 'x.com', 'reddit.com', 'v.redd.it',
  'twitch.tv', 'clips.twitch.tv', 'vimeo.com', 'dailymotion.com',
  'soundcloud.com', 'facebook.com', 'fb.watch', 'bilibili.com',
  'rumble.com', 'odysee.com', 'kick.com', 'streamable.com'
]);

function ytQualityLabel(q) {
  return YT_QUALITY_LABELS[q] || 'Best Video';
}

function ytContainerLabel(c) {
  if (c === 'mkv') return 'MKV';
  if (c === 'auto') return 'Auto';
  return 'MP4';
}

function isMediaSiteUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
    if (MEDIA_DOMAINS.has(host)) return true;
    for (const d of MEDIA_DOMAINS) {
      if (host.endsWith('.' + d)) return true;
    }
  } catch (_) {}
  return false;
}

function isPlaylistUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.pathname.includes('/playlist') || u.pathname.includes('/sets/') || u.pathname.includes('/album/');
  } catch (_) {
    return false;
  }
}

async function fetchMediaOEmbed(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    let oembedUrl = '';
    if (host.includes('youtube.com') || host === 'youtu.be') {
      oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(rawUrl)}&format=json`;
    } else if (host === 'vimeo.com') {
      oembedUrl = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(rawUrl)}`;
    } else if (host === 'soundcloud.com') {
      oembedUrl = `https://soundcloud.com/oembed?url=${encodeURIComponent(rawUrl)}&format=json`;
    }
    if (!oembedUrl) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    const res = await fetch(oembedUrl, { signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.title ? { title: String(data.title), author: String(data.author_name || '') } : null;
  } catch (_) {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/oauth/callback') {
      return await handleOAuthCallback(url, env);
    }

    if (request.method === 'POST' && url.pathname.startsWith('/internal/')) {
      return await handleInternalRunner(request, url.pathname, env);
    }

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
    state
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function handleOAuthCallback(url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return htmlResponse('Authorization Cancelled', `Google returned: ${escapeHtml(error)}. You can close this window.`);
  }
  if (!code || !state) {
    return htmlResponse('Invalid Request', 'Missing OAuth code or state parameter.');
  }

  const stateRaw = await env.SETTINGS_KV.get(`oauth_state:${state}`);
  if (!stateRaw) {
    return htmlResponse('Session Expired', 'This authorization link has expired. Run /login again in Telegram.');
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
    return htmlResponse('Authorization Failed', 'Could not exchange authorization code. Please try /login again.');
  }

  const accessToken = tokenData.access_token;
  const refreshToken = tokenData.refresh_token;

  let email = 'Connected Account';
  const aboutRes = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName),storageQuota', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (aboutRes.ok) {
    const aboutData = await aboutRes.json();
    email = aboutData?.user?.emailAddress || aboutData?.user?.displayName || email;
  }

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
    buttonMode: existing?.buttonMode !== undefined ? existing.buttonMode : true,
    autoShare: !!existing?.autoShare,
    conflict: existing?.conflict || 'rename',
    ytQuality: existing?.ytQuality || 'best',
    ytContainer: existing?.ytContainer || 'mp4'
  };

  await saveUserProfile(stateData.userId, userProfile, env);

  await sendMessage(
    stateData.chatId,
    `<blockquote><b>Drive Connected</b>\n\n<code>${escapeHtml(email)}</code></blockquote>\n\n` +
      `Select your default upload directory below:`,
    env
  );
  await openFolderBrowser(stateData.chatId, stateData.userId, 'root', null, null, env);

  return htmlResponse(
    'Google Drive Linked',
    `Connected as <b>${escapeHtml(email)}</b>.<br><br>Return to Telegram to choose your target folder.`
  );
}

async function getValidTokenInfo(userId, env, forceRefresh = false) {
  const profile = await getUserProfile(userId, env);
  if (!profile || !profile.refreshToken) return null;

  if (!forceRefresh && profile.accessToken && profile.tokenExpiry && Date.now() < profile.tokenExpiry) {
    return { accessToken: profile.accessToken, tokenExpiry: profile.tokenExpiry };
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
  return { accessToken: profile.accessToken, tokenExpiry: profile.tokenExpiry };
}

async function getValidAccessToken(userId, env, forceRefresh = false) {
  const info = await getValidTokenInfo(userId, env, forceRefresh);
  return info ? info.accessToken : null;
}

async function getDriveQuota(accessToken) {
  const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota,user(emailAddress)', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return null;
  const data = await res.json();
  const q = data.storageQuota || {};
  const limit = q.limit ? parseInt(q.limit, 10) : null;
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

function friendlyDriveError(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('storagequotaexceeded') || t.includes('storage quota') || t.includes('quota for this drive')) {
    return 'Google Drive storage is full. Free up space and try again.';
  }
  if (
    t.includes('uploadlimit') ||
    t.includes('upload limit') ||
    t.includes('userratelimitexceeded') ||
    t.includes('user rate limit exceeded') ||
    t.includes('maxuploadedbytes')
  ) {
    return "Google Drive's daily upload limit (~750 GB / 24h) was reached. Try again later.";
  }
  if (t.includes('downloadquotaexceeded') || t.includes('download quota') || t.includes('dailylimitexceeded')) {
    return "The source file's Drive download quota is exhausted. Try again in ~24h.";
  }
  if (t.includes('cannotcopyfile') || t.includes('copyrequireswriterpermission') || t.includes('cannotdownloadfile')) {
    return 'The file owner has disabled copying / downloading for this file.';
  }
  if (t.includes('filenotfound') || t.includes('notfound') || t.includes('file not found')) {
    return 'Drive file not found, or it is not shared with your Google account.';
  }
  if (t.includes('insufficientfilepermissions') || t.includes('insufficientpermissions')) {
    return 'Your Google account has no permission to access this file.';
  }
  if (t.includes('invalid credentials') || t.includes('unauthenticated') || t.includes('token expired')) {
    return 'Google Drive authorization failed. Run /login again.';
  }
  return null;
}

function extractDriveApiError(errData, fallback) {
  const err = errData?.error || {};
  const reasons = (err.errors || []).map(e => e.reason || '').join(' ');
  const msg = err.message || '';
  return friendlyDriveError(`${reasons} ${msg}`) || (msg ? `${fallback}: ${msg}` : fallback);
}

function qEscape(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findDriveExisting(accessToken, parentId, name) {
  const parent = parentId || 'root';
  const q = `'${parent}' in parents and name = '${qEscape(name)}' and trashed = false`;
  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,mimeType,webViewLink,size)',
    pageSize: '10',
    orderBy: 'modifiedTime desc',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true'
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.files || [];
}

function splitFileName(name, isDir = false) {
  if (isDir) return [name, ''];
  const compound = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst'];
  const low = name.toLowerCase();
  for (const suf of compound) {
    if (low.endsWith(suf) && name.length > suf.length) {
      return [name.slice(0, -suf.length), name.slice(-suf.length)];
    }
  }
  const dot = name.lastIndexOf('.');
  if (dot > 0 && name.length - dot <= 10) {
    return [name.slice(0, dot), name.slice(dot)];
  }
  return [name, ''];
}

async function findFreeDriveName(accessToken, parentId, name, isDir = false) {
  const [base, ext] = splitFileName(name, isDir);
  for (let n = 1; n < 50; n++) {
    const cand = `${base} (${n})${ext}`;
    const found = await findDriveExisting(accessToken, parentId, cand);
    if (!found.length) return cand;
  }
  return `${base} (${Math.floor(Date.now() / 1000)})${ext}`;
}

async function makeDrivePublic(accessToken, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions?fields=id&supportsAllDrives=true`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ role: 'reader', type: 'anyone' })
    }
  );
  return res.ok;
}

// ============================================================================
// INTERACTIVE GOOGLE DRIVE FOLDER BROWSER (/setdldir)
// ============================================================================

async function openFolderBrowser(chatId, userId, folderId, editMsgId = null, returnTaskId = null, env, page = 0) {
  const accessToken = await getValidAccessToken(userId, env);
  if (!accessToken) {
    await sendMessage(chatId, `Please connect your Google Drive first using /login.`, env);
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

  const q = `'${targetId}' in parents and trashed = false`;
  const rawFiles = [];
  let pageToken = '';
  for (let round = 0; round < 5; round++) {
    const listParams = new URLSearchParams({
      q,
      fields: 'nextPageToken,files(id,name,mimeType,size)',
      orderBy: 'folder,name',
      pageSize: '200'
    });
    if (pageToken) listParams.set('pageToken', pageToken);

    const listRes = await fetch(`https://www.googleapis.com/drive/v3/files?${listParams.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!listRes.ok) break;
    const listData = await listRes.json();
    if (Array.isArray(listData.files)) rawFiles.push(...listData.files);
    if (!listData.nextPageToken) break;
    pageToken = listData.nextPageToken;
  }

  const items = rawFiles.map(f => ({
    id: f.id,
    name: f.name,
    isFolder: f.mimeType === FOLDER_MIME,
    size: f.size ? parseInt(f.size, 10) : 0
  }));

  const browserState = {
    currentId: targetId,
    currentName: folderName,
    parentId,
    page: 0,
    returnTaskId: returnTaskId || null,
    items
  };
  await renderFolderBrowserPage(chatId, userId, browserState, page, editMsgId, env);
}

async function renderFolderBrowserPage(chatId, userId, browserState, page, editMsgId, env) {
  const items = browserState.items || [];
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  browserState.page = safePage;
  await env.SETTINGS_KV.put(`browser:${userId}`, JSON.stringify(browserState), { expirationTtl: 3600 });

  const pageItems = items.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const rows = [];

  for (let i = 0; i < pageItems.length; i++) {
    const idx = safePage * pageSize + i;
    const item = pageItems[i];
    const prefix = item.isFolder ? '▸ ' : '• ';
    const label = `${prefix}${truncate(item.name, 34)}`;
    rows.push([{ text: label, callback_data: item.isFolder ? `fb_open:${idx}` : `fb_file:${idx}` }]);
  }

  if (totalPages > 1) {
    const navRow = [];
    if (safePage > 0) navRow.push({ text: '‹ Prev', callback_data: `fb_page:${safePage - 1}`, style: 'primary' });
    navRow.push({ text: `${safePage + 1} / ${totalPages}`, callback_data: 'fb_noop' });
    if (safePage < totalPages - 1) navRow.push({ text: 'Next ›', callback_data: `fb_page:${safePage + 1}`, style: 'primary' });
    rows.push(navRow);
  }

  if (browserState.currentId !== 'root') {
    rows.push([{ text: '↑ Parent Directory', callback_data: 'fb_up', style: 'primary' }]);
  }

  rows.push([
    { text: '✓ Select Folder', callback_data: 'fb_sel', style: 'success' },
    { text: '+ New Folder', callback_data: 'fb_mkdir', style: 'primary' }
  ]);

  if (browserState.returnTaskId) {
    rows.push([{ text: '↩ Back to Task', callback_data: `fb_back:${browserState.returnTaskId}`, style: 'primary' }]);
  } else {
    rows.push([{ text: 'Close', callback_data: 'fb_close', style: 'danger' }]);
  }

  const folderCount = items.filter(x => x.isFolder).length;
  const fileCount = items.length - folderCount;
  const headerText =
    `<blockquote><b>Directory Browser</b>\n\n` +
    `${escapeHtml(browserState.currentName)}</blockquote>\n\n` +
    `Folders  ·  <code>${folderCount}</code>    Files  ·  <code>${fileCount}</code>\n\n` +
    `<i>Tap a subfolder to open it or confirm this location.</i>`;

  const markup = { inline_keyboard: rows };
  if (editMsgId) {
    await editMessage(chatId, editMsgId, headerText, env, markup);
  } else {
    await sendMessage(chatId, headerText, env, markup);
  }
}

// ============================================================================
// TASK OPTIONS MENU
// ============================================================================

function conflictLabel(policy) {
  if (policy === 'overwrite') return 'Overwrite';
  if (policy === 'skip') return 'Skip';
  return 'Rename';
}

function buildTaskMenuMessage(task) {
  let extras = '';
  if (task.batch) {
    extras += `\n✓ <b>Batch:</b> <code>${task.items.length} links</code>`;
  } else if (task.isYtdl) {
    extras += `\n✓ <b>Media:</b> <code>${escapeHtml(truncate(task.detectedName || 'Media Link', 56))}</code>`;
    if (task.mediaAuthor) {
      extras += `\n✓ <b>Channel:</b> ${escapeHtml(task.mediaAuthor)}`;
    }
  } else if (task.isDrive) {
    extras += `\n✓ <b>Source:</b> ${task.isFolder ? 'Google Drive Folder' : 'Google Drive (Server-Side)'}`;
  } else if (task.resolvedVia) {
    extras += `\n✓ <b>Extracted:</b> ${escapeHtml(task.resolvedVia)}`;
  }
  if (task.isYtdl) {
    const q = task.ytQuality || 'best';
    const isAud = YT_AUDIO_QUALITIES.has(q);
    extras += `\n✓ <b>Quality:</b> <code>${ytQualityLabel(q)}${isAud ? '' : ` · ${ytContainerLabel(task.ytContainer || 'mp4')}`}</code>`;
    if (task.ytSubs) extras += `\n✓ <b>Subtitles:</b> <code>${escapeHtml(task.ytSubLang || 'en')}</code>`;
    if (task.ytMeta === false) extras += `\n✓ <b>Metadata:</b> Off`;
    if (task.ytSponsorBlock) extras += `\n✓ <b>SponsorBlock:</b> Remove segments`;
    if (task.ytPlaylist === 'all') {
      extras += `\n✓ <b>Playlist:</b> All${task.ytPlaylistItems ? ` (<code>${escapeHtml(task.ytPlaylistItems)}</code>)` : ''}`;
    }
    if (task.ytTrim) extras += `\n✓ <b>Trim:</b> <code>${escapeHtml(task.ytTrim)}</code>`;
  }
  if (task.customName) {
    extras += `\n✓ <b>Rename:</b> <code>${escapeHtml(task.customName)}</code>`;
  }
  if (task.mode === 'extract') {
    extras += `\n✓ <b>Mode:</b> Extract`;
  } else if (task.mode === 'zip') {
    extras += `\n✓ <b>Mode:</b> Create ZIP`;
  }
  if (task.selectFilter) {
    extras += `\n✓ <b>Select:</b> <code>${escapeHtml(task.selectFilter)}</code>`;
  }
  if (task.archivePassword) {
    extras += `\n✓ <b>Password:</b> <code>Set (hidden)</code>`;
  }
  if (task.share) {
    extras += `\n✓ <b>Share:</b> Anyone with link`;
  }
  const conf = task.conflict || 'rename';
  if (conf !== 'rename' || task.duplicateExists) {
    extras += `\n✓ <b>On Duplicate:</b> ${conflictLabel(conf)}`;
  }
  if (task.duplicateExists && !task.batch && task.mode === 'normal') {
    extras += `\n⚠ <b>Duplicate:</b> Already exists in folder`;
  }

  return (
    `📌 <b>Choose option for your task?</b>\n\n` +
    `✓ <b>Custom Upload:</b> ${escapeHtml(task.folderName || 'My Drive')}${extras}\n\n` +
    `⏰ <b>Timeout:</b> <code>2m40s</code>`
  );
}

function buildTaskMenuKeyboard(task) {
  const tid = task.taskId;
  const extLabel = task.mode === 'extract' ? '✓ Extract' : 'Extract';
  const zipLabel = task.mode === 'zip' ? '✓ Create ZIP' : 'Create ZIP';
  const renLabel = task.batch && task.mode === 'zip'
    ? (task.customName ? '✓ ZIP Name' : 'ZIP Name')
    : (task.customName ? '✓ Rename' : 'Rename');
  const selLabel = task.selectFilter ? '✓ Select' : 'Select';
  const passLabel = task.archivePassword ? '✓ Password' : 'Password';
  const shareLabel = task.share ? '✓ Share Link' : 'Share Link';
  const confText = `Duplicate: ${conflictLabel(task.conflict || 'rename')}`;
  const folderShort = truncate(task.folderName || 'My Drive', 14);

  const rows = [
    [{ text: '▶️ START MIRROR', callback_data: `tm_start:${tid}`, style: 'success' }]
  ];

  if (!task.batch || task.mode === 'zip') {
    rows.push([
      { text: renLabel, callback_data: `tm_ren:${tid}` },
      { text: `Upload: ${folderShort}`, callback_data: `tm_dir:${tid}` }
    ]);
  } else {
    rows.push([{ text: `Upload: ${folderShort}`, callback_data: `tm_dir:${tid}` }]);
  }

  if (task.isYtdl) {
    const q = task.ytQuality || 'best';
    const isAud = YT_AUDIO_QUALITIES.has(q);
    const qualRow = [{ text: `🎬 Quality: ${ytQualityLabel(q)}`, callback_data: `tm_ytqual:${tid}`, style: 'primary' }];
    if (!isAud) {
      qualRow.push({ text: `Format: ${ytContainerLabel(task.ytContainer || 'mp4')}`, callback_data: `tm_ytcont:${tid}` });
    }
    rows.push(qualRow);

    if (!isAud) {
      const subRow = [{ text: task.ytSubs ? '✓ Subtitles' : 'Subtitles', callback_data: `tm_ytsubs:${tid}` }];
      if (task.ytSubs) {
        subRow.push({ text: `Lang: ${task.ytSubLang || 'en'}`, callback_data: `tm_ytslang:${tid}` });
      } else {
        subRow.push({ text: task.ytTrim ? `✓ Trim: ${task.ytTrim}` : '✂️ Trim', callback_data: `tm_yttrim:${tid}` });
      }
      rows.push(subRow);
      if (task.ytSubs) {
        rows.push([{ text: task.ytTrim ? `✓ Trim: ${task.ytTrim}` : '✂️ Trim Range', callback_data: `tm_yttrim:${tid}` }]);
      }
    } else {
      rows.push([{ text: task.ytTrim ? `✓ Trim: ${task.ytTrim}` : '✂️ Trim Range', callback_data: `tm_yttrim:${tid}` }]);
    }

    rows.push([
      { text: task.ytMeta !== false ? '✓ Meta & Thumb' : 'Meta & Thumb', callback_data: `tm_ytmeta:${tid}` },
      { text: task.ytSponsorBlock ? '✓ SponsorBlock' : 'SponsorBlock', callback_data: `tm_ytsb:${tid}` }
    ]);

    const plRow = [
      { text: task.ytPlaylist === 'all' ? '✓ Playlist: All' : 'Playlist: Single', callback_data: `tm_ytpl:${tid}` }
    ];
    if (task.ytPlaylist === 'all') {
      plRow.push({ text: task.ytPlaylistItems ? `✓ Items: ${task.ytPlaylistItems}` : 'Playlist Range', callback_data: `tm_ytplitems:${tid}` });
    } else {
      plRow.push({ text: zipLabel, callback_data: `tm_zip:${tid}` });
    }
    rows.push(plRow);

    if (task.ytPlaylist === 'all') {
      const zipRow = [{ text: zipLabel, callback_data: `tm_zip:${tid}` }];
      if (task.mode === 'zip') zipRow.push({ text: passLabel, callback_data: `tm_pass:${tid}` });
      rows.push(zipRow);
    } else if (task.mode === 'zip') {
      rows.push([{ text: passLabel, callback_data: `tm_pass:${tid}` }]);
    }
  } else {
    rows.push([
      { text: extLabel, callback_data: `tm_ext:${tid}` },
      { text: zipLabel, callback_data: `tm_zip:${tid}` }
    ]);

    if (task.mode === 'extract') {
      rows.push([
        { text: selLabel, callback_data: `tm_sel:${tid}` },
        { text: passLabel, callback_data: `tm_pass:${tid}` }
      ]);
    } else if (task.mode === 'zip') {
      rows.push(
        task.batch
          ? [{ text: passLabel, callback_data: `tm_pass:${tid}` }]
          : [
              { text: passLabel, callback_data: `tm_pass:${tid}` },
              { text: 'File Info', callback_data: `tm_info:${tid}` }
            ]
      );
    } else if (!task.batch) {
      rows.push([{ text: 'File Info', callback_data: `tm_info:${tid}` }]);
    }
  }

  rows.push([
    { text: shareLabel, callback_data: `tm_share:${tid}` },
    { text: confText, callback_data: `tm_confmenu:${tid}` }
  ]);

  rows.push([
    { text: '↩️ Back', callback_data: `tm_back:${tid}`, style: 'primary' },
    { text: '⛔ Cancel', callback_data: `tm_cancel:${tid}`, style: 'danger' }
  ]);

  rows.push([{ text: '🚫 Disable ButtonMode', callback_data: `tm_nobtn:${tid}`, style: 'danger' }]);

  return { inline_keyboard: rows };
}

function buildYtdlQualityMenu(task) {
  const tid = task.taskId;
  const cur = task.ytQuality || 'best';
  const btn = (val, label) => ({
    text: cur === val ? `✓ ${label}` : label,
    callback_data: `tm_ytqset:${tid}:${val}`,
    style: cur === val ? 'success' : undefined
  });
  const text =
    `<blockquote><b>Media Quality &amp; Format</b></blockquote>\n\n` +
    `Select video resolution or audio extraction preset.\n` +
    `<i>If an exact resolution is unavailable, the closest lower quality is used automatically.</i>`;
  const kb = {
    inline_keyboard: [
      [btn('best', 'Best Video'), btn('2160', '4K (2160p)'), btn('1440', '2K (1440p)')],
      [btn('1080', '1080p'), btn('720', '720p'), btn('480', '480p')],
      [btn('360', '360p'), btn('mp3', 'MP3 Audio'), btn('m4a', 'M4A Audio')],
      [btn('opus', 'Opus Audio'), btn('flac', 'FLAC Audio')],
      [{ text: '↩ Back', callback_data: `tm_back:${tid}`, style: 'primary' }]
    ]
  };
  return { text, kb };
}

function buildConflictMenu(task) {
  const tid = task.taskId;
  const cur = task.conflict || 'rename';
  const mark = (val, label) => (cur === val ? `✓ ${label}` : label);
  const text =
    `<blockquote><b>Duplicate Handling</b></blockquote>\n\n` +
    `Choose what happens if a file or folder with the same name already exists in <b>${escapeHtml(task.folderName || 'My Drive')}</b>:\n\n` +
    `• <b>Rename</b> — Keep both by adding <code>(1)</code>, <code>(2)</code>, …\n` +
    `• <b>Overwrite</b> — Replace the existing file / folder\n` +
    `• <b>Skip</b> — Leave existing intact and return its link`;
  const kb = {
    inline_keyboard: [
      [
        { text: mark('rename', 'Rename (Keep Both)'), callback_data: `tm_confset:${tid}:rename`, style: cur === 'rename' ? 'success' : undefined },
        { text: mark('overwrite', 'Overwrite'), callback_data: `tm_confset:${tid}:overwrite`, style: cur === 'overwrite' ? 'success' : undefined }
      ],
      [
        { text: mark('skip', 'Skip'), callback_data: `tm_confset:${tid}:skip`, style: cur === 'skip' ? 'success' : undefined },
        { text: '↩ Back', callback_data: `tm_back:${tid}`, style: 'primary' }
      ]
    ]
  };
  return { text, kb };
}

// ============================================================================
// TELEGRAM UPDATE DISPATCHER
// ============================================================================

async function handleTelegramUpdate(update, env) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name || 'User';

  if (msg.document && !msg.text && !msg.caption) {
    await handleDocumentMessage(msg, env);
    return;
  }

  const rawText = msg.text || msg.caption || '';
  if (!rawText) return;
  const text = rawText.trim();

  const promptRaw = await env.SETTINGS_KV.get(`prompt:${userId}`);
  if (promptRaw) {
    if (text === '/cancel') {
      await env.SETTINGS_KV.delete(`prompt:${userId}`);
      await sendMessage(chatId, `<i>Input cancelled.</i>`, env);
      return;
    }
    const promptState = JSON.parse(promptRaw);
    await env.SETTINGS_KV.delete(`prompt:${userId}`);
    await handleUserPromptInput(chatId, userId, text, promptState, msg.message_id, env);
    return;
  }

  if (text === '/start' || text.startsWith('/start ') || text === '/help') {
    await sendStartScreen(chatId, userId, username, env);
    return;
  }

  if (text === '/login') {
    const authUrl = await createOAuthUrl(chatId, userId, username, env);
    await sendMessage(
      chatId,
      `<blockquote><b>Google Drive Authentication</b></blockquote>\n\n` +
        `Authorize your Google Drive account so transfers upload directly to your storage.\n\n` +
        `<i>If Google displays an unverified app prompt, select Advanced → Proceed.</i>`,
      env,
      { inline_keyboard: [[{ text: '▸  Connect Google Drive', url: authUrl, style: 'primary' }]] }
    );
    return;
  }

  if (text === '/logout') {
    await env.SETTINGS_KV.delete(`user:${userId}`);
    await sendMessage(chatId, `<blockquote><b>Disconnected</b>\n\nYour Google Drive credentials have been removed.</blockquote>`, env);
    return;
  }

  if (text === '/setdldir' || text === '/setfolder') {
    const profile = await getUserProfile(userId, env);
    if (!profile || !profile.refreshToken) {
      const authUrl = await createOAuthUrl(chatId, userId, username, env);
      await sendMessage(
        chatId,
        `Connect your Google Drive first before choosing a destination folder.`,
        env,
        { inline_keyboard: [[{ text: '▸  Connect Google Drive', url: authUrl, style: 'primary' }]] }
      );
      return;
    }
    await openFolderBrowser(chatId, userId, profile.folderId || 'root', null, null, env);
    return;
  }

  if (text === '/settings') {
    const profile = await getUserProfile(userId, env);
    if (!profile) {
      await sendMessage(chatId, `Please run /login first.`, env);
      return;
    }
    await sendSettingsMenu(chatId, userId, profile, null, env);
    return;
  }

  if (text === '/tasks' || text === '/status') {
    await sendActiveTasks(chatId, userId, env);
    return;
  }

  if (text === '/history') {
    await sendHistory(chatId, userId, null, env);
    return;
  }

  if (text.startsWith('/cancel_')) {
    const jobId = text.replace('/cancel_', '').split('@')[0].trim();
    await cancelActiveJob(chatId, userId, jobId, env);
    return;
  }

  const isYtCmd = /^\/yt(?:dl)?(?:@\S+)?(?:\s|$)/i.test(text);
  const isMCmd = /^\/m(?:@\S+)?(?:\s|$)/i.test(text);
  const urls = extractUrls(text);
  if (!urls.length) {
    if (isYtCmd) {
      await sendMessage(chatId, `Usage  ·  <code>/yt https://youtube.com/watch?v=...</code>\n\n<i>Works with YouTube, Instagram, TikTok, X, Twitch, Vimeo, SoundCloud, and 1000+ media sites.</i>`, env);
    } else if (isMCmd) {
      await sendMessage(chatId, `Usage  ·  <code>/m https://example.com/file.mkv</code>\n\n<i>You can also send multiple links, a </i><code>.txt</code><i> file of URLs, or </i><code>/yt &lt;url&gt;</code><i> for media sites.</i>`, env);
    }
    return;
  }

  await startTaskFromUrls(chatId, userId, username, msg.message_id, urls, env, { forceYtdl: isYtCmd });
}

async function handleDocumentMessage(msg, env) {
  const doc = msg.document;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name || 'User';
  const fileName = (doc.file_name || '').toLowerCase();
  const mime = (doc.mime_type || '').toLowerCase();

  if (!fileName.endsWith('.txt') && mime !== 'text/plain') {
    return;
  }

  const profile = await getUserProfile(userId, env);
  if (!profile || !profile.refreshToken) {
    const authUrl = await createOAuthUrl(chatId, userId, username, env);
    await sendMessage(
      chatId,
      `<blockquote><b>Authentication Required</b></blockquote>\n\nConnect your Google Drive account to mirror links from a text file:`,
      env,
      { inline_keyboard: [[{ text: '▸  Connect Google Drive', url: authUrl, style: 'primary' }]] }
    );
    return;
  }

  if (doc.file_size && doc.file_size > 512 * 1024) {
    await sendMessage(chatId, `<blockquote><b>File Too Large</b>\n\nBatch <code>.txt</code> files must be under <code>512 KiB</code>.</blockquote>`, env);
    return;
  }

  const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(doc.file_id)}`);
  const fileJson = await fileRes.json();
  const filePath = fileJson?.result?.file_path;
  if (!filePath) {
    await sendMessage(chatId, `Could not read <code>.txt</code> file from Telegram.`, env);
    return;
  }

  const rawRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!rawRes.ok) {
    await sendMessage(chatId, `Could not download <code>.txt</code> file.`, env);
    return;
  }

  const content = await rawRes.text();
  const cleanLines = content
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .join('\n');
  const urls = extractUrls(cleanLines);

  if (!urls.length) {
    await sendMessage(chatId, `<blockquote><b>No Links Found</b>\n\nNo <code>http://</code> or <code>https://</code> links found in <code>${escapeHtml(doc.file_name || 'file.txt')}</code>.</blockquote>`, env);
    return;
  }

  await startTaskFromUrls(chatId, userId, username, msg.message_id, urls, env);
}

async function startTaskFromUrls(chatId, userId, username, replyToMsgId, urls, env, opts = {}) {
  const forceYtdl = !!opts.forceYtdl;
  const editExistingMsgId = opts.editMsgId || null;
  const profile = await getUserProfile(userId, env);
  if (!profile || !profile.refreshToken) {
    const authUrl = await createOAuthUrl(chatId, userId, username, env);
    await sendMessage(
      chatId,
      `<blockquote><b>Authentication Required</b></blockquote>\n\n` +
        `Connect your Google Drive account to start mirroring files:`,
      env,
      { inline_keyboard: [[{ text: '▸  Connect Google Drive', url: authUrl, style: 'primary' }]] }
    );
    return;
  }

  const isBatch = urls.length > 1;
  const allMedia = forceYtdl || urls.every(u => isMediaSiteUrl(u));
  let checkingMsgId = editExistingMsgId;
  if (!checkingMsgId) {
    const checkingMsg = await sendMessage(
      chatId,
      isBatch
        ? `<blockquote><b>Preparing Batch</b>\n\n<i>Queued ${urls.length} links...</i></blockquote>`
        : allMedia
          ? `<blockquote><b>Inspecting Media</b>\n\n<i>Fetching title and preparing yt-dlp options...</i></blockquote>`
          : `<blockquote><b>Inspecting Link</b>\n\n<i>Verifying stream headers and file size...</i></blockquote>`,
      env,
      null,
      replyToMsgId
    );
    checkingMsgId = checkingMsg?.result?.message_id;
  }

  const taskId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  let task;

  if (!isBatch) {
    const rawUrl = urls[0];
    let ytdlUrl = (forceYtdl || isMediaSiteUrl(rawUrl)) ? rawUrl : '';
    let resolved = null;
    let accessToken = null;

    if (!ytdlUrl) {
      accessToken = await getValidAccessToken(userId, env);
      resolved = await resolveAndInspectInput(rawUrl, accessToken);

      if (resolved.kind === 'ytdl') {
        ytdlUrl = resolved.finalUrl || rawUrl;
      } else if (resolved.kind === 'error') {
        const errText =
          `<blockquote><b>Invalid Stream Link</b></blockquote>\n\n` +
          `Reason  ·  <code>${escapeHtml(resolved.reason)}</code>\n\n` +
          `Action  ·  Provide a direct file URL, supported host page, or try media mode (<code>/yt</code>).`;
        const retryId = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
        await env.SETTINGS_KV.put(
          `retry:${retryId}`,
          JSON.stringify({ url: rawUrl, userId, replyToMsgId }),
          { expirationTtl: 600 }
        );
        const retryKb = {
          inline_keyboard: [[{ text: '🎬 Try with yt-dlp', callback_data: `tm_try_yt:${retryId}`, style: 'primary' }]]
        };
        if (checkingMsgId) {
          await editMessage(chatId, checkingMsgId, errText, env, retryKb);
        } else {
          await sendMessage(chatId, errText, env, retryKb, replyToMsgId);
        }
        return;
      }
    }

    if (ytdlUrl) {
      const oembed = await fetchMediaOEmbed(ytdlUrl);
      const detectedTitle = oembed?.title || guessNameFromUrl(ytdlUrl) || 'Media';
      task = {
        taskId,
        userId,
        username,
        chatId,
        replyToMsgId,
        menuMsgId: checkingMsgId,
        fileUrl: ytdlUrl,
        items: [{ type: 'ytdl', url: ytdlUrl, name: detectedTitle }],
        batch: false,
        isDrive: false,
        isFolder: false,
        isYtdl: true,
        mediaAuthor: oembed?.author || '',
        ytQuality: profile.ytQuality || 'best',
        ytContainer: profile.ytContainer || 'mp4',
        ytSubs: false,
        ytSubLang: 'en',
        ytMeta: true,
        ytSponsorBlock: false,
        ytPlaylist: isPlaylistUrl(ytdlUrl) ? 'all' : 'single',
        ytPlaylistItems: '',
        ytTrim: '',
        detectedName: detectedTitle,
        customName: '',
        fileSize: 0,
        contentType: 'video/mp4',
        acceptRanges: true,
        folderId: profile.folderId || 'root',
        folderName: profile.folderName || 'My Drive',
        mode: 'normal',
        selectFilter: '',
        archivePassword: '',
        share: !!profile.autoShare,
        conflict: profile.conflict || 'rename',
        duplicateExists: false,
        createdAt: Date.now()
      };
    } else {
      const verification = resolved.verification;
      const isDrive = resolved.kind === 'gdrive';
      const fileUrl = resolved.finalUrl;

      let duplicateExists = false;
      try {
        if (accessToken) {
          const existing = await findDriveExisting(accessToken, profile.folderId || 'root', verification.fileName);
          duplicateExists = existing.length > 0;
        }
      } catch (_) {}

      const item = isDrive
        ? {
            type: 'gdrive',
            id: resolved.driveInfo.id,
            resourceKey: resolved.driveInfo.resourceKey || '',
            name: verification.fileName,
            mimeType: verification.contentType,
            size: verification.sizeBytes || 0,
            isFolder: !!verification.isFolder
          }
        : {
            type: 'url',
            url: fileUrl,
            sourceUrl: resolved.sourceUrl || '',
            resolvedVia: resolved.resolvedVia || '',
            name: verification.fileName,
            size: verification.sizeBytes || 0
          };

      task = {
        taskId,
        userId,
        username,
        chatId,
        replyToMsgId,
        menuMsgId: checkingMsgId,
        fileUrl,
        items: [item],
        batch: false,
        isDrive,
        isFolder: !!verification.isFolder,
        isYtdl: false,
        resolvedVia: resolved.resolvedVia || '',
        detectedName: verification.fileName,
        customName: '',
        fileSize: verification.sizeBytes || 0,
        contentType: verification.contentType || 'application/octet-stream',
        acceptRanges: verification.acceptRanges || false,
        folderId: profile.folderId || 'root',
        folderName: profile.folderName || 'My Drive',
        mode: 'normal',
        selectFilter: '',
        archivePassword: '',
        share: !!profile.autoShare,
        conflict: profile.conflict || 'rename',
        duplicateExists,
        createdAt: Date.now()
      };
    }
  } else {
    const items = urls.map(u => {
      if (forceYtdl || isMediaSiteUrl(u)) {
        return { type: 'ytdl', url: u, name: guessNameFromUrl(u) };
      }
      const gd = parseDriveUrl(u);
      if (gd) {
        return { type: 'gdrive', id: gd.id, resourceKey: gd.resourceKey || '' };
      }
      return { type: 'url', url: u, name: guessNameFromUrl(u) };
    });

    const batchHasYtdl = items.some(i => i.type === 'ytdl');
    task = {
      taskId,
      userId,
      username,
      chatId,
      replyToMsgId,
      menuMsgId: checkingMsgId,
      fileUrl: urls[0],
      items,
      batch: true,
      isDrive: items.every(i => i.type === 'gdrive'),
      isFolder: false,
      isYtdl: batchHasYtdl,
      ytQuality: profile.ytQuality || 'best',
      ytContainer: profile.ytContainer || 'mp4',
      ytSubs: false,
      ytSubLang: 'en',
      ytMeta: true,
      ytSponsorBlock: false,
      ytPlaylist: 'single',
      ytPlaylistItems: '',
      ytTrim: '',
      detectedName: `Batch (${items.length} links)`,
      customName: '',
      fileSize: 0,
      contentType: 'application/octet-stream',
      acceptRanges: false,
      folderId: profile.folderId || 'root',
      folderName: profile.folderName || 'My Drive',
      mode: 'normal',
      selectFilter: '',
      archivePassword: '',
      share: !!profile.autoShare,
      conflict: profile.conflict || 'rename',
      duplicateExists: false,
      createdAt: Date.now()
    };
  }

  await env.SETTINGS_KV.put(`task:${taskId}`, JSON.stringify(task), { expirationTtl: 7200 });

  if (profile.buttonMode === false) {
    await launchMirrorTask(task, env);
    return;
  }

  const menuText = buildTaskMenuMessage(task);
  const menuKb = buildTaskMenuKeyboard(task);

  if (checkingMsgId) {
    await editMessage(chatId, checkingMsgId, menuText, env, menuKb);
  } else {
    const sent = await sendMessage(chatId, menuText, env, menuKb, replyToMsgId);
    task.menuMsgId = sent?.result?.message_id;
    await env.SETTINGS_KV.put(`task:${taskId}`, JSON.stringify(task), { expirationTtl: 7200 });
  }
}

// ============================================================================
// HANDLE INTERACTIVE PROMPTS
// ============================================================================

async function handleUserPromptInput(chatId, userId, text, promptState, msgId, env) {
  if (promptState.type === 'rename') {
    const raw = await env.SETTINGS_KV.get(`task:${promptState.taskId}`);
    if (!raw) {
      await sendMessage(chatId, `<i>Task session expired.</i>`, env);
      return;
    }
    const task = JSON.parse(raw);
    task.customName = text.replace(/[/\\?%*:|"<>]/g, '_').trim();
    if (!task.batch && task.customName) {
      const accessToken = await getValidAccessToken(userId, env);
      if (accessToken) {
        const existing = await findDriveExisting(accessToken, task.folderId || 'root', task.customName);
        task.duplicateExists = existing.length > 0;
      }
    }
    await env.SETTINGS_KV.put(`task:${task.taskId}`, JSON.stringify(task), { expirationTtl: 7200 });

    if (task.menuMsgId) {
      await editMessage(chatId, task.menuMsgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
    }
    await sendMessage(chatId, `Renamed  ·  <code>${escapeHtml(task.customName)}</code>`, env);
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
        ? `Extension Filter  ·  <code>${escapeHtml(task.selectFilter)}</code>`
        : `Filter Cleared  ·  All extracted files will be uploaded.`,
      env
    );
    return;
  }

  if (promptState.type === 'archive_password') {
    const raw = await env.SETTINGS_KV.get(`task:${promptState.taskId}`);
    if (!raw) {
      await sendMessage(chatId, `<i>Task session expired.</i>`, env);
      return;
    }
    const task = JSON.parse(raw);
    const clear = text.toLowerCase() === 'clear' || text.toLowerCase() === 'none';
    task.archivePassword = clear ? '' : text;
    await env.SETTINGS_KV.put(`task:${task.taskId}`, JSON.stringify(task), { expirationTtl: 7200 });
    await deleteMessage(chatId, msgId, env);

    if (task.menuMsgId) {
      await editMessage(chatId, task.menuMsgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
    }
    await sendMessage(
      chatId,
      clear ? `Archive Password  ·  Cleared` : `Archive Password  ·  <code>Set (hidden)</code>`,
      env
    );
    return;
  }

  if (promptState.type === 'yt_sublang' || promptState.type === 'yt_plitems' || promptState.type === 'yt_trim') {
    const raw = await env.SETTINGS_KV.get(`task:${promptState.taskId}`);
    if (!raw) {
      await sendMessage(chatId, `<i>Task session expired.</i>`, env);
      return;
    }
    const task = JSON.parse(raw);
    const val = text.trim();
    const clear = val.toLowerCase() === 'clear' || val.toLowerCase() === 'none';
    let notice = '';

    if (promptState.type === 'yt_sublang') {
      task.ytSubLang = clear ? 'en' : val.replace(/\s+/g, '');
      notice = `Subtitle Language  ·  <code>${escapeHtml(task.ytSubLang)}</code>`;
    } else if (promptState.type === 'yt_plitems') {
      task.ytPlaylistItems = clear ? '' : val.replace(/\s+/g, '');
      notice = task.ytPlaylistItems
        ? `Playlist Items  ·  <code>${escapeHtml(task.ytPlaylistItems)}</code>`
        : `Playlist Items  ·  All items`;
    } else if (promptState.type === 'yt_trim') {
      if (clear) {
        task.ytTrim = '';
        notice = `Trim Range  ·  Cleared`;
      } else if (!/^\d{1,2}(?::\d{1,2}){0,2}-\d{1,2}(?::\d{1,2}){0,2}$/.test(val)) {
        await sendMessage(chatId, `Invalid format. Use <code>MM:SS-MM:SS</code> or <code>HH:MM:SS-HH:MM:SS</code> (e.g. <code>00:30-02:15</code>).`, env);
        return;
      } else {
        task.ytTrim = val;
        notice = `Trim Range  ·  <code>${escapeHtml(task.ytTrim)}</code>`;
      }
    }

    await env.SETTINGS_KV.put(`task:${task.taskId}`, JSON.stringify(task), { expirationTtl: 7200 });
    if (task.menuMsgId) {
      await editMessage(chatId, task.menuMsgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
    }
    await sendMessage(chatId, notice, env);
    return;
  }

  if (promptState.type === 'mkdir') {
    const accessToken = await getValidAccessToken(userId, env);
    if (!accessToken) {
      await sendMessage(chatId, `Please run /login first.`, env);
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
        mimeType: FOLDER_MIME,
        parents: [parentId]
      })
    });

    if (!createRes.ok) {
      await sendMessage(chatId, `Error  ·  Could not create folder on Google Drive.`, env);
      return;
    }
    const created = await createRes.json();
    await openFolderBrowser(chatId, userId, created.id, promptState.browserMsgId || null, promptState.returnTaskId || null, env);
  }
}

// ============================================================================
// CALLBACK QUERY HANDLER
// ============================================================================

async function handleCallbackQuery(cb, env) {
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;
  const userId = cb.from.id;
  const data = cb.data || '';

  if (data.startsWith('fb_')) {
    const bRaw = await env.SETTINGS_KV.get(`browser:${userId}`);
    if (!bRaw && data !== 'fb_close') {
      await answerCb(cb.id, 'Session expired. Run /setdldir again.', true, env);
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
      await answerCb(cb.id, `Opening ${item.name}`, false, env);
      await openFolderBrowser(chatId, userId, item.id, msgId, bState.returnTaskId, env, 0);
      return;
    }
    if (data.startsWith('fb_file:')) {
      const idx = parseInt(data.split(':')[1], 10);
      const item = bState.items[idx];
      if (item) {
        await answerCb(cb.id, `${item.name} (${fmtBytes(item.size)})`, true, env);
      }
      return;
    }
    if (data.startsWith('fb_page:')) {
      const nextPage = parseInt(data.split(':')[1], 10);
      await answerCb(cb.id, `Page ${nextPage + 1}`, false, env);
      await renderFolderBrowserPage(chatId, userId, bState, nextPage, msgId, env);
      return;
    }
    if (data === 'fb_up') {
      await answerCb(cb.id, 'Parent folder', false, env);
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
      await answerCb(cb.id, 'Send new folder name', false, env);
      await sendMessage(
        chatId,
        `<blockquote><b>New Folder</b>\n\nParent  ·  <code>${escapeHtml(bState.currentName)}</code></blockquote>\n\n` +
          `Send the folder name now, or /cancel:`,
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
          if (String(task.userId) === String(userId)) {
            task.folderId = bState.currentId;
            task.folderName = bState.currentName;
            if (!task.batch) {
              const accessToken = await getValidAccessToken(userId, env);
              if (accessToken) {
                const ex = await findDriveExisting(accessToken, task.folderId, task.customName || task.detectedName);
                task.duplicateExists = ex.length > 0;
              }
            }
            await env.SETTINGS_KV.put(`task:${task.taskId}`, JSON.stringify(task), { expirationTtl: 7200 });
            await answerCb(cb.id, `Folder: ${bState.currentName}`, false, env);
            await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
            return;
          }
        }
      }

      await answerCb(cb.id, `Selected: ${bState.currentName}`, false, env);
      await editMessage(
        chatId,
        msgId,
        `<blockquote><b>Upload Directory Updated</b></blockquote>\n\n` +
          `Destination  ·  ${escapeHtml(bState.currentName)}\n\n` +
          `Change anytime  ·  /setdldir`,
        env
      );
      return;
    }
    if (data.startsWith('fb_back:')) {
      const tid = data.split(':')[1];
      const tRaw = await env.SETTINGS_KV.get(`task:${tid}`);
      if (tRaw) {
        const task = JSON.parse(tRaw);
        if (String(task.userId) === String(userId)) {
          await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
        }
      }
      await answerCb(cb.id, 'Returned to task', false, env);
      return;
    }
  }

  if (data.startsWith('tm_try_yt:')) {
    const retryId = data.split(':')[1];
    const rRaw = await env.SETTINGS_KV.get(`retry:${retryId}`);
    if (!rRaw) {
      await answerCb(cb.id, 'Link expired. Send the URL with /yt.', true, env);
      return;
    }
    const rData = JSON.parse(rRaw);
    if (String(rData.userId) !== String(userId)) {
      await answerCb(cb.id, 'You can only retry your own link.', true, env);
      return;
    }
    await env.SETTINGS_KV.delete(`retry:${retryId}`);
    await answerCb(cb.id, 'Switching to yt-dlp mode...', false, env);
    const uname = cb.from.username || cb.from.first_name || 'User';
    await startTaskFromUrls(chatId, userId, uname, rData.replyToMsgId || msgId, [rData.url], env, { forceYtdl: true, editMsgId: msgId });
    return;
  }

  if (data.startsWith('tm_')) {
    const parts = data.split(':');
    const action = parts[0];
    const tid = parts[1];
    const arg = parts[2];

    const tRaw = await env.SETTINGS_KV.get(`task:${tid}`);
    if (!tRaw) {
      await answerCb(cb.id, 'Task session expired.', true, env);
      return;
    }
    const task = JSON.parse(tRaw);
    if (String(task.userId) !== String(userId)) {
      await answerCb(cb.id, 'You can only modify your own task.', true, env);
      return;
    }
    task.menuMsgId = msgId;

    if (action === 'tm_cancel') {
      await env.SETTINGS_KV.delete(`task:${tid}`);
      await editMessage(chatId, msgId, `<blockquote><b>Task Cancelled</b></blockquote>`, env);
      await answerCb(cb.id, 'Cancelled', false, env);
      return;
    }

    if (action === 'tm_back') {
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, 'Updated', false, env);
      return;
    }

    if (action === 'tm_ytqual') {
      const { text, kb } = buildYtdlQualityMenu(task);
      await editMessage(chatId, msgId, text, env, kb);
      await answerCb(cb.id, 'Select quality', false, env);
      return;
    }

    if (action === 'tm_ytqset' && YT_QUALITY_LABELS[arg]) {
      task.ytQuality = arg;
      await env.SETTINGS_KV.put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Quality: ${ytQualityLabel(arg)}`, false, env);
      return;
    }

    if (action === 'tm_ytcont') {
      const curIdx = YT_CONTAINERS.indexOf(task.ytContainer || 'mp4');
      task.ytContainer = YT_CONTAINERS[(curIdx + 1) % YT_CONTAINERS.length];
      await env.SETTINGS_KV.put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Container: ${ytContainerLabel(task.ytContainer)}`, false, env);
      return;
    }

    if (action === 'tm_ytsubs') {
      task.ytSubs = !task.ytSubs;
      await env.SETTINGS_KV.put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Subtitles: ${task.ytSubs ? 'ON' : 'OFF'}`, false, env);
      return;
    }

    if (action === 'tm_ytslang') {
      await env.SETTINGS_KV.put(
        `prompt:${userId}`,
        JSON.stringify({ type: 'yt_sublang', taskId: tid }),
        { expirationTtl: 600 }
      );
      await answerCb(cb.id, 'Send subtitle language', false, env);
      await sendMessage(
        chatId,
        `<blockquote><b>Subtitle Language</b>\n\nCurrent  ·  <code>${escapeHtml(task.ytSubLang || 'en')}</code></blockquote>\n\n` +
          `Send language code(s) (e.g. <code>en</code>, <code>en,hi</code>, <code>all</code>), or /cancel:`,
        env
      );
      return;
    }

    if (action === 'tm_ytmeta') {
      task.ytMeta = task.ytMeta === false;
      await env.SETTINGS_KV.put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Metadata & Thumb: ${task.ytMeta ? 'ON' : 'OFF'}`, false, env);
      return;
    }

    if (action === 'tm_ytsb') {
      task.ytSponsorBlock = !task.ytSponsorBlock;
      await env.SETTINGS_KV.put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `SponsorBlock: ${task.ytSponsorBlock ? 'ON' : 'OFF'}`, false, env);
      return;
    }

    if (action === 'tm_ytpl') {
      task.ytPlaylist = task.ytPlaylist === 'all' ? 'single' : 'all';
      await env.SETTINGS_KV.put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Playlist: ${task.ytPlaylist === 'all' ? 'All Items' : 'Single Video'}`, false, env);
      return;
    }

    if (action === 'tm_ytplitems') {
      await env.SETTINGS_KV.put(
        `prompt:${userId}`,
        JSON.stringify({ type: 'yt_plitems', taskId: tid }),
        { expirationTtl: 600 }
      );
      await answerCb(cb.id, 'Send playlist range', false, env);
      await sendMessage(
        chatId,
        `<blockquote><b>Playlist Items</b></blockquote>\n\n` +
          `Send item indices/ranges (e.g. <code>1-5</code> or <code>1,3,7-10</code>), <code>clear</code> for all, or /cancel:`,
        env
      );
      return;
    }

    if (action === 'tm_yttrim') {
      await env.SETTINGS_KV.put(
        `prompt:${userId}`,
        JSON.stringify({ type: 'yt_trim', taskId: tid }),
        { expirationTtl: 600 }
      );
      await answerCb(cb.id, 'Send trim range', false, env);
      await sendMessage(
        chatId,
        `<blockquote><b>Trim / Clip Section</b></blockquote>\n\n` +
          `Send start and end timestamps (e.g. <code>00:30-02:15</code> or <code>1:05:00-1:10:00</code>), <code>clear</code> to remove, or /cancel:`,
        env
      );
      return;
    }

    if (action === 'tm_ext') {
      task.mode = task.mode === 'extract' ? 'normal' : 'extract';
      await env.SETTINGS_KV.put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Extract: ${task.mode === 'extract' ? 'ON' : 'OFF'}`, false, env);
      return;
    }

    if (action === 'tm_zip') {
      task.mode = task.mode === 'zip' ? 'normal' : 'zip';
      await env.SETTINGS_KV.put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Create ZIP: ${task.mode === 'zip' ? 'ON' : 'OFF'}`, false, env);
      return;
    }

    if (action === 'tm_share') {
      task.share = !task.share;
      await env.SETTINGS_KV.put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Share Link: ${task.share ? 'ON' : 'OFF'}`, false, env);
      return;
    }

    if (action === 'tm_confmenu') {
      const { text, kb } = buildConflictMenu(task);
      await editMessage(chatId, msgId, text, env, kb);
      await answerCb(cb.id, 'Duplicate Handling', false, env);
      return;
    }

    if (action === 'tm_confset' && ['rename', 'overwrite', 'skip'].includes(arg)) {
      task.conflict = arg;
      await env.SETTINGS_KV.put(`task:${tid}`, JSON.stringify(task), { expirationTtl: 7200 });
      await editMessage(chatId, msgId, buildTaskMenuMessage(task), env, buildTaskMenuKeyboard(task));
      await answerCb(cb.id, `Duplicate: ${conflictLabel(arg)}`, false, env);
      return;
    }

    if (action === 'tm_ren') {
      await env.SETTINGS_KV.put(
        `prompt:${userId}`,
        JSON.stringify({ type: 'rename', taskId: tid }),
        { expirationTtl: 600 }
      );
      await answerCb(cb.id, 'Send new file name', false, env);
      await sendMessage(
        chatId,
        `<blockquote><b>Rename File</b>\n\n<code>${escapeHtml(task.customName || task.detectedName)}</code></blockquote>\n\n` +
          `Send the new filename (including extension), or /cancel:`,
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
      await answerCb(cb.id, 'Send extension filter', false, env);
      await sendMessage(
        chatId,
        `<blockquote><b>Archive Extension Filter</b></blockquote>\n\n` +
          `Send comma-separated extensions to keep when extracting (e.g. <code>.mkv, .mp4, .srt</code>) or send <code>all</code>:`,
        env
      );
      return;
    }

    if (action === 'tm_pass') {
      await env.SETTINGS_KV.put(
        `prompt:${userId}`,
        JSON.stringify({ type: 'archive_password', taskId: tid }),
        { expirationTtl: 600 }
      );
      await answerCb(cb.id, 'Send archive password', false, env);
      await sendMessage(
        chatId,
        `<blockquote><b>Archive Password</b></blockquote>\n\n` +
          `Send the password to ${task.mode === 'zip' ? 'encrypt the ZIP' : 'extract the archive'}, send <code>clear</code> to remove, or /cancel.\n\n` +
          `<i>Your password message will be deleted immediately after saving.</i>`,
        env
      );
      return;
    }

    if (action === 'tm_dir') {
      await answerCb(cb.id, 'Opening Folder Browser', false, env);
      await openFolderBrowser(chatId, userId, task.folderId || 'root', msgId, tid, env, 0);
      return;
    }

    if (action === 'tm_info') {
      const rangeLine = task.isDrive
        ? `Transfer  ·  Server-Side / Drive API`
        : `Range I/O  ·  ${task.acceptRanges ? 'Supported (16x parallel)' : 'Single Stream'}`;
      const viaLine = task.resolvedVia ? `\n\nResolved  ·  ${escapeHtml(task.resolvedVia)}` : '';
      const dupLine = task.duplicateExists ? `\n\nDuplicate  ·  Exists in target folder` : '';
      const infoMsg =
        `<blockquote><b>Stream Metadata</b>\n\n` +
        `<code>${escapeHtml(task.detectedName)}</code></blockquote>\n\n` +
        `Size  ·  <code>${task.fileSize > 0 ? fmtBytes(task.fileSize) : 'Unknown'}</code>` +
        `${task.fileSize > 0 ? `  (<code>${task.fileSize.toLocaleString()} B</code>)` : ''}\n\n` +
        `MIME  ·  <code>${escapeHtml(task.contentType)}</code>\n\n` +
        `${rangeLine}${viaLine}${dupLine}`;
      await editMessage(chatId, msgId, infoMsg, env, {
        inline_keyboard: [[{ text: '↩ Back to Options', callback_data: `tm_back:${tid}`, style: 'primary' }]]
      });
      await answerCb(cb.id, 'Stream Metadata', false, env);
      return;
    }

    if (action === 'tm_nobtn') {
      const profile = await getUserProfile(userId, env);
      if (profile) {
        profile.buttonMode = false;
        await saveUserProfile(userId, profile, env);
      }
      await answerCb(cb.id, 'ButtonMode disabled. Starting...', false, env);
      await launchMirrorTask(task, env);
      return;
    }

    if (action === 'tm_start') {
      await answerCb(cb.id, 'Starting...', false, env);
      await launchMirrorTask(task, env);
      return;
    }
  }

  if (data.startsWith('st_')) {
    const [action, jobId] = data.split(':');
    const jr = await env.SETTINGS_KV.get(`job:${jobId}`);
    const job = jr ? JSON.parse(jr) : null;

    if (action === 'st_ref') {
      await answerCb(cb.id, 'Live telemetry updates every 2.5s automatically.', false, env);
      return;
    }

    if (job && String(job.userId) !== String(userId)) {
      await answerCb(cb.id, 'You can only control your own task.', true, env);
      return;
    }

    if (action === 'st_close') {
      await deleteMessage(chatId, msgId, env);
      if (job) {
        job.messageId = '';
        await env.SETTINGS_KV.put(`job:${jobId}`, JSON.stringify(job), { expirationTtl: 25200 });
      }
      await answerCb(cb.id, 'Closed — use /tasks to reopen', false, env);
      return;
    }
    if (action === 'st_cancel') {
      await answerCb(cb.id, 'Stopping task...', false, env);
      await cancelActiveJob(chatId, userId, jobId, env);
      return;
    }
  }

  if (data === 'hist_clear') {
    await env.SETTINGS_KV.delete(`history:${userId}`);
    await answerCb(cb.id, 'History cleared', false, env);
    await sendHistory(chatId, userId, msgId, env);
    return;
  }

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
    if (data === 'cfg_toggle_share') {
      profile.autoShare = !profile.autoShare;
      await saveUserProfile(userId, profile, env);
      await answerCb(cb.id, `Auto Share: ${profile.autoShare ? 'ON' : 'OFF'}`, false, env);
      await sendSettingsMenu(chatId, userId, profile, msgId, env);
      return;
    }
    if (data === 'cfg_conf_menu') {
      const cur = profile.conflict || 'rename';
      const mark = (v, l) => (cur === v ? `✓ ${l}` : l);
      await editMessage(
        chatId,
        msgId,
        `<blockquote><b>Default Duplicate Policy</b></blockquote>\n\n` +
          `Choose what happens when a file with the same name already exists in your Drive folder:`,
        env,
        {
          inline_keyboard: [
            [
              { text: mark('rename', 'Rename (Keep Both)'), callback_data: 'cfg_conf:rename', style: cur === 'rename' ? 'success' : undefined },
              { text: mark('overwrite', 'Overwrite'), callback_data: 'cfg_conf:overwrite', style: cur === 'overwrite' ? 'success' : undefined }
            ],
            [
              { text: mark('skip', 'Skip'), callback_data: 'cfg_conf:skip', style: cur === 'skip' ? 'success' : undefined },
              { text: '↩ Back', callback_data: 'cfg_back', style: 'primary' }
            ]
          ]
        }
      );
      await answerCb(cb.id, 'Duplicate Policy', false, env);
      return;
    }
    if (data.startsWith('cfg_conf:')) {
      const val = data.split(':')[1];
      if (['rename', 'overwrite', 'skip'].includes(val)) {
        profile.conflict = val;
        await saveUserProfile(userId, profile, env);
        await answerCb(cb.id, `Duplicate: ${conflictLabel(val)}`, false, env);
      }
      await sendSettingsMenu(chatId, userId, profile, msgId, env);
      return;
    }
    if (data === 'cfg_back') {
      await answerCb(cb.id, 'Preferences', false, env);
      await sendSettingsMenu(chatId, userId, profile, msgId, env);
      return;
    }
    if (data === 'cfg_yt_menu') {
      const q = profile.ytQuality || 'best';
      const c = profile.ytContainer || 'mp4';
      const qBtn = (val, label) => ({
        text: q === val ? `✓ ${label}` : label,
        callback_data: `cfg_ytq:${val}`,
        style: q === val ? 'success' : undefined
      });
      const cBtn = (val, label) => ({
        text: c === val ? `✓ ${label}` : label,
        callback_data: `cfg_ytc:${val}`,
        style: c === val ? 'primary' : undefined
      });
      await editMessage(
        chatId,
        msgId,
        `<blockquote><b>Default Media (yt-dlp) Settings</b></blockquote>\n\n` +
          `Quality  ·  <code>${ytQualityLabel(q)}</code>\n` +
          `Container  ·  <code>${ytContainerLabel(c)}</code>`,
        env,
        {
          inline_keyboard: [
            [qBtn('best', 'Best'), qBtn('2160', '4K'), qBtn('1440', '2K')],
            [qBtn('1080', '1080p'), qBtn('720', '720p'), qBtn('480', '480p')],
            [qBtn('mp3', 'MP3'), qBtn('m4a', 'M4A'), qBtn('opus', 'Opus')],
            [cBtn('mp4', 'MP4'), cBtn('mkv', 'MKV'), cBtn('auto', 'Auto')],
            [{ text: '↩ Back', callback_data: 'cfg_back', style: 'primary' }]
          ]
        }
      );
      await answerCb(cb.id, 'Media Defaults', false, env);
      return;
    }
    if (data.startsWith('cfg_ytq:')) {
      const val = data.split(':')[1];
      if (YT_QUALITY_LABELS[val]) {
        profile.ytQuality = val;
        await saveUserProfile(userId, profile, env);
        await answerCb(cb.id, `Default Quality: ${ytQualityLabel(val)}`, false, env);
      }
      await sendSettingsMenu(chatId, userId, profile, msgId, env);
      return;
    }
    if (data.startsWith('cfg_ytc:')) {
      const val = data.split(':')[1];
      if (YT_CONTAINERS.includes(val)) {
        profile.ytContainer = val;
        await saveUserProfile(userId, profile, env);
        await answerCb(cb.id, `Default Container: ${ytContainerLabel(val)}`, false, env);
      }
      await sendSettingsMenu(chatId, userId, profile, msgId, env);
      return;
    }
    if (data === 'cfg_dir') {
      await answerCb(cb.id, 'Opening directory browser', false, env);
      await openFolderBrowser(chatId, userId, profile.folderId || 'root', msgId, null, env, 0);
      return;
    }
  }
}

// ============================================================================
// PRE-FLIGHT SPACE VERIFICATION, DIRECT DRIVE COPY & WORKFLOW LAUNCH
// ============================================================================

async function launchMirrorTask(task, env) {
  const { chatId, userId, taskId, menuMsgId } = task;
  const accessToken = await getValidAccessToken(userId, env);
  if (!accessToken) {
    await editMessage(
      chatId,
      menuMsgId,
      `<blockquote><b>Session Expired</b>\n\nPlease reconnect your Google Drive with /login.</blockquote>`,
      env
    );
    return;
  }

  const quota = await getDriveQuota(accessToken);
  const fileSize = task.fileSize || 0;

  if (!task.batch && fileSize > 0 && quota && quota.free !== Infinity && fileSize > quota.free) {
    const msg =
      `<blockquote><b>Insufficient Drive Storage</b>\n\n` +
      `<code>${escapeHtml(task.customName || task.detectedName)}</code></blockquote>\n\n` +
      `Required  ·  <code>${fmtBytes(fileSize)}</code>\n\n` +
      `Available  ·  <code>${fmtBytes(quota.free)}</code>\n\n` +
      `<i>Free up space in your Google Drive and try again.</i>`;
    await editMessage(chatId, menuMsgId, msg, env);
    return;
  }

  // Fast server-side copy directly in Worker for single Drive file in normal mode
  const singleItem = !task.batch && task.items?.length === 1 ? task.items[0] : null;
  if (singleItem && singleItem.type === 'gdrive' && !task.isFolder && task.mode === 'normal') {
    await executeDirectDriveCopy(task, singleItem, accessToken, env);
    return;
  }

  let fallbackNotice = '';
  if (!task.batch && fileSize > 0) {
    if (task.mode === 'extract' || task.mode === 'zip') {
      const workspaceNeeded = fileSize * 2.1;
      if (workspaceNeeded > RUNNER_LIMIT_BYTES) {
        fallbackNotice =
          `<blockquote><b>Workspace Notice</b>\n\n` +
          `Archive processing needs <code>${fmtBytes(workspaceNeeded)}</code>. Switching to direct upload.</blockquote>\n\n`;
        task.mode = 'normal';
      }
    }

    if (fileSize > RUNNER_LIMIT_BYTES) {
      await editMessage(
        chatId,
        menuMsgId,
        `<blockquote><b>Capacity Limit</b>\n\n` +
          `File size (<code>${fmtBytes(fileSize)}</code>) exceeds the 112 GiB runner workspace.</blockquote>`,
        env
      );
      return;
    }
  }

  const modeTag = task.isYtdl
    ? (YT_AUDIO_QUALITIES.has(task.ytQuality) ? '#Audio' : '#ytdlp')
    : (task.mode === 'extract' ? '#Extract' : task.mode === 'zip' ? '#ArchiveZIP' : '#Mirror');
  const freeDriveStr = quota && quota.free !== Infinity ? fmtBytes(quota.free) : 'Unlimited';
  const actionsUrl = `https://github.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions`;
  const displayTitle = task.batch
    ? `Batch (${task.items.length} links)`
    : (task.customName || task.detectedName);

  const bootText =
    `${fallbackNotice}` +
    `<blockquote>📄 <b>Name :</b> <code>${escapeHtml(displayTitle)}</code></blockquote>\n\n` +
    `┌ Status : <a href="${actionsUrl}">Booting..</a> (0.00%)\n` +
    `├ [<code>□□□□□□□□□□□□</code>]\n` +
    `├ By : @${escapeHtml(task.username)}\n` +
    `├ UserID : <code>[${userId}]</code>\n` +
    `├ Size : <code>${fileSize > 0 ? fmtBytes(fileSize) : 'Unknown'}</code>\n` +
    `├ Folder : ${escapeHtml(task.folderName)}\n` +
    `├ Drive Free : <code>${freeDriveStr}</code>\n` +
    `├ Mode : <code>${modeTag}</code>\n` +
    `└ ⛔ /cancel_${taskId}\n\n` +
    `____________________________\n\n` +
    `<pre><code>┌ SYSTEM\n` +
    `├ 🟢 Cpu [□□□□□□□□□□] 0.0%\n` +
    `├ 🟢 Ram [□□□□□□□□□□] 0.0%\n` +
    `├ 🟢 Free [■□□□□□□□□□] 115.00GB\n` +
    `└ 🕒 Allocating runner (~10s)..</code></pre>`;

  await editMessage(chatId, menuMsgId, bootText, env, {
    inline_keyboard: [
      [
        { text: '🔄 Refresh', callback_data: `st_ref:${taskId}`, style: 'primary' },
        { text: '🔽 Close', callback_data: `st_close:${taskId}`, style: 'danger' }
      ]
    ]
  });

  const jobData = {
    jobId: taskId,
    userId,
    username: task.username,
    chatId,
    messageId: menuMsgId,
    fileUrl: task.fileUrl,
    items: task.items,
    batch: !!task.batch,
    detectedName: displayTitle,
    customName: task.customName,
    fileSize: task.fileSize,
    folderId: task.folderId,
    folderName: task.folderName,
    mode: task.mode,
    selectFilter: task.selectFilter,
    archivePassword: task.archivePassword || '',
    share: !!task.share,
    conflict: task.conflict || 'rename',
    isYtdl: !!task.isYtdl,
    ytQuality: task.ytQuality || 'best',
    ytContainer: task.ytContainer || 'mp4',
    ytSubs: !!task.ytSubs,
    ytSubLang: task.ytSubLang || 'en',
    ytMeta: task.ytMeta !== false,
    ytSponsorBlock: !!task.ytSponsorBlock,
    ytPlaylist: task.ytPlaylist || 'single',
    ytPlaylistItems: task.ytPlaylistItems || '',
    ytTrim: task.ytTrim || '',
    status: 'booting',
    cancelled: false,
    createdAt: Date.now()
  };

  await env.SETTINGS_KV.put(`job:${taskId}`, JSON.stringify(jobData), { expirationTtl: 25200 });
  await addActiveJobForUser(userId, taskId, env);

  const dispatched = await triggerGithubWorkflow(taskId, env);
  if (!dispatched) {
    await removeActiveJobForUser(userId, taskId, env);
    await editMessage(
      chatId,
      menuMsgId,
      `<blockquote><b>Dispatch Error</b>\n\nCould not trigger GitHub Actions runner.</blockquote>`,
      env
    );
  }
}

async function executeDirectDriveCopy(task, item, accessToken, env) {
  const { chatId, userId, menuMsgId, folderId, folderName } = task;
  const targetName = (task.customName || task.detectedName || 'Drive File').trim();
  const conflict = task.conflict || 'rename';

  await editMessage(
    chatId,
    menuMsgId,
    `<blockquote>📄 <b>Name :</b> <code>${escapeHtml(targetName)}</code></blockquote>\n\n` +
      `┌ Status : Server-Side Copy..\n` +
      `├ Engine : <code>Drive API v3</code>\n` +
      `└ Folder : ${escapeHtml(folderName || 'My Drive')}`,
    env
  );

  try {
    let finalName = targetName;
    const existing = await findDriveExisting(accessToken, folderId, targetName);
    let copied = null;
    let status = 'completed';

    if (existing.length > 0) {
      if (conflict === 'skip') {
        copied = existing[0];
        status = 'skipped';
      } else if (conflict === 'overwrite') {
        await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(existing[0].id)}?supportsAllDrives=true`,
          {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ trashed: true })
          }
        );
      } else {
        finalName = await findFreeDriveName(accessToken, folderId, targetName, false);
      }
    }

    if (!copied) {
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      };
      if (item.resourceKey) {
        headers['X-Goog-Drive-Resource-Keys'] = `${item.id}/${item.resourceKey}`;
      }
      const copyRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(item.id)}/copy?fields=id,name,mimeType,webViewLink,size&supportsAllDrives=true`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            name: finalName,
            parents: [folderId || 'root']
          })
        }
      );
      const copyJson = await copyRes.json();
      if (!copyRes.ok || !copyJson.id) {
        throw new Error(extractDriveApiError(copyJson, 'Drive server-side copy failed'));
      }
      copied = copyJson;
    }

    const fid = copied.id;
    const fileLink = copied.webViewLink || `https://drive.google.com/file/d/${fid}/view`;
    const folderUrl = folderId && folderId !== 'root'
      ? `https://drive.google.com/drive/folders/${folderId}`
      : 'https://drive.google.com/drive/my-drive';
    const size = parseInt(copied.size || task.fileSize || 0, 10) || 0;

    let shared = false;
    let direct = '';
    if (task.share && status === 'completed') {
      shared = await makeDrivePublic(accessToken, fid);
      if (shared) {
        direct = `https://drive.google.com/uc?id=${fid}&export=download`;
      }
    }

    const uname = task.username && !task.username.startsWith('@') ? `@${task.username}` : (task.username || 'User');
    const title = status === 'completed' ? 'Transfer Complete' : 'Skipped — Already Exists';
    let text =
      `<blockquote><b>${title}</b>\n\n` +
      `<code>${escapeHtml(copied.name || finalName)}</code></blockquote>\n\n` +
      `Size  ·  <code>${fmtBytes(size)}</code>\n\n` +
      `Folder  ·  ${escapeHtml(folderName || 'My Drive')}\n\n` +
      `Engine  ·  <code>Drive Server-Side</code>\n\n`;
    if (shared) {
      text += `Access  ·  Anyone with the link\n\n`;
    }
    text += `User  ·  ${escapeHtml(uname)}`;

    const rows = [[
      { text: '▸  Open File', url: fileLink, style: 'success' },
      { text: 'Open Folder', url: folderUrl, style: 'primary' }
    ]];
    if (direct) {
      rows.push([{ text: '⬇ Direct Download', url: direct, style: 'primary' }]);
    }

    await editMessage(chatId, menuMsgId, text, env, { inline_keyboard: rows });
    await appendHistory(userId, [{
      name: copied.name || finalName,
      link: fileLink,
      direct,
      size,
      status,
      mode: 'gdrive-copy',
      shared,
      ts: Date.now()
    }], env);
  } catch (err) {
    const reason = friendlyDriveError(err.message) || err.message || 'Drive copy failed';
    await editMessage(
      chatId,
      menuMsgId,
      `<blockquote><b>Transfer Failed</b>\n\n` +
        `<code>${escapeHtml(targetName)}</code></blockquote>\n\n` +
        `Reason  ·  <code>${escapeHtml(reason.slice(0, 300))}</code>`,
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
    const tokenInfo = await getValidTokenInfo(job.userId, env, false);
    if (!tokenInfo) {
      return jsonResponse({ ok: false, error: 'Could not mint Google access token for user' }, 400);
    }
    return jsonResponse({
      ok: true,
      job: { ...job, accessToken: tokenInfo.accessToken, tokenExpiry: tokenInfo.tokenExpiry }
    });
  }

  if (path === '/internal/refresh') {
    const tokenInfo = await getValidTokenInfo(job.userId, env, !!body.force);
    return jsonResponse({
      ok: !!tokenInfo,
      accessToken: tokenInfo?.accessToken || null,
      expiry: tokenInfo?.tokenExpiry || null
    });
  }

  if (path === '/internal/job-status') {
    if (typeof body.last_card === 'string' && body.last_card.length > 0) {
      job.lastCardHtml = body.last_card;
      await env.SETTINGS_KV.put(`job:${jobId}`, JSON.stringify(job), { expirationTtl: 25200 });
    }
    return jsonResponse({ ok: true, cancelled: !!job.cancelled, status: job.status, messageId: job.messageId || '' });
  }

  if (path === '/internal/complete') {
    job.status = body.status || 'completed';
    await env.SETTINGS_KV.put(`job:${jobId}`, JSON.stringify(job), { expirationTtl: 3600 });
    await removeActiveJobForUser(job.userId, jobId, env);

    if (Array.isArray(body.items) && body.items.length > 0) {
      const doneItems = body.items
        .filter(it => it && (it.status === 'completed' || it.status === 'skipped') && it.link)
        .map(it => ({
          name: it.name || 'File',
          link: it.link,
          direct: it.direct || '',
          size: it.size || 0,
          status: it.status,
          mode: job.mode || 'normal',
          shared: !!it.shared,
          ts: Date.now()
        }));
      if (doneItems.length) {
        await appendHistory(job.userId, doneItems, env);
      }
    }
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: 'Unknown path' }, 404);
}

// ============================================================================
// HISTORY, ACTIVE TASKS & CANCELLATION
// ============================================================================

async function appendHistory(userId, entries, env) {
  if (!entries || !entries.length) return;
  const raw = await env.SETTINGS_KV.get(`history:${userId}`);
  const list = raw ? JSON.parse(raw) : [];
  const merged = [...entries.reverse(), ...list].slice(0, MAX_HISTORY_ITEMS);
  await env.SETTINGS_KV.put(`history:${userId}`, JSON.stringify(merged));
}

async function sendHistory(chatId, userId, editMsgId, env) {
  const raw = await env.SETTINGS_KV.get(`history:${userId}`);
  const list = raw ? JSON.parse(raw) : [];

  if (!list.length) {
    const emptyText = `<blockquote><b>Transfer History</b>\n\n<i>No completed transfers yet.</i></blockquote>`;
    if (editMsgId) {
      await editMessage(chatId, editMsgId, emptyText, env);
    } else {
      await sendMessage(chatId, emptyText, env);
    }
    return;
  }

  let body = '';
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const icon = it.status === 'skipped' ? '↷' : '✓';
    const name = escapeHtml(truncate(it.name || 'File', 42));
    const link = escapeHtml(it.link || 'https://drive.google.com');
    const sizeStr = it.size > 0 ? `  <code>${fmtBytes(it.size)}</code>` : '';
    const line = `${i + 1}. ${icon} <a href="${link}">${name}</a>${sizeStr}\n`;
    if (body.length + line.length > 3400) break;
    body += line;
  }

  const text =
    `<blockquote><b>Transfer History</b>\n\n` +
    `<i>Last ${list.length} transfers</i></blockquote>\n\n` +
    body;

  const kb = {
    inline_keyboard: [[{ text: '🗑 Clear History', callback_data: 'hist_clear', style: 'danger' }]]
  };

  if (editMsgId) {
    await editMessage(chatId, editMsgId, text, env, kb);
  } else {
    await sendMessage(chatId, text, env, kb);
  }
}

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

async function cancelActiveJob(chatId, userId, jobId, env) {
  const jRaw = await env.SETTINGS_KV.get(`job:${jobId}`);
  if (!jRaw) {
    await sendMessage(chatId, `<i>Task <code>${escapeHtml(jobId)}</code> is no longer active.</i>`, env);
    return;
  }
  const job = JSON.parse(jRaw);
  if (String(job.userId) !== String(userId)) {
    await sendMessage(chatId, `<i>You can only cancel your own tasks.</i>`, env);
    return;
  }
  job.cancelled = true;
  job.status = 'cancelled';
  await env.SETTINGS_KV.put(`job:${jobId}`, JSON.stringify(job), { expirationTtl: 3600 });
  await removeActiveJobForUser(job.userId, jobId, env);

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

  await sendMessage(chatId, `Cancelling  ·  <code>${escapeHtml(jobId)}</code>`, env);
}

async function sendActiveTasks(chatId, userId, env) {
  const raw = await env.SETTINGS_KV.get(`active:${userId}`);
  const list = raw ? JSON.parse(raw) : [];
  const activeJobs = [];
  const keptIds = [];

  for (const jid of list) {
    const jr = await env.SETTINGS_KV.get(`job:${jid}`);
    if (!jr) continue;
    const j = JSON.parse(jr);
    if (j.cancelled || ['completed', 'cancelled', 'failed'].includes(j.status)) continue;
    keptIds.push(jid);
    activeJobs.push([jid, j]);
  }

  if (keptIds.length !== list.length) {
    await env.SETTINGS_KV.put(`active:${userId}`, JSON.stringify(keptIds), { expirationTtl: 25200 });
  }

  if (!activeJobs.length) {
    await sendMessage(chatId, `<blockquote><b>Active Tasks</b>\n\n<i>No transfers running right now.</i></blockquote>`, env);
    return;
  }

  for (const [jid, j] of activeJobs) {
    if (j.messageId) {
      await deleteMessage(chatId, j.messageId, env);
    }

    const name = escapeHtml(j.customName || j.detectedName || 'Task');
    const state = escapeHtml(j.status || 'starting');
    const userTag = j.username ? `@${escapeHtml(j.username)}` : `<code>${escapeHtml(String(j.userId || userId))}</code>`;
    const folder = escapeHtml(j.folderName || 'My Drive');

    const cardText = j.lastCardHtml || (
      `<code>${name}</code>\n\n` +
      `<b>Status  ·  ${state}</b>\n` +
      `<code>[░░░░░░░░░░░░░░░░░░░░]</code>  <b><code>0.0%</code></b>\n` +
      `Size  ·  <code>${fmtBytes(j.fileSize)}</code>\n` +
      `Dest  ·  <code>${folder}</code>\n` +
      `User  ·  ${userTag}  |  ID  ·  <code>${escapeHtml(String(j.userId || userId))}</code>\n` +
      `Stop  ·  /cancel_${jid}\n\n` +
      `<pre><code>SYSTEM\nLive card restored — awaiting next sync..</code></pre>`
    );

    const kb = {
      inline_keyboard: [[
        { text: '🔄 Refresh', callback_data: `st_ref:${jid}`, style: 'primary' },
        { text: '🔽 Close', callback_data: `st_close:${jid}`, style: 'danger' }
      ]]
    };

    const sent = await sendMessage(chatId, cardText, env, kb);
    if (sent?.result?.message_id) {
      j.messageId = String(sent.result.message_id);
      await env.SETTINGS_KV.put(`job:${jid}`, JSON.stringify(j), { expirationTtl: 25200 });
    }
  }
}

// ============================================================================
// MENUS, URL PARSING & LINK VERIFICATION
// ============================================================================

async function sendStartScreen(chatId, userId, username, env) {
  const profile = await getUserProfile(userId, env);
  if (!profile || !profile.refreshToken) {
    const authUrl = await createOAuthUrl(chatId, userId, username, env);
    const text =
      `<blockquote><b>Cloud Mirror Engine</b>\n\n` +
      `High-Speed On-Demand Google Drive Transfer</blockquote>\n\n` +
      `Bandwidth  ·  Up to <code>1.8 Gbps</code> (16x Aria2c)\n\n` +
      `Workspace  ·  <code>115 GiB</code> Dedicated Node\n\n` +
      `Features  ·  Direct URLs · Drive Copy · yt-dlp · Batch · Extract · ZIP\n\n` +
      `Telemetry  ·  <code>2.5s</code> Live Progress & System Stats\n\n` +
      `<i>Connect your Google Drive account below to begin:</i>`;
    await sendMessage(chatId, text, env, {
      inline_keyboard: [[{ text: '▸  Connect Google Drive', url: authUrl, style: 'primary' }]]
    });
    return;
  }

  const text =
    `<blockquote><b>Cloud Mirror Engine</b>\n\n` +
    `<code>${escapeHtml(profile.email)}</code></blockquote>\n\n` +
    `Upload Folder  ·  ${escapeHtml(profile.folderName || 'My Drive')}\n\n` +
    `Options Menu  ·  ${profile.buttonMode !== false ? 'Enabled' : 'Disabled'}\n\n` +
    `Auto Share  ·  ${profile.autoShare ? 'Enabled' : 'Disabled'}    Duplicate  ·  ${conflictLabel(profile.conflict || 'rename')}\n\n` +
    `<b>Commands</b>\n\n` +
    `<code>/m &lt;link&gt;</code> — Mirror URLs, Drive links, or send a <code>.txt</code> list\n\n` +
    `<code>/yt &lt;link&gt;</code> — Download videos / audio / playlists via yt-dlp\n\n` +
    `/setdldir — Browse & select target folder\n\n` +
    `/tasks — View active transfers\n\n` +
    `/history — Recent completed transfers\n\n` +
    `/settings — Preferences\n\n` +
    `/logout — Unlink Google Drive`;

  await sendMessage(chatId, text, env, {
    inline_keyboard: [
      [
        { text: 'Browse Folder', callback_data: 'cfg_dir', style: 'primary' },
        { text: `ButtonMode: ${profile.buttonMode !== false ? 'ON' : 'OFF'}`, callback_data: 'cfg_toggle_btn' }
      ]
    ]
  });
}

async function sendSettingsMenu(chatId, userId, profile, editMsgId, env) {
  const yq = ytQualityLabel(profile.ytQuality || 'best');
  const yc = ytContainerLabel(profile.ytContainer || 'mp4');
  const text =
    `<blockquote><b>Preferences</b>\n\n` +
    `<code>${escapeHtml(profile.email)}</code></blockquote>\n\n` +
    `Target Folder  ·  ${escapeHtml(profile.folderName || 'My Drive')}\n\n` +
    `ButtonMode  ·  ${profile.buttonMode !== false ? 'Enabled' : 'Disabled'}\n\n` +
    `Auto Share  ·  ${profile.autoShare ? 'Enabled (Anyone with link)' : 'Disabled'}\n\n` +
    `On Duplicate  ·  ${conflictLabel(profile.conflict || 'rename')}\n\n` +
    `Media (yt-dlp)  ·  <code>${yq} · ${yc}</code>`;
  const kb = {
    inline_keyboard: [
      [{ text: 'Browse / Change Folder', callback_data: 'cfg_dir', style: 'primary' }],
      [
        { text: `ButtonMode: ${profile.buttonMode !== false ? 'ON' : 'OFF'}`, callback_data: 'cfg_toggle_btn' },
        { text: `Auto Share: ${profile.autoShare ? 'ON' : 'OFF'}`, callback_data: 'cfg_toggle_share' }
      ],
      [
        { text: `Duplicate: ${conflictLabel(profile.conflict || 'rename')}`, callback_data: 'cfg_conf_menu' },
        { text: `🎬 Media: ${yq}`, callback_data: 'cfg_yt_menu' }
      ]
    ]
  };
  if (editMsgId) {
    await editMessage(chatId, editMsgId, text, env, kb);
  } else {
    await sendMessage(chatId, text, env, kb);
  }
}

function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/gi) || [];
  const seen = new Set();
  const out = [];
  for (let raw of matches) {
    raw = raw.replace(/[.,;!?)]+$/, '');
    if (raw && !seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
      if (out.length >= MAX_BATCH_URLS) break;
    }
  }
  return out;
}

function guessNameFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return seg ? decodeURIComponent(seg) : u.hostname;
  } catch (_) {
    return 'link';
  }
}

function parseDriveUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    if (!host.endsWith('drive.google.com') && !host.endsWith('docs.google.com') && host !== 'drive.usercontent.google.com') {
      return null;
    }
    const resourceKey = u.searchParams.get('resourcekey') || u.searchParams.get('resourceKey') || '';
    const folderMatch = u.pathname.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
    if (folderMatch) {
      return { id: folderMatch[1], resourceKey, isFolder: true };
    }
    const fileMatch = u.pathname.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
    if (fileMatch) {
      return { id: fileMatch[1], resourceKey, isFolder: false };
    }
    const idParam = u.searchParams.get('id');
    if (idParam && /^[a-zA-Z0-9_-]{10,}$/.test(idParam)) {
      return { id: idParam, resourceKey, isFolder: false };
    }
    return null;
  } catch (_) {
    return null;
  }
}

async function inspectDriveLink(info, accessToken) {
  try {
    const headers = { Authorization: `Bearer ${accessToken}` };
    if (info.resourceKey) {
      headers['X-Goog-Drive-Resource-Keys'] = `${info.id}/${info.resourceKey}`;
    }
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(info.id)}?fields=id,name,mimeType,size,webViewLink&supportsAllDrives=true`,
      { headers }
    );
    const data = await res.json();
    if (!res.ok || !data.id) {
      return { valid: false, reason: extractDriveApiError(data, 'Could not inspect Google Drive link') };
    }
    const isFolder = data.mimeType === FOLDER_MIME;
    return {
      valid: true,
      fileName: data.name || 'Drive Item',
      sizeBytes: data.size ? parseInt(data.size, 10) : 0,
      contentType: data.mimeType || 'application/octet-stream',
      acceptRanges: true,
      isFolder
    };
  } catch (err) {
    return { valid: false, reason: `Drive inspection error: ${err.message}` };
  }
}

const DIRECT_FILE_EXT_RE = /\.(zip|rar|7z|tar\.gz|tgz|tar\.bz2|tar\.xz|txz|mkv|mp4|avi|webm|mov|m4v|mp3|flac|m4a|ogg|wav|iso|img|apk|exe|msi|dmg|deb|rpm|appimage|pdf|epub|bin)(\?.*)?$/i;
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function rewriteKnownDirectUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');

    if (host === 'pixeldrain.com') {
      const fileM = u.pathname.match(/^\/u\/([a-zA-Z0-9_-]+)/);
      if (fileM) return { url: `https://pixeldrain.com/api/file/${fileM[1]}?download`, via: 'Pixeldrain' };
      const listM = u.pathname.match(/^\/l\/([a-zA-Z0-9_-]+)/);
      if (listM) return { url: `https://pixeldrain.com/api/list/${listM[1]}/zip`, via: 'Pixeldrain List' };
    }

    if (host === 'dropbox.com') {
      if (u.searchParams.get('dl') !== '1') {
        u.searchParams.set('dl', '1');
        return { url: u.toString(), via: 'Dropbox' };
      }
    }

    if (host === 'github.com') {
      const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
      if (m) {
        return { url: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`, via: 'GitHub Raw' };
      }
    }

    if (host === 'gitlab.com' && u.pathname.includes('/-/blob/')) {
      u.pathname = u.pathname.replace('/-/blob/', '/-/raw/');
      return { url: u.toString(), via: 'GitLab Raw' };
    }

    if (host === 'huggingface.co' && u.pathname.includes('/blob/')) {
      u.pathname = u.pathname.replace('/blob/', '/resolve/');
      return { url: u.toString(), via: 'Hugging Face' };
    }

    if (host === 'sourceforge.net') {
      const m = u.pathname.match(/^\/projects\/[^/]+\/files\/.+$/);
      if (m && !u.pathname.endsWith('/download') && !u.pathname.endsWith('/')) {
        u.pathname = u.pathname + '/download';
        return { url: u.toString(), via: 'SourceForge' };
      }
    }
  } catch (_) {}
  return null;
}

function detectChallengePage(headers, htmlText) {
  const cfMitigated = (headers?.get?.('cf-mitigated') || '').toLowerCase();
  if (cfMitigated === 'challenge') {
    return 'Protected by anti-bot verification. Open in your browser and send the direct file link.';
  }
  const low = (htmlText || '').slice(0, 60000).toLowerCase();
  if (
    low.includes('cf-turnstile') ||
    low.includes('challenges.cloudflare.com') ||
    low.includes('cdn-cgi/challenge-platform') ||
    low.includes('<title>just a moment...</title>') ||
    low.includes('g-recaptcha') ||
    low.includes('www.google.com/recaptcha') ||
    low.includes('h-captcha') ||
    low.includes('hcaptcha.com/1/api.js')
  ) {
    return 'Protected by CAPTCHA or anti-bot verification. Open in your browser and send the direct file link.';
  }
  return null;
}

function extractHtmlRedirect(htmlText, baseUrl) {
  const snippet = (htmlText || '').slice(0, 60000);
  const metaMatch = snippet.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url\s*=\s*([^"'\s>]+)/i) ||
    snippet.match(/<meta[^>]+content=["'][^"']*url\s*=\s*([^"'\s>]+)[^>]+http-equiv=["']?refresh["']?/i);
  if (metaMatch && metaMatch[1]) {
    try {
      const resolved = new URL(decodeHtmlEntities(metaMatch[1].trim()), baseUrl).toString();
      if (/^https?:\/\//i.test(resolved) && resolved !== baseUrl) return resolved;
    } catch (_) {}
  }

  const jsMatch = snippet.match(/(?:window\.location(?:\.href)?\s*=\s*|location\.replace\(\s*)["'](https?:\/\/[^"']+)["']/i);
  if (jsMatch && jsMatch[1]) {
    const resolved = decodeHtmlEntities(jsMatch[1].trim());
    if (resolved !== baseUrl) return resolved;
  }
  return null;
}

function extractAttr(tag, attrName) {
  const re = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  return m ? decodeHtmlEntities((m[1] ?? m[2] ?? m[3] ?? '').trim()) : '';
}

function extractHostDownloadCandidates(pageUrl, htmlText) {
  let host = '';
  let pathname = '';
  try {
    const u = new URL(pageUrl);
    host = u.hostname.toLowerCase().replace(/^www\./, '');
    pathname = u.pathname;
  } catch (_) {}

  if (host === 'mediafire.com' || host.endsWith('.mediafire.com')) {
    if (pathname.startsWith('/folder/')) {
      return { error: 'MediaFire folders are not supported as a single direct link.' };
    }
    const cands = [];
    const btnMatch = htmlText.match(/<a\b[^>]*\bid=["']downloadButton["'][^>]*>/i);
    if (btnMatch) {
      const href = extractAttr(btnMatch[0], 'href');
      if (/^https?:\/\//i.test(href)) {
        cands.push({ url: href, via: 'MediaFire', reExtractOnRunner: true });
      }
      const scrambled = extractAttr(btnMatch[0], 'data-scrambled-url');
      if (scrambled) {
        try {
          const decoded = atob(scrambled);
          if (/^https?:\/\//i.test(decoded)) {
            cands.push({ url: decoded, via: 'MediaFire', reExtractOnRunner: true });
          }
        } catch (_) {}
      }
    }
    if (cands.length) return { candidates: cands };
  }

  if (host === 'sourceforge.net') {
    const cands = [];
    const releaseMatch = htmlText.match(/data-release-url=["'](https?:\/\/[^"']+)["']/i);
    if (releaseMatch) {
      cands.push({ url: decodeHtmlEntities(releaseMatch[1]), via: 'SourceForge', reExtractOnRunner: true });
    }
    const dlLinkMatch = htmlText.match(/href=["'](https?:\/\/downloads\.sourceforge\.net\/[^"']+)["']/i);
    if (dlLinkMatch) {
      cands.push({ url: decodeHtmlEntities(dlLinkMatch[1]), via: 'SourceForge', reExtractOnRunner: true });
    }
    if (cands.length) return { candidates: cands };
  }

  if (host === 'onedrive.live.com' || host.endsWith('.sharepoint.com')) {
    try {
      const bytes = new TextEncoder().encode(pageUrl);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return {
        candidates: [{ url: `https://api.onedrive.com/v1.0/shares/u!${b64}/root/content`, via: 'OneDrive', reExtractOnRunner: false }]
      };
    } catch (_) {}
  }

  // Generic HTML download button / direct binary link extractor
  const scored = [];
  const seen = new Set();
  const anchorRe = /<a\b([^>]{1,600})>/gi;
  let m;
  while ((m = anchorRe.exec(htmlText)) !== null) {
    const attrs = m[1];
    const href = extractAttr(attrs, 'href');
    if (!href || href.startsWith('#') || /^(?:javascript|mailto|tel):/i.test(href)) continue;

    let absUrl;
    try {
      absUrl = new URL(href, pageUrl).toString();
    } catch (_) {
      continue;
    }
    if (!/^https?:\/\//i.test(absUrl) || absUrl === pageUrl || seen.has(absUrl)) continue;
    seen.add(absUrl);

    const idVal = extractAttr(attrs, 'id').toLowerCase();
    const clsVal = extractAttr(attrs, 'class').toLowerCase();
    const hasDownloadAttr = /\bdownload\b/i.test(attrs);
    let score = 0;
    if (hasDownloadAttr) score += 5;
    if (/(?:^|[\s_-])(download|dl-btn|dl_btn|download-btn|btn-download)(?:$|[\s_-])/i.test(`${idVal} ${clsVal}`)) score += 4;
    if (DIRECT_FILE_EXT_RE.test(absUrl)) score += 3;

    if (score >= 3) {
      scored.push({ url: absUrl, via: 'Page Extractor', reExtractOnRunner: false, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return { candidates: scored.slice(0, 3) };
}

function parseMetaFromResponse(res, fallbackUrl) {
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
    return { isHtml: true, contentType, contentDisp };
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
      const u = new URL(res.url || fallbackUrl);
      const seg = u.pathname.split('/').filter(Boolean).pop();
      if (seg && seg.length < 180) {
        fileName = decodeURIComponent(seg);
      }
    } catch (_) {}
  }

  return {
    isHtml: false,
    valid: true,
    fileName,
    sizeBytes,
    contentType,
    acceptRanges
  };
}

async function resolveAndInspectInput(rawUrl, accessToken) {
  let currentUrl = rawUrl;
  const visited = new Set();
  const viaChain = [];
  let fetches = 0;

  for (let hop = 0; hop < 10 && fetches < 14; hop++) {
    if (isMediaSiteUrl(currentUrl)) {
      return {
        kind: 'ytdl',
        finalUrl: currentUrl,
        resolvedVia: viaChain.join(' → ')
      };
    }

    const driveInfo = parseDriveUrl(currentUrl);
    if (driveInfo) {
      if (!accessToken) {
        return { kind: 'error', reason: 'Google Drive session expired. Run /login again.' };
      }
      const verification = await inspectDriveLink(driveInfo, accessToken);
      if (!verification.valid) {
        return { kind: 'error', reason: verification.reason };
      }
      return {
        kind: 'gdrive',
        driveInfo,
        verification,
        finalUrl: currentUrl,
        sourceUrl: '',
        resolvedVia: viaChain.join(' → ')
      };
    }

    const rewritten = rewriteKnownDirectUrl(currentUrl);
    if (rewritten && rewritten.url !== currentUrl && !visited.has(rewritten.url)) {
      visited.add(currentUrl);
      currentUrl = rewritten.url;
      if (!viaChain.includes(rewritten.via)) viaChain.push(rewritten.via);
      continue;
    }

    if (visited.has(currentUrl)) break;
    visited.add(currentUrl);

    let res;
    try {
      fetches++;
      res = await fetch(currentUrl, {
        method: 'HEAD',
        headers: { 'User-Agent': DEFAULT_UA },
        redirect: 'manual'
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (loc) {
          currentUrl = new URL(loc, currentUrl).toString();
          if (!viaChain.includes('Redirect')) viaChain.push('Redirect');
          continue;
        }
      }

      if (!res.ok || res.status === 405 || res.status === 403 || res.status === 501) {
        fetches++;
        const controller = new AbortController();
        res = await fetch(currentUrl, {
          method: 'GET',
          headers: { 'User-Agent': DEFAULT_UA, Range: 'bytes=0-0' },
          redirect: 'manual',
          signal: controller.signal
        });
        if (res.status >= 300 && res.status < 400) {
          controller.abort();
          const loc = res.headers.get('location');
          if (loc) {
            currentUrl = new URL(loc, currentUrl).toString();
            if (!viaChain.includes('Redirect')) viaChain.push('Redirect');
            continue;
          }
        }
        controller.abort();
      }
    } catch (err) {
      return { kind: 'error', reason: `Connection error: ${err.message}` };
    }

    const meta = parseMetaFromResponse(res, currentUrl);
    if (!meta.isHtml) {
      if (!res.ok && res.status !== 206) {
        return { kind: 'error', reason: `Remote server returned HTTP ${res.status}.` };
      }
      return {
        kind: 'url',
        verification: meta,
        finalUrl: currentUrl,
        sourceUrl: '',
        resolvedVia: viaChain.join(' → ')
      };
    }

    // Response is HTML — fetch page text to unwrap meta/JS redirects or extract host download link
    let htmlText = '';
    try {
      fetches++;
      const pageRes = await fetch(currentUrl, {
        method: 'GET',
        headers: { 'User-Agent': DEFAULT_UA, Accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow'
      });
      const finalPageUrl = pageRes.url || currentUrl;
      if (finalPageUrl !== currentUrl) {
        currentUrl = finalPageUrl;
        if (isMediaSiteUrl(currentUrl)) {
          return { kind: 'ytdl', finalUrl: currentUrl, resolvedVia: viaChain.join(' → ') };
        }
        const driveAfter = parseDriveUrl(currentUrl);
        if (driveAfter) continue;
      }
      htmlText = (await pageRes.text()).slice(0, 262144);
      const blocked = detectChallengePage(pageRes.headers, htmlText);
      if (blocked) {
        return { kind: 'error', reason: blocked };
      }
      if (!pageRes.ok) {
        let host = '';
        try { host = new URL(currentUrl).hostname.toLowerCase(); } catch {}
        if (host.endsWith('googleusercontent.com') && (pageRes.status === 400 || pageRes.status === 403 || pageRes.status === 410)) {
          return {
            kind: 'error',
            reason: `Google download server returned HTTP ${pageRes.status} (signed download URLs are IP/session-bound or expired; share the original Drive/source link instead).`
          };
        }
        return { kind: 'error', reason: `Remote server returned HTTP ${pageRes.status}.` };
      }
    } catch (err) {
      return { kind: 'error', reason: `Failed to inspect page: ${err.message}` };
    }

    const hostRes = extractHostDownloadCandidates(currentUrl, htmlText);
    if (hostRes.error) {
      return { kind: 'error', reason: hostRes.error };
    }
    if (hostRes.candidates && hostRes.candidates.length) {
      for (const cand of hostRes.candidates) {
        fetches++;
        const v = await verifyDirectLink(cand.url);
        if (v.valid) {
          const chain = [...viaChain, cand.via].filter(Boolean);
          return {
            kind: 'url',
            verification: v,
            finalUrl: cand.url,
            sourceUrl: cand.reExtractOnRunner ? currentUrl : '',
            resolvedVia: chain.join(' → ')
          };
        }
      }
    }

    const htmlRedir = extractHtmlRedirect(htmlText, currentUrl);
    if (htmlRedir && !visited.has(htmlRedir)) {
      currentUrl = htmlRedir;
      if (!viaChain.includes('Redirect')) viaChain.push('Redirect');
      continue;
    }

    return { kind: 'error', reason: 'URL points to an HTML webpage with no extractable direct file link.' };
  }

  return { kind: 'error', reason: 'Too many redirects while resolving link.' };
}

async function verifyDirectLink(url) {
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': DEFAULT_UA },
      redirect: 'follow'
    });

    if (!res.ok || res.status === 405 || res.status === 403 || res.status === 501) {
      const controller = new AbortController();
      res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': DEFAULT_UA, Range: 'bytes=0-0' },
        redirect: 'follow',
        signal: controller.signal
      });
      controller.abort();
    }

    if (!res.ok && res.status !== 206) {
      return { valid: false, reason: `HTTP ${res.status}` };
    }

    const meta = parseMetaFromResponse(res, url);
    if (meta.isHtml) {
      return { valid: false, reason: 'URL points to an HTML webpage rather than a direct file.' };
    }
    return meta;
  } catch (err) {
    return { valid: false, reason: `Connection error: ${err.message}` };
  }
}

// ============================================================================
// TELEGRAM & FORMATTING UTILITIES
// ============================================================================

async function postTelegramMessage(method, payload, env) {
  const endpoint = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data?.ok && payload.reply_markup?.inline_keyboard) {
    const hasStyle = payload.reply_markup.inline_keyboard.some(row => row.some(b => b && b.style));
    if (hasStyle) {
      const cleanPayload = {
        ...payload,
        reply_markup: {
          ...payload.reply_markup,
          inline_keyboard: payload.reply_markup.inline_keyboard.map(row =>
            row.map(({ style: _s, ...btn }) => btn)
          )
        }
      };
      const retryRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cleanPayload)
      });
      return await retryRes.json();
    }
  }
  return data;
}

async function sendMessage(chatId, text, env, replyMarkup = null, replyToMsgId = null) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (replyToMsgId) payload.reply_to_message_id = replyToMsgId;
  return await postTelegramMessage('sendMessage', payload, env);
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
  return await postTelegramMessage('editMessageText', payload, env);
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
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@400&family=Roboto:wght@300;400;500&display=swap" rel="stylesheet"><style>body{font-family:'Roboto',system-ui,-apple-system,sans-serif;font-weight:400;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}.card{background:#1e293b;padding:32px;border-radius:16px;max-width:420px;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.4)}h1{margin-top:0;color:#38bdf8;font-size:1.45rem;font-weight:500}p{color:#cbd5e1;line-height:1.75;font-weight:300}code{font-family:'Roboto Mono',monospace}</style></head><body><div class="card"><h1>${escapeHtml(title)}</h1><p>${bodyHtml}</p></div></body></html>`;
  return new Response(page, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
