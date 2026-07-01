const TG_API = 'https://api.telegram.org/bot';
const CF_API = 'https://api.cloudflare.com/client/v4';
const GITHUB_RAW = 'https://raw.githubusercontent.com/kouroshstatue-cloud/kouroh/main';
const PANEL_PREFIX = 'kourosh-asli';
const SUB_PATH = '/kouroshasli_panel';
const COMPAT_DATE = '2025-02-08';
const PORTS = {
  hamrah: [443, 2053, 2083, 8443, 2096],
  irancell: [8080, 80, 8880],
  rightel: [8080, 80, 8880],
  shatel: [443, 2053, 2083],
  adsl: [443, 2053, 2083]
};
const OP_NAMES = { hamrah: 'همراه اول', irancell: 'ایرانسل', rightel: 'رایتل + سامانتل', shatel: 'شاتل', adsl: 'ADSL' };
const SECT_NAMES = { hamrah: 'همراه اول', irancell: 'ایرانسل', rightel: 'رایتل/سامانتل', shatel: 'شاتل', adsl: 'ADSL' };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/webhook' && request.method === 'POST')
      return handleWebhook(request, env, ctx);
    if (url.pathname.startsWith('/sub/'))
      return handleSub(url, env);
    return new Response('@CFsazbot running', { status: 200 });
  }
};

async function handleWebhook(request, env, ctx) {
  try {
    const update = await request.json();
    ctx.waitUntil(processUpdate(update, env));
    return new Response('ok', { status: 200 });
  } catch { return new Response('ok', { status: 200 }); }
}

async function processUpdate(update, env) {
  if (update.callback_query) await handleCallback(update.callback_query, env);
  else if (update.message) await handleMessage(update.message, env);
}

async function tg(method, payload, env) {
  try {
    const r = await fetch(TG_API + env.TELEGRAM_BOT_TOKEN + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await r.json();
  } catch { return { ok: false }; }
}

async function send(chatId, text, extra, env) {
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra }, env);
}

async function edit(chatId, msgId, text, extra, env) {
  return tg('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'Markdown', ...extra }, env);
}

async function answerCb(id, text, env) {
  return tg('answerCallbackQuery', { callback_query_id: id, text }, env);
}

function btn(text, cb) { return { text, callback_data: cb }; }

function mainKeyboard() {
  return { inline_keyboard: [
    [btn('🚀 ساخت پنل جدید', 'new_panel')],
    [btn('📋 پنل‌های من', 'my_panels')],
    [btn('❓ راهنما', 'help')]
  ] };
}

function opKeyboard() {
  return { inline_keyboard: [
    [btn('📡 همراه اول', 'op:hamrah'), btn('📡 ایرانسل', 'op:irancell')],
    [btn('📡 رایتل + سامانتل', 'op:rightel'), btn('📡 شاتل', 'op:shatel')],
    [btn('📡 ADSL', 'op:adsl')],
    [btn('🔙 بازگشت', 'back_start')]
  ] };
}

async function getSession(chatId, env) {
  try { return await env.KV.get('sess:' + chatId, 'json') || { state: 'START', data: {} }; }
  catch { return { state: 'START', data: {} }; }
}

async function setSession(chatId, sess, env) {
  await env.KV.put('sess:' + chatId, JSON.stringify(sess), { expirationTtl: 86400 });
}

async function getUserToken(chatId, env) {
  try { return await env.KV.get('token:' + chatId, 'json'); } catch { return null; }
}

async function setUserToken(chatId, data, env) {
  await env.KV.put('token:' + chatId, JSON.stringify(data), { expirationTtl: 86400 * 30 });
}

async function getPanels(chatId, env) {
  try { return await env.KV.get('panels:' + chatId, 'json') || []; } catch { return []; }
}

async function setPanels(chatId, panels, env) {
  await env.KV.put('panels:' + chatId, JSON.stringify(panels), { expirationTtl: 86400 * 30 });
}

async function getQueue(env) {
  try { return await env.KV.get('queue', 'json') || { active: null, queue: [] }; }
  catch { return { active: null, queue: [] }; }
}

async function setQueue(q, env) {
  await env.KV.put('queue', JSON.stringify(q));
}

async function getHistory(chatId, env) {
  try { return await env.KV.get('hist:' + chatId, 'json') || { panels: [], totalPanelsCreated: 0, lastUsed: 0 }; }
  catch { return { panels: [], totalPanelsCreated: 0, lastUsed: 0 }; }
}

async function setHistory(chatId, h, env) {
  await env.KV.put('hist:' + chatId, JSON.stringify(h), { expirationTtl: 86400 * 90 });
}

async function getSub(id, env) {
  try { return await env.KV.get('sub:' + id, 'json'); } catch { return null; }
}

async function setSub(id, data, env) {
  await env.KV.put('sub:' + id, JSON.stringify(data), { expirationTtl: 86400 * 365 });
}

async function cfApi(path, token, opts = {}) {
  const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  const r = await fetch(CF_API + path, { headers, ...opts });
  const data = await r.json();
  if (!data.success) {
    const errMsg = data.errors && data.errors.length > 0 ? data.errors[0].message : 'Unknown error';
    throw new Error(errMsg);
  }
  return data;
}

async function validateToken(token) {
  const data = await cfApi('/accounts', token);
  if (!data.result || data.result.length === 0) throw new Error('اکانتی یافت نشد');
  return data.result[0].id;
}

async function ensureSubdomain(token, accountId) {
  try {
    const data = await cfApi('/accounts/' + accountId + '/workers/subdomain', token);
    if (data.result && data.result.subdomain) return data.result.subdomain;
  } catch {}
  const sub = 'kourosh-' + Math.random().toString(36).substring(2, 8);
  await cfApi('/accounts/' + accountId + '/workers/subdomain', token, {
    method: 'PUT', body: JSON.stringify({ subdomain: sub })
  });
  return sub;
}

async function createD1(token, accountId, name) {
  const data = await cfApi('/accounts/' + accountId + '/d1/database', token, {
    method: 'POST', body: JSON.stringify({ name })
  });
  return data.result.uuid;
}

async function deployWorker(token, accountId, name, code, dbUuid) {
  const metadata = {
    main_module: 'kourosh.js',
    compatibility_date: COMPAT_DATE,
    bindings: [
      { type: 'd1', name: 'DB', id: dbUuid },
      { type: 'secret_text', name: 'CF_API_TOKEN', text: token },
      { type: 'secret_text', name: 'CF_ACCOUNT_ID', text: accountId }
    ]
  };
  const formData = new FormData();
  formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  formData.append('kourosh.js', new Blob([code], { type: 'application/javascript+module' }), 'kourosh.js');
  const r = await fetch(CF_API + '/accounts/' + accountId + '/workers/scripts/' + name, {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + token },
    body: formData
  });
  const data = await r.json();
  if (!data.success) {
    const errMsg = data.errors && data.errors.length > 0 ? data.errors[0].message : 'Deploy failed';
    throw new Error(errMsg);
  }
}

async function enableSubdomain(token, accountId, name) {
  try {
    await cfApi('/accounts/' + accountId + '/workers/scripts/' + name + '/subdomain', token, {
      method: 'POST', body: JSON.stringify({ enabled: true })
    });
  } catch {}
}

async function d1InsertUser(token, accountId, dbUuid, username, uuid, ips, port, host) {
  const ipsStr = ips.join('\n');
  const portStr = port.join(',');
  const sql = 'INSERT INTO users (username, uuid, limit_gb, expiry_days, ips, connection_type, port, is_active, fingerprint, max_connections) VALUES ('
    + "'" + username + "', '" + uuid + "', 999999, 36500, '" + ipsStr + "', 'vless', '" + portStr + "', 1, 'chrome', 10)";
  await fetch(CF_API + '/accounts/' + accountId + '/d1/database/' + dbUuid + '/query', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql })
  });
}

function getWorkerName() {
  return PANEL_PREFIX + '-' + Math.random().toString(36).substring(2, 8);
}

function genUuid() {
  const hex = '0123456789abcdef';
  let r = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) r += '-';
    else r += hex[Math.floor(Math.random() * 16)];
  }
  return r;
}

async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const sess = await getSession(chatId, env);

  if (text === '/start') {
    await send(chatId,
      '🎯 *پنل کوروش اصلی*\n\n'
      + 'به ربات پنل‌ساز کوروش خوش آمدید.\n'
      + 'با این ربات می‌توانید پنل اختصاصی خود را روی اکانت کلودفلرتان بسازید.\n\n'
      + '👇 از دکمه‌های زیر استفاده کنید:', { reply_markup: mainKeyboard() }, env);
    sess.state = 'START'; sess.data = {};
    await setSession(chatId, sess, env);
    return;
  }

  if (sess.state === 'AWAIT_TOKEN') return handleTokenInput(chatId, text, sess, env);
  if (sess.state === 'AWAIT_IPS') return handleIpsInput(chatId, text, sess, env);
  await send(chatId, 'از دکمه‌های زیر استفاده کنید.', { reply_markup: mainKeyboard() }, env);
}

async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;
  const data = cb.data;
  const cbId = cb.id;
  const sess = await getSession(chatId, env);

  if (data === 'new_panel') { await answerCb(cbId, '', env); return cmdNewPanel(chatId, msgId, sess, env); }
  if (data === 'my_panels') { await answerCb(cbId, '', env); return cmdMyPanels(chatId, msgId, env); }
  if (data === 'help') { await answerCb(cbId, '', env); return cmdHelp(chatId, msgId, env); }
  if (data === 'back_start') { await answerCb(cbId, '', env); return cmdBackStart(chatId, msgId, sess, env); }
  if (data === 'retry_deploy') { await answerCb(cbId, '', env); return cmdRetryDeploy(chatId, msgId, sess, env); }
  if (data.startsWith('op:')) { await answerCb(cbId, '', env); return cmdSelectOp(chatId, msgId, data.slice(3), sess, env); }
  if (data.startsWith('use_default:')) { await answerCb(cbId, '', env); return cmdUseDefaultIps(chatId, msgId, data.slice(12), sess, env); }
  if (data.startsWith('sub:')) { await answerCb(cbId, '✅ لینک کپی شد', env); return cmdCopySub(chatId, msgId, data.slice(4), env); }
  if (data.startsWith('del:')) { await answerCb(cbId, '🗑 در حال حذف...', env); return cmdDeletePanel(chatId, msgId, data.slice(4), sess, env); }
  if (data.startsWith('new_op:')) { await answerCb(cbId, '', env); return cmdNewOp(chatId, msgId, data.slice(7), sess, env); }
}

async function cmdNewPanel(chatId, msgId, sess, env) {
  const tokenData = await getUserToken(chatId, env);
  if (tokenData && tokenData.token) {
    sess.state = 'AWAIT_OPERATOR'; sess.data = {};
    await setSession(chatId, sess, env);
    await edit(chatId, msgId, '📡 *اپراتور خود را انتخاب کنید:*', { reply_markup: opKeyboard() }, env);
  } else {
    sess.state = 'AWAIT_TOKEN'; sess.data = {};
    await setSession(chatId, sess, env);
    await edit(chatId, msgId,
      '🔑 *توکن API کلودفلر خود را ارسال کنید*\n\n'
      + 'برای ساخت توکن:\n👇\nhttps://dash.cloudflare.com/profile/api-tokens\n\n'
      + '*نیازمند دسترسی‌های:*\n• Workers: Edit\n• D1: Edit\n• Account Settings: Read',
      { reply_markup: { inline_keyboard: [[btn('🔙 بازگشت', 'back_start')]] } }, env);
  }
}

async function cmdMyPanels(chatId, msgId, env) {
  const panels = await getPanels(chatId, env);
  if (!panels || panels.length === 0) {
    await edit(chatId, msgId, '📋 *شما هیچ پنلی ندارید*\nبا دکمه ساخت پنل جدید شروع کنید.',
      { reply_markup: { inline_keyboard: [[btn('🚀 ساخت پنل جدید', 'new_panel')]] } }, env);
    return;
  }
  let text = '📋 *پنل‌های شما:*\n\n';
  const kb = [];
  for (const p of panels) {
    text += '▫️ *' + (p.label || p.name) + '* - ' + (p.operator || 'نامشخص') + '\n';
    text += '   وضعیت: ' + (p.active ? '✅ فعال' : '❌ غیرفعال') + '\n';
    text += '   ساخته شده: ' + new Date(p.createdAt).toLocaleDateString('fa-IR') + '\n\n';
    kb.push([btn('🗑 حذف', 'del:' + p.name)]);
  }
  kb.push([btn('🔙 بازگشت', 'back_start')]);
  await edit(chatId, msgId, text, { reply_markup: { inline_keyboard: kb } }, env);
}

async function cmdHelp(chatId, msgId, env) {
  await edit(chatId, msgId,
    '❓ *راهنمای ربات پنل کوروش*\n\n'
    + '۱. ابتدا یک توکن API از کلودفلر بسازید.\n'
    + '۲. توکن را برای ربات ارسال کنید.\n'
    + '۳. اپراتور و IPهای خود را انتخاب کنید.\n'
    + '۴. ربات پنل شما را می‌سازد.\n\n'
    + '🔗 کانال پشتیبانی: @kouroshasli',
    { reply_markup: { inline_keyboard: [[btn('🔙 بازگشت', 'back_start')]] } }, env);
}

async function cmdBackStart(chatId, msgId, sess, env) {
  sess.state = 'START'; sess.data = {};
  await setSession(chatId, sess, env);
  await edit(chatId, msgId, '🎯 *پنل کوروش اصلی*\n\nاز دکمه‌های زیر استفاده کنید:',
    { reply_markup: mainKeyboard() }, env);
}

async function cmdRetryDeploy(chatId, msgId, sess, env) {
  sess.state = 'AWAIT_OPERATOR'; sess.data = {};
  await setSession(chatId, sess, env);
  await edit(chatId, msgId, '📡 *اپراتور خود را انتخاب کنید:*', { reply_markup: opKeyboard() }, env);
}

async function handleTokenInput(chatId, text, sess, env) {
  const token = text.trim();
  if (!token || token.length < 10) {
    await send(chatId, '❌ توکن نامعتبر است. لطفاً یک توکن معتبر ارسال کنید.',
      { reply_markup: { inline_keyboard: [[btn('🔙 بازگشت', 'back_start')]] } }, env);
    return;
  }
  const statusMsg = await send(chatId, '⏳ در حال بررسی توکن...', {}, env);
  try {
    const accountId = await validateToken(token);
    await setUserToken(chatId, { token, accountId }, env);
    sess.state = 'AWAIT_OPERATOR'; sess.data = {};
    await setSession(chatId, sess, env);
    if (statusMsg.result && statusMsg.result.message_id)
      await edit(chatId, statusMsg.result.message_id, '✅ توکن معتبر است. اپراتور خود را انتخاب کنید:',
        { reply_markup: opKeyboard() }, env);
  } catch (e) {
    const err = e.message;
    let msg;
    if (err.includes('Authentication') || err.includes('Invalid'))
      msg = '❌ توکن نامعتبر است.\nلطفاً یک توکن معتبر از داشبورد کلودفلر بسازید.';
    else if (err.includes('اکانتی')) msg = '❌ ' + err;
    else msg = '❌ خطا: ' + err + '\n\nمجددا تلاش کنید.';
    if (statusMsg.result && statusMsg.result.message_id)
      await edit(chatId, statusMsg.result.message_id, msg,
        { reply_markup: { inline_keyboard: [[btn('🔄 تلاش مجدد', 'retry_deploy')], [btn('🔙 بازگشت', 'back_start')]] } }, env);
  }
}

async function cmdSelectOp(chatId, msgId, op, sess, env) {
  sess.state = 'AWAIT_IPS';
  sess.data.operator = op;
  await setSession(chatId, sess, env);
  const sectName = SECT_NAMES[op] || op;
  const defaultIps = await getDefaultIps(op, env);
  let text = '🌐 *IPهای ' + OP_NAMES[op] + '*\n\nلطفاً IPهای مورد نظر را وارد کنید (هر خط یک IP):\n\n';
  if (defaultIps.length > 0)
    text += '👇 *IPهای پیشنهادی:*\n`' + defaultIps.slice(0, 5).join('\n') + '`\n\n☝️ می‌توانید از همین‌ها استفاده کنید.';
  await edit(chatId, msgId, text,
    { reply_markup: { inline_keyboard: [[btn('📋 استفاده از IPهای پیشنهادی', 'use_default:' + op)], [btn('🔙 بازگشت', 'back_start')]] } }, env);
}

async function cmdUseDefaultIps(chatId, msgId, op, sess, env) {
  const defaultIps = await getDefaultIps(op, env);
  if (defaultIps.length === 0) {
    await edit(chatId, msgId, '❌ IP پیشفرضی یافت نشد. لطفاً IPها را دستی وارد کنید.',
      { reply_markup: { inline_keyboard: [[btn('🔙 بازگشت', 'back_start')]] } }, env);
    return;
  }
  sess.data.ips = defaultIps.slice(0, 10);
  sess.state = 'DEPLOYING';
  await setSession(chatId, sess, env);
  const statusMsg = await send(chatId, '⏳ در حال افزودن به صف ساخت...', {}, env);
  const newMsgId = statusMsg.result && statusMsg.result.message_id;
  await addToQueue(chatId, sess.data, newMsgId, env);
}

async function getDefaultIps(op, env) {
  try {
    const r = await fetch(GITHUB_RAW + '/ips.txt?t=' + Date.now());
    const text = await r.text();
    const lines = text.split('\n');
    const target = SECT_NAMES[op] || 'همراه اول';
    let inSection = false;
    const ips = [];
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('#') && t.includes(target)) { inSection = true; continue; }
      if (t.startsWith('#') && inSection) break;
      if (t === '---' && inSection) break;
      if (inSection && /^\d+\.\d+\.\d+\.\d+$/.test(t)) ips.push(t);
    }
    return shuffle(ips);
  } catch { return []; }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function handleIpsInput(chatId, text, sess, env) {
  const ips = text.split('\n').map(l => l.trim()).filter(l => /^\d+\.\d+\.\d+\.\d+$/.test(l));
  if (ips.length === 0) {
    await send(chatId, '❌ لطفاً IPهای معتبر وارد کنید (هر خط یک آدرس IPv4).',
      { reply_markup: { inline_keyboard: [[btn('🔙 بازگشت', 'back_start')]] } }, env);
    return;
  }
  sess.data.ips = ips;
  sess.state = 'DEPLOYING';
  await setSession(chatId, sess, env);
  const statusMsg = await send(chatId, '⏳ در حال افزودن به صف ساخت...', {}, env);
  const msgId = statusMsg.result && statusMsg.result.message_id;
  await addToQueue(chatId, sess.data, msgId, env);
}

async function addToQueue(chatId, data, msgId, env) {
  const q = await getQueue(env);
  const entry = { chatId, data, msgId, status: 'waiting', createdAt: Date.now() };
  q.queue.push(entry);
  await setQueue(q, env);
  await edit(chatId, msgId, '🔄 *شما در صف قرار گرفتید*\nموقعیت شما: ' + q.queue.length + '\n\nمنتظر بمانید...', {}, env);
  if (!q.active) processQueue(env);
}

async function processQueue(env) {
  const q = await getQueue(env);
  if (q.active || q.queue.length === 0) return;
  const entry = q.queue.shift();
  entry.status = 'processing';
  q.active = entry.chatId;
  await setQueue(q, env);
  await progress(entry.chatId, entry.msgId, '▫️ مرحله ۱: آماده‌سازی حساب', env);
  try {
    await runDeploy(entry, env);
    q.active = null;
    await setQueue(q, env);
    if (q.queue.length > 0) processQueue(env);
  } catch (e) {
    q.active = null;
    await setQueue(q, env);
    await edit(entry.chatId, entry.msgId, '❌ *خطا در ساخت پنل*\n\n' + e.message,
      { reply_markup: { inline_keyboard: [[btn('🔄 تلاش مجدد', 'retry_deploy')], [btn('🔙 بازگشت', 'back_start')]] } }, env);
    if (q.queue.length > 0) processQueue(env);
  }
}

async function runDeploy(entry, env) {
  const { chatId, data, msgId } = entry;
  const tokenData = await getUserToken(chatId, env);
  if (!tokenData) throw new Error('توکن یافت نشد. دوباره شروع کنید.');
  const { token } = tokenData;
  const { operator, ips, existingSubId } = data;
  const op = operator || 'hamrah';

  if (existingSubId) {
    const existing = await getSub(existingSubId, env);
    if (!existing) throw new Error('پنل قبلی یافت نشد');
    await progress(chatId, msgId, '▫️ افزودن اپراتور ' + OP_NAMES[op] + ' به پنل موجود', env);
    const uuid2 = genUuid();
    const username2 = 'u' + chatId + '_' + Math.random().toString(36).substring(2, 6);
    await d1InsertUser(token, existing.accountId, existing.dbUuid, username2, uuid2, ips, PORTS[op], existing.host);
    const subId2 = randomId(16);
    await setSub(subId2, {
      panelUrl: existing.panelUrl, workerName: existing.workerName,
      operator: op, ips, ports: PORTS[op],
      uuid: uuid2, username: username2, dbUuid: existing.dbUuid,
      accountId: existing.accountId, host: existing.host,
      createdAt: Date.now()
    }, env);
    const subUrl2 = (env.SUB_DOMAIN || 'https://cfsub.workers.dev') + '/sub/' + subId2;
    await edit(chatId, msgId,
      '✅ *اپراتور جدید اضافه شد!*\n\n'
      + '📡 اپراتور: ' + OP_NAMES[op] + '\n'
      + '🌐 تعداد IP: ' + ips.length + '\n'
      + '🔌 پورت‌ها: ' + PORTS[op].join(', ') + '\n\n'
      + '👇 *لینک اشتراک (Subscription):*\n'
      + '`' + subUrl2 + '`',
      { reply_markup: { inline_keyboard: [[btn('🔙 بازگشت', 'back_start')]] } }, env);
    return;
  }

  await progress(chatId, msgId, '▫️ مرحله ۲: بررسی ساب‌دامین', env);
  const subdomain = await ensureSubdomain(token, tokenData.accountId);

  await progress(chatId, msgId, '▫️ مرحله ۳: ساخت دیتابیس D1', env);
  const suffix = Math.random().toString(36).substring(2, 8);
  const dbName = PANEL_PREFIX + '-db-' + suffix;
  const dbUuid = await createD1(token, tokenData.accountId, dbName);

  await progress(chatId, msgId, '▫️ مرحله ۴: دریافت کد پنل', env);
  const r = await fetch(GITHUB_RAW + '/kourosh.js?t=' + Date.now());
  if (!r.ok) throw new Error('خطا در دریافت سورس از گیت‌هاب');
  let code = await r.text();

  await progress(chatId, msgId, '▫️ مرحله ۵: دیپلوی کردن', env);
  const workerName = getWorkerName();
  await deployWorker(token, tokenData.accountId, workerName, code, dbUuid);

  await progress(chatId, msgId, '▫️ مرحله ۶: فعالسازی آدرس', env);
  await enableSubdomain(token, tokenData.accountId, workerName);

  await progress(chatId, msgId, '▫️ مرحله ۷: ایجاد کاربر نامحدود', env);
  const uuid = genUuid();
  const username = 'u' + chatId + '_' + Math.random().toString(36).substring(2, 6);
  await d1InsertUser(token, tokenData.accountId, dbUuid, username, uuid, ips, PORTS[op], workerName + '.' + subdomain + '.workers.dev');

  await progress(chatId, msgId, '▫️ مرحله ۸: راه‌اندازی نهایی', env);
  const panelUrl = 'https://' + workerName + '.' + subdomain + '.workers.dev';
  for (let i = 0; i < 12; i++) {
    try {
      const res = await fetch(panelUrl);
      const body = await res.text();
      if (body.includes('kourosh') || body.includes('Kourosh')) break;
    } catch {}
    if (i < 11) await new Promise(r => setTimeout(r, 5000));
  }

  const subId = randomId(16);
  await setSub(subId, {
    panelUrl, workerName, operator: op, ips, ports: PORTS[op],
    uuid, username, dbUuid, accountId: tokenData.accountId, host: workerName + '.' + subdomain + '.workers.dev',
    createdAt: Date.now()
  }, env);

  const panels = await getPanels(chatId, env);
  panels.push({ name: workerName, label: 'پنل ' + OP_NAMES[op], operator: OP_NAMES[op], active: true, createdAt: Date.now() });
  await setPanels(chatId, panels, env);

  const hist = await getHistory(chatId, env);
  hist.panels.push({ name: workerName, createdAt: Date.now() });
  hist.totalPanelsCreated++;
  hist.lastUsed = Date.now();
  await setHistory(chatId, hist, env);

  const subUrl = (env.SUB_DOMAIN || 'https://cfsub.workers.dev') + '/sub/' + subId;
  await edit(chatId, msgId,
    '✅ *پنل شما ساخته شد!*\n\n'
    + '📡 اپراتور: ' + OP_NAMES[op] + '\n'
    + '🌐 تعداد IP: ' + ips.length + '\n'
    + '🔌 پورت‌ها: ' + PORTS[op].join(', ') + '\n\n'
    + '👇 *لینک اشتراک (Subscription):*\n'
    + '`' + subUrl + '`\n\n'
    + '⚠️ این لینک را در اپ v2rayNG / Nekobox / V2Box\n'
    + '   در بخش Subscription وارد کنید.',
    { reply_markup: { inline_keyboard: [
      [btn('📡 اپراتور دیگر', 'new_op:' + subId)],
      [btn('🔙 بازگشت', 'back_start')]
    ] } }, env);
}

async function progress(chatId, msgId, step, env) {
  await edit(chatId, msgId, '⚙️ *در حال ساخت پنل...*\n\n' + step, {}, env);
}

function randomId(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let r = '';
  for (let i = 0; i < len; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

async function cmdCopySub(chatId, msgId, subId, env) {
  const sub = await getSub(subId, env);
  if (!sub) return;
}

async function cmdNewOp(chatId, msgId, subId, sess, env) {
  const sub = await getSub(subId, env);
  if (!sub) {
    await edit(chatId, msgId, '❌ ساب یافت نشد', { reply_markup: { inline_keyboard: [[btn('🔙 بازگشت', 'back_start')]] } }, env);
    return;
  }
  const tokenData = await getUserToken(chatId, env);
  if (!tokenData) {
    await edit(chatId, msgId, '❌ توکن یافت نشد. دوباره شروع کنید.',
      { reply_markup: { inline_keyboard: [[btn('🔙 بازگشت', 'back_start')]] } }, env);
    return;
  }
  sess.state = 'AWAIT_OPERATOR';
  sess.data = { existingSubId: subId, existingPanelUrl: sub.panelUrl, existingWorkerName: sub.workerName, existingDbUuid: sub.dbUuid, existingAccountId: sub.accountId, existingUuid: sub.uuid, existingHost: sub.host };
  await setSession(chatId, sess, env);
  await edit(chatId, msgId, '📡 *اپراتور جدید را انتخاب کنید:*\n\nاپراتور دوم برای پنل فعلی ساخته می‌شود.',
    { reply_markup: opKeyboard() }, env);
}

// ── Subscription Proxy ──
async function handleSub(url, env) {
  const subId = url.pathname.slice(5);
  if (!subId) return new Response('Not Found', { status: 404 });
  const sub = await getSub(subId, env);
  if (!sub) return new Response('Not Found', { status: 404 });

  const ips = sub.ips || ['104.20.44.53'];
  const ports = sub.ports || [443];
  const host = sub.host || 'example.com';
  const uuid = sub.uuid || '00000000-0000-0000-0000-000000000000';
  const fp = 'chrome';
  const m1 = decodeURIComponent('%F0%9F%8F%9B%EF%B8%8F%20%D9%BE%D9%86%D9%84%20%DA%A9%D9%88%D8%B1%D9%88%D8%B4%20%D8%A7%D8%B5%D9%84%DB%8C%20-%20%D8%B1%D8%A7%DB%8C%DA%AF%D8%A7%D9%86%20%D9%88%20%D8%BA%DB%8C%D8%B1%D9%82%D8%A7%D8%A8%D9%84%20%D9%81%D8%B1%D9%88%D8%B4%20%F0%9F%8F%9B%EF%B8%8F');
  const m2 = decodeURIComponent('%F0%9F%A6%81%20%40KouroshPanel%20-%20%D8%A7%D8%B4%D8%AA%D8%B1%D8%A7%DA%A9%20%D8%B1%D8%A7%DB%8C%DA%AF%D8%A7%D9%86%20%F0%9F%A6%81');
  const lines = [];
  lines.push('vless://' + uuid + '@0.0.0.0:1?encryption=none&security=none&type=ws&host=' + host + '&path=%2Fkouroshasli_panel#' + encodeURIComponent(m1));
  lines.push('vless://' + uuid + '@0.0.0.0:1?encryption=none&security=none&type=ws&host=' + host + '&path=%2Fkouroshasli_panel#' + encodeURIComponent(m2));
  for (const ip of ips) {
    for (const p of ports) {
      const portStr = String(p);
      const isTls = [443, 2053, 2083, 2087, 2096, 8443].includes(parseInt(portStr));
      const tls = isTls ? 'tls' : 'none';
      const remark = (sub.operator || 'kourosh') + ' - ' + ip + ':' + portStr;
      lines.push('vless://' + uuid + '@' + ip + ':' + portStr
        + '?path=%2Fkouroshasli_panel&security=' + tls + '&encryption=none&host=' + host + '&fp=' + fp + '&type=ws&sni=' + host
        + '#' + encodeURIComponent(remark));
    }
  }
  const plainContent = '# Kourosh Asli Config\n# @kouroshasli\n' + lines.join('\n');
  const bytes = new TextEncoder().encode(plainContent);
  let r = '';
  for (let i = 0; i < bytes.length; i += 8192)
    r += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const b64 = btoa(r);
  return new Response(b64, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
