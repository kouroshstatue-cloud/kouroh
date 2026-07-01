import { connect } from 'cloudflare:sockets';

const GLOBAL_TRAFFIC_CACHE = new Map();
const ACTIVE_CONNECTIONS_COUNT = new Map();
const GLOBAL_LAST_ACTIVE_WRITE = new Map();
const GLOBAL_LAST_DB_WRITE = new Map();
const GLOBAL_WRITE_LOCK = new Map();
const DNS_CACHE = new Map();
const USER_REQ_CACHE = new Map();
const DNS_CACHE_TTL = 5 * 60 * 1000;
const DOH_RESOLVER = "https://cloudflare-dns.com/dns-query";
const UPSTREAM_BUNDLE_TARGET_BYTES = 16 * 1024;
const UPSTREAM_QUEUE_MAX_BYTES = 16 * 1024 * 1024;
const UPSTREAM_QUEUE_MAX_ITEMS = 4096;
const DOWNSTREAM_GRAIN_BYTES = 32 * 1024;
const DOWNSTREAM_GRAIN_TAIL_THRESHOLD = 512;
const DOWNSTREAM_GRAIN_SILENT_MS = 1;
const TCP_CONCURRENCY = 2;
const PRELOAD_RACE_DIAL = true;
const VLESS_PREFIX = atob('dmxlc3M6Ly8=');
const VLESS = atob('dmxlc3M=');
const TLS_PORTS = new Set(['443', '2053', '2083', '2087', '2096', '8443']);
const FRAG_CACHE_TTL = 300000;
let fragSettingsCache = { len: '20-30', int: '1-2', ts: 0 };
const P_VLESS = 'vle' + 'ss';
const P_VNEXT = 'vne' + 'xt';
const P_STREAM = 'stream' + 'Settings';
const P_WSSETTINGS = 'ws' + 'Settings';
const P_TLSSETTINGS = 'tls' + 'Settings';
const P_DIALERPROXY = 'dialer' + 'Proxy';

export default {
  async fetch(request, env, ctx) {
    await DbService.ensureSchema(env.DB);
    const url = new URL(request.url);

    if (Router.isWebSocketUpgrade(request) && url.pathname === '/kouroshasli_panel')
      return await Router.handleWebSocket(request, env, ctx);

    if (Router.isSubscriptionPath(url.pathname))
      return await Router.handleSubscription(url, env);

    return Response.redirect('https://t.me/kouroshasli', 302);
  }
};

const Router = {
  isWebSocketUpgrade(request) {
    return (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket';
  },

  isSubscriptionPath(pathname) {
    return pathname.startsWith('/sub/') || pathname.startsWith('/feed/');
  },

  async handleWebSocket(request, env, ctx) {
    try {
      let proxyIP = "proxyip.cmliussss.net";
      try {
        const proxyRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'proxy_ip'").first();
        if (proxyRow && proxyRow.value) proxyIP = proxyRow.value;
      } catch (e) {}
      return handleVLESS(env, { proxy_ip: proxyIP }, ctx);
    } catch (e) {
      return new Response("Internal Server Error", { status: 500 });
    }
  },

  async handleSubscription(url, env) {
    const isSubPath = url.pathname.startsWith('/sub/');
    const offset = isSubPath ? 5 : 6;
    let subUser = decodeURIComponent(url.pathname.slice(offset));
    const host = url.hostname;
    const isJson = !isSubPath && subUser.startsWith('json/');
    if (isJson) subUser = subUser.slice(5);

    try {
      const user = await env.DB.prepare("SELECT username, uuid, connection_type, used_gb, limit_gb, expiry_days, created_at, ips, port, fingerprint, limit_req, used_req, is_active, max_connections FROM users WHERE username = ? OR uuid = ?").bind(subUser, subUser).first();
      if (!user || user.connection_type !== VLESS)
        return new Response("Not Found", { status: 404 });

      const fmt = isJson ? 'json' : 'text';
      const cacheKey = 'sub_cache:' + user.uuid + ':' + fmt + ':' + host;
      const cached = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(cacheKey).first();
      if (cached && cached.value) {
        const sepIdx = cached.value.indexOf('||');
        if (sepIdx > 0) {
          const ts = parseInt(cached.value.substring(0, sepIdx), 10);
          if (!isNaN(ts) && Date.now() - ts < 3600000) {
            const body = cached.value.substring(sepIdx + 2);
            const downloadBytes = Math.floor((user.used_gb || 0) * 1073741824);
            const totalBytes = user.limit_gb ? Math.floor(user.limit_gb * 1073741824) : 0;
            let expireTimestamp = 0;
            if (user.expiry_days && user.created_at)
              expireTimestamp = Math.floor((new Date(user.created_at).getTime() + (user.expiry_days * 86400000)) / 1000);
            return new Response(body, {
              headers: {
                "Content-Type": isJson ? "application/json" : "text/plain; charset=utf-8",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-store",
                "Subscription-Userinfo": `upload=0; download=${downloadBytes}; total=${totalBytes}; expire=${expireTimestamp}`
              }
            });
          }
        }
      }

      const resp = isJson ? await SubscriptionService.generateJson(user, host, env) : await SubscriptionService.generateText(user, host);
      const respBody = await resp.clone().text();
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(cacheKey, Date.now() + '||' + respBody).run().catch(() => {});
      return resp;
    } catch (err) {
      return new Response("Error building config: " + err.message, { status: 500 });
    }
  }
};

let schemaEnsured = false;
const DbService = {
  async ensureSchema(db) {
    if (schemaEnsured) return;
    try {
      await db.prepare(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE,
          uuid TEXT,
          limit_gb REAL,
          expiry_days INTEGER,
          ips TEXT,
          connection_type TEXT,
          tls TEXT,
          port INTEGER,
          used_gb REAL DEFAULT 0,
          is_active INTEGER DEFAULT 1,
          last_active INTEGER,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `).run();
    } catch (e) {}
    try { await db.prepare("ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1").run(); } catch (e) {}
    try { await db.prepare("ALTER TABLE users ADD COLUMN last_active INTEGER").run(); } catch (e) {}
    try { await db.prepare("ALTER TABLE users ADD COLUMN fingerprint TEXT DEFAULT 'chrome'").run(); } catch (e) {}
    try { await db.prepare("ALTER TABLE users ADD COLUMN max_connections INTEGER").run(); } catch (e) {}
    try { await db.prepare("ALTER TABLE users ADD COLUMN limit_req INTEGER").run(); } catch (e) {}
    try { await db.prepare("ALTER TABLE users ADD COLUMN used_req INTEGER DEFAULT 0").run(); } catch (e) {}
    try { await db.prepare("ALTER TABLE users ADD COLUMN ip_limit INTEGER DEFAULT NULL").run(); } catch (e) {}
    try { await db.prepare("ALTER TABLE users ADD COLUMN active_ips TEXT DEFAULT NULL").run(); } catch (e) {}
    try { await db.prepare("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)").run(); } catch (e) {}
    schemaEnsured = true;
  }
};

function getActiveIpCount(activeIpsJson) {
  if (!activeIpsJson) return 0;
  try {
    const activeIps = JSON.parse(activeIpsJson);
    const now = Date.now();
    let count = 0;
    for (const [ip, data] of Object.entries(activeIps)) {
      const lastSeen = (data && typeof data === 'object') ? data.timestamp : data;
      if (now - lastSeen <= 30000) count++;
    }
    return count;
  } catch (e) { return 0; }
}

const SubscriptionService = {
  async generateJson(user, host, env) {
    let ips = [host];
    if (user.ips) {
      const parsedIps = user.ips.split('\n').map(ip => ip.trim()).filter(ip => ip.length > 0);
      if (parsedIps.length > 0) ips = parsedIps;
    }
    const ports = String(user.port || '443').split(',').map(p => p.trim()).filter(p => p.length > 0);
    const fp = user.fingerprint || 'chrome';
    let fragLen = fragSettingsCache.len;
    let fragInt = fragSettingsCache.int;
    if (Date.now() - fragSettingsCache.ts > FRAG_CACHE_TTL) {
      try {
        const rowLen = await env.DB.prepare("SELECT value FROM settings WHERE key = 'frag_len'").first();
        if (rowLen && rowLen.value) fragLen = rowLen.value;
        const rowInt = await env.DB.prepare("SELECT value FROM settings WHERE key = 'frag_int'").first();
        if (rowInt && rowInt.value) fragInt = rowInt.value;
        fragSettingsCache = { len: fragLen, int: fragInt, ts: Date.now() };
      } catch(e) {}
    }
    const m1 = decodeURIComponent('%F0%9F%8F%9B%EF%B8%8F%20%D9%BE%D9%86%D9%84%20%DA%A9%D9%88%D8%B1%D9%88%D8%B4%20%D8%A7%D8%B5%D9%84%DB%8C%20-%20%D8%B1%D8%A7%DB%8C%DA%AF%D8%A7%D9%86%20%D9%88%20%D8%BA%DB%8C%D8%B1%D9%82%D8%A7%D8%A8%D9%84%20%D9%81%D8%B1%D9%88%D8%B4%20%F0%9F%8F%9B%EF%B8%8F');
    const m2 = decodeURIComponent('%F0%9F%A6%81%20%40kouroshasli%20-%20%D8%A7%D8%B4%D8%AA%D8%B1%D8%A7%DA%A9%20%D8%B1%D8%A7%DB%8C%DA%AF%D8%A7%D9%86%20%F0%9F%A6%81');
    const staticHeader = ',"version":{"min":"25.10.15"},"log":{"loglevel":"none"},';
    const dnsPart = JSON.stringify({ servers: [
      { address: "https://8.8.8.8/dns-query", tag: "remote-dns" },
      { address: "8.8.8.8", domains: ["full:" + host], skipFallback: true }
    ], queryStrategy: "UseIP", tag: "dns" });
    const inboundsPart = JSON.stringify([{ listen: "127.0.0.1", port: 10808, protocol: "socks", settings: { auth: "noauth", udp: true }, sniffing: { destOverride: ["http", "tls"], enabled: true, routeOnly: true }, tag: "mixed-in" }, { listen: "127.0.0.1", port: 10853, protocol: "dokodemo-door", settings: { address: "1.1.1.1", network: "tcp,udp", port: 53 }, tag: "dns-in" }]);
    const routingPart = JSON.stringify({ domainStrategy: "IPIfNonMatch", rules: [
      { inboundTag: ["mixed-in"], port: 53, outboundTag: "dns-out", type: "field" },
      { inboundTag: ["dns-in"], outboundTag: "dns-out", type: "field" },
      { inboundTag: ["remote-dns"], outboundTag: "proxy", type: "field" },
      { inboundTag: ["dns"], outboundTag: "direct", type: "field" },
      { domain: ["geosite:private"], outboundTag: "direct", type: "field" },
      { ip: ["geoip:private"], outboundTag: "direct", type: "field" },
      { network: "udp", outboundTag: "block", type: "field" },
      { network: "tcp", outboundTag: "proxy", type: "field" }
    ] });
    const commonTrailer = ',"inbounds":' + inboundsPart + ',"routing":' + routingPart + '}';
    const staticOutboundsTail = JSON.stringify({ protocol: "dns", settings: { nonIPQuery: "reject" }, tag: "dns-out" }) + ',' + JSON.stringify({ protocol: "freedom", settings: { domainStrategy: "UseIP" }, tag: "direct" }) + ',' + JSON.stringify({ protocol: "blackhole", settings: { response: { type: "http" } }, tag: "block" });
    const fakeProxyPart = JSON.stringify({ protocol: P_VLESS, settings: { [P_VNEXT]: [{ address: "0.0.0.0", port: 1, users: [{ id: user.uuid, encryption: "none" }] }] }, [P_STREAM]: { network: "ws", [P_WSSETTINGS]: { host: host, path: "/kouroshasli_panel" }, security: "none" }, tag: "proxy" });
    const parts = [];
    const makeObj = (remark, outboundsJson) => '{"remarks":' + JSON.stringify(remark) + staticHeader + '"dns":' + dnsPart + ',"outbounds":' + outboundsJson + commonTrailer;
    parts.push(makeObj(m1, '[' + fakeProxyPart + ',' + staticOutboundsTail + ']'));
    parts.push(makeObj(m2, '[' + fakeProxyPart + ',' + staticOutboundsTail + ']'));
    const fragPart = JSON.stringify({ protocol: "freedom", settings: { fragment: { packets: "tlshello", length: fragLen, interval: fragInt } }, [P_STREAM]: { sockopt: { domainStrategy: "UseIP", happyEyeballs: { tryDelayMs: 250, prioritizeIPv6: false, interleave: 2, maxConcurrentTry: 4 } } }, tag: "fragment" });
    ips.forEach((ip) => {
      ports.forEach((portStr) => {
        const isTlsPort = TLS_PORTS.has(portStr);
        const tlsVal = isTlsPort ? 'tls' : 'none';
        const remark = user.username + ' ● ' + ip + ' ║ ' + portStr;
        const proxyObj = { protocol: P_VLESS, settings: { [P_VNEXT]: [{ address: ip, port: parseInt(portStr), users: [{ id: user.uuid, encryption: "none" }] }] }, [P_STREAM]: { network: "ws", [P_WSSETTINGS]: { host: host, path: "/kouroshasli_panel" }, security: tlsVal, sockopt: { [P_DIALERPROXY]: "fragment" } }, tag: "proxy" };
        if (tlsVal === 'tls')
          proxyObj[P_STREAM][P_TLSSETTINGS] = { serverName: host, fingerprint: fp, alpn: ["http/1.1"], allowInsecure: false };
        parts.push(makeObj(remark, '[' + JSON.stringify(proxyObj) + ',' + fragPart + ',' + staticOutboundsTail + ']'));
      });
    });
    const configJson = '[' + parts.join(',') + ']';
    const downloadBytes = Math.floor((user.used_gb || 0) * 1073741824);
    const totalBytes = user.limit_gb ? Math.floor(user.limit_gb * 1073741824) : 0;
    let expireTimestamp = 0;
    if (user.expiry_days && user.created_at)
      expireTimestamp = Math.floor((new Date(user.created_at).getTime() + (user.expiry_days * 86400000)) / 1000);
    return new Response(configJson, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Subscription-Userinfo": `upload=0; download=${downloadBytes}; total=${totalBytes}; expire=${expireTimestamp}`
      }
    });
  },

  async generateText(user, host) {
    let ips = [host];
    if (user.ips) {
      const parsedIps = user.ips.split('\n').map(ip => ip.trim()).filter(ip => ip.length > 0);
      if (parsedIps.length > 0) ips = parsedIps;
    }
    const ports = String(user.port || '443').split(',').map(p => p.trim()).filter(p => p.length > 0);
    const fp = user.fingerprint || 'chrome';
    const links = [];
    const m1 = decodeURIComponent('%F0%9F%8F%9B%EF%B8%8F%20%D9%BE%D9%86%D9%84%20%DA%A9%D9%88%D8%B1%D9%88%D8%B4%20%D8%A7%D8%B5%D9%84%DB%8C%20-%20%D8%B1%D8%A7%DB%8C%DA%AF%D8%A7%D9%86%20%D9%88%20%D8%BA%DB%8C%D8%B1%D9%82%D8%A7%D8%A8%D9%84%20%D9%81%D8%B1%D9%88%D8%B4%20%F0%9F%8F%9B%EF%B8%8F');
    const m2 = decodeURIComponent('%F0%9F%A6%81%20%40KouroshPanel%20-%20%D8%A7%D8%B4%D8%AA%D8%B1%D8%A7%DA%A9%20%D8%B1%D8%A7%DB%8C%DA%AF%D8%A7%D9%86%20%F0%9F%A6%81');
    links.push(VLESS_PREFIX + user.uuid + '@0.0.0.0:1?encryption=none&security=none&type=ws&host=' + host + '&path=%2Fkouroshasli_panel#' + encodeURIComponent(m1));
    links.push(VLESS_PREFIX + user.uuid + '@0.0.0.0:1?encryption=none&security=none&type=ws&host=' + host + '&path=%2Fkouroshasli_panel#' + encodeURIComponent(m2));
    ips.forEach((ip) => {
      ports.forEach((portStr) => {
        const isTlsPort = TLS_PORTS.has(portStr);
        const tlsVal = isTlsPort ? 'tls' : 'none';
        const remark = user.username + ' ● ' + ip + ' ║ ' + portStr;
        links.push(VLESS_PREFIX + user.uuid + '@' + ip + ':' + portStr + '?path=%2Fkouroshasli_panel&security=' + tlsVal + '&encryption=none&insecure=0&host=' + host + '&fp=' + fp + '&type=ws&allowInsecure=0&sni=' + host + '#' + encodeURIComponent(remark));
      });
    });
    const noise = [
      "# Kourosh Asli Panel Config",
      "# Node: " + Math.random().toString(36).slice(2, 10),
      "# Version: 2.0.0",
      "# Protocol: Secure VLESS+WS",
      ""
    ].join('\n');
    const plainContent = noise + links.join('\n');
    const subContent = (() => {
      const bytes = new TextEncoder().encode(plainContent);
      let r = '';
      for (let i = 0; i < bytes.length; i += 8192)
        r += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return btoa(r);
    })();
    const downloadBytes = Math.floor((user.used_gb || 0) * 1073741824);
    const totalBytes = user.limit_gb ? Math.floor(user.limit_gb * 1073741824) : 0;
    let expireTimestamp = 0;
    if (user.expiry_days && user.created_at)
      expireTimestamp = Math.floor((new Date(user.created_at).getTime() + (user.expiry_days * 86400000)) / 1000);
    return new Response(subContent, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Subscription-Userinfo": `upload=0; download=${downloadBytes}; total=${totalBytes}; expire=${expireTimestamp}`
      }
    });
  }
};

async function flushExpiredTraffic(env) {
  const now = Date.now();
  for (const [uname, cachedBytes] of GLOBAL_TRAFFIC_CACHE.entries()) {
    const cachedReqs = USER_REQ_CACHE.get(uname) || 0;
    if (cachedBytes <= 0 && cachedReqs <= 0) continue;
    if (GLOBAL_WRITE_LOCK.get(uname)) continue;
    const lastActive = GLOBAL_LAST_ACTIVE_WRITE.get(uname) || 0;
    const activeCount = ACTIVE_CONNECTIONS_COUNT.get(uname) || 0;
    if (activeCount <= 0 || (now - lastActive > 65000)) {
      GLOBAL_WRITE_LOCK.set(uname, true);
      GLOBAL_TRAFFIC_CACHE.set(uname, 0);
      USER_REQ_CACHE.set(uname, 0);
      const deltaGb = cachedBytes / (1024 * 1024 * 1024);
      try {
        await env.DB.prepare("UPDATE users SET used_gb = used_gb + ?, used_req = used_req + ? WHERE username = ?").bind(deltaGb, cachedReqs, uname).run();
      } catch (e) {
      } finally {
        GLOBAL_WRITE_LOCK.set(uname, false);
      }
    }
  }
}

async function handleVLESS(env, storedData = null, ctx = null) {
  const socketPair = new WebSocketPair();
  const [clientSock, serverSock] = Object.values(socketPair);
  serverSock.accept();
  serverSock.binaryType = 'arraybuffer';
  let username = null;
  let tickCount = 0;
  let validUUID = null;

  function addBytes(bytes) {
    if (bytes <= 0 || !username) return;
    let current = GLOBAL_TRAFFIC_CACHE.get(username) || 0;
    GLOBAL_TRAFFIC_CACHE.set(username, current + bytes);
    GLOBAL_LAST_ACTIVE_WRITE.set(username, Date.now());
    if (GLOBAL_WRITE_LOCK.get(username)) return;
    let lastDbWrite = GLOBAL_LAST_DB_WRITE.get(username) || 0;
    let now = Date.now();
    let thresholdBytes = 10 * 1024 * 1024;
    if (current >= thresholdBytes || (current > 0 && now - lastDbWrite > 60000)) {
      GLOBAL_WRITE_LOCK.set(username, true);
      let toCommit = GLOBAL_TRAFFIC_CACHE.get(username) || 0;
      let toCommitReq = USER_REQ_CACHE.get(username) || 0;
      if (toCommit <= 0 && toCommitReq <= 0) {
        GLOBAL_WRITE_LOCK.set(username, false);
        return;
      }
      GLOBAL_TRAFFIC_CACHE.set(username, 0);
      USER_REQ_CACHE.set(username, 0);
      GLOBAL_LAST_DB_WRITE.set(username, now);
      let deltaGb = toCommit / (1024 * 1024 * 1024);
      let writeTask = async () => {
        try {
          await env.DB.prepare("UPDATE users SET used_gb = used_gb + ?, used_req = used_req + ? WHERE username = ?").bind(deltaGb, toCommitReq, username).run();
        } catch (e) {
        } finally {
          GLOBAL_WRITE_LOCK.set(username, false);
        }
      };
      if (ctx) ctx.waitUntil(writeTask());
      else writeTask();
    }
  }

  let isOfflineSet = false;
  const setOffline = () => {
    if (isOfflineSet) return;
    isOfflineSet = true;
    const uname = username;
    if (!uname) return;
    let activeCount = ACTIVE_CONNECTIONS_COUNT.get(uname) || 1;
    activeCount = activeCount - 1;
    if (activeCount <= 0) {
      ACTIVE_CONNECTIONS_COUNT.delete(uname);
      let cachedBytes = GLOBAL_TRAFFIC_CACHE.get(uname) || 0;
      let cachedReqs = USER_REQ_CACHE.get(uname) || 0;
      if ((cachedBytes > 0 || cachedReqs > 0) && !GLOBAL_WRITE_LOCK.get(uname)) {
        GLOBAL_WRITE_LOCK.set(uname, true);
        GLOBAL_TRAFFIC_CACHE.set(uname, 0);
        USER_REQ_CACHE.set(uname, 0);
        const deltaGb = cachedBytes / (1024 * 1024 * 1024);
        const writeTask = async () => {
          try {
            await env.DB.prepare("UPDATE users SET used_gb = used_gb + ?, used_req = used_req + ? WHERE username = ?").bind(deltaGb, cachedReqs, uname).run();
          } catch (e) {
          } finally {
            GLOBAL_WRITE_LOCK.set(uname, false);
          }
        };
        if (ctx) ctx.waitUntil(writeTask());
        else writeTask();
      }
    } else {
      ACTIVE_CONNECTIONS_COUNT.set(uname, activeCount);
    }
  };

  let cachedUserStatus = null;
  const heartbeat = setInterval(async () => {
    if (serverSock.readyState === WebSocket.OPEN) {
      try {
        serverSock.send(new Uint8Array(0));
        if (!validUUID) return;
        tickCount++;
        if (tickCount >= 4) {
          tickCount = 0;
          const user = await env.DB.prepare("SELECT is_active, limit_gb, used_gb, limit_req, used_req, expiry_days, created_at, ip_limit, active_ips FROM users WHERE uuid = ?").bind(validUUID).first();
          cachedUserStatus = user;
          let isExpired = false;
          let isIpLimitExpired = false;
          let updatedActiveIps = null;
          if (!user || user.is_active === 0) {
            isExpired = true;
          } else {
            if (user.limit_gb && user.used_gb >= user.limit_gb) isExpired = true;
            if (user.limit_req && (user.used_req + (USER_REQ_CACHE.get(username) || 0)) >= user.limit_req) isExpired = true;
            if (user.expiry_days && user.created_at) {
              const created = new Date(user.created_at);
              const expiryDate = new Date(created.getTime() + (user.expiry_days * 24 * 60 * 60 * 1000));
              if (new Date() > expiryDate) isExpired = true;
            }
            const clientIP = "unknown";
            if (!isExpired) {
              let activeIps = {};
              try { activeIps = JSON.parse(user.active_ips || '{}'); } catch (e) {}
              const nowTime = Date.now();
              let hasChanges = false;
              for (const [ip, data] of Object.entries(activeIps)) {
                const lastSeen = (data && typeof data === 'object') ? data.timestamp : data;
                if (nowTime - lastSeen > 30000) { delete activeIps[ip]; hasChanges = true; }
              }
              if (hasChanges) updatedActiveIps = JSON.stringify(activeIps);
            }
          }
          if (isExpired) {
            await env.DB.prepare("UPDATE users SET is_active = 0, last_active = 0 WHERE uuid = ?").bind(validUUID).run();
            clearInterval(heartbeat);
            closeSocketQuietly(serverSock);
            return;
          }
          const now = Date.now();
          const lastRecorded = GLOBAL_LAST_ACTIVE_WRITE.get(username) || 0;
          if (now - lastRecorded > 60000 || updatedActiveIps !== null) {
            GLOBAL_LAST_ACTIVE_WRITE.set(username, now);
            if (updatedActiveIps !== null)
              await env.DB.prepare("UPDATE users SET last_active = ?, active_ips = ? WHERE username = ?").bind(now, updatedActiveIps, username).run();
            else
              await env.DB.prepare("UPDATE users SET last_active = ? WHERE username = ?").bind(now, username).run();
          }
        }
      } catch (e) {}
    } else {
      clearInterval(heartbeat);
    }
  }, 15000);

  let remoteConnWrapper = { socket: null, connectingPromise: null, retryConnect: null };
  let reqUUID = null;
  let isHeaderParsed = false;
  let isDnsQuery = false;
  let chunkBuffer = new Uint8Array(0);
  const proxyIP = storedData?.proxy_ip || "proxyip.cmliussss.net";

  let wsChain = Promise.resolve();
  let wsStopped = false, wsFailed = false, wsFinished = false;
  let wsQueueBytes = 0, wsQueueItems = 0;
  let currentSocketWriter = null, activeRemoteWriter = null;

  const releaseRemoteWriter = () => {
    if (activeRemoteWriter) {
      try { activeRemoteWriter.releaseLock(); } catch (e) {}
      activeRemoteWriter = null;
    }
    currentSocketWriter = null;
  };

  const getRemoteWriter = () => {
    const s = remoteConnWrapper.socket;
    if (!s) return null;
    if (s !== currentSocketWriter) {
      releaseRemoteWriter();
      currentSocketWriter = s;
      activeRemoteWriter = s.writable.getWriter();
    }
    return activeRemoteWriter;
  };

  const upstreamQueue = createUpstreamQueue({
    getWriter: getRemoteWriter,
    releaseWriter: releaseRemoteWriter,
    retryConnect: async () => {
      if (typeof remoteConnWrapper.retryConnect === 'function')
        await remoteConnWrapper.retryConnect();
    },
    closeConnection: () => {
      try { remoteConnWrapper.socket?.close(); } catch (e) {}
      closeSocketQuietly(serverSock);
    },
    name: 'VlessWSQueue'
  });

  const writeToRemote = async (chunk, allowRetry = true) => {
    return upstreamQueue.writeAndAwait(chunk, allowRetry);
  };

  const processWsMessage = async (chunk) => {
    const bytes = chunk.byteLength || 0;
    await addBytes(bytes);
    if (isDnsQuery) {
      await forwardVlessUDP(chunk, serverSock, null, addBytes);
      return;
    }
    if (await writeToRemote(chunk)) return;
    if (!isHeaderParsed) {
      chunkBuffer = concatBytes(chunkBuffer, chunk);
      if (chunkBuffer.byteLength < 24) return;
      reqUUID = extractUUIDFromVless(chunkBuffer);
      if (!reqUUID) { serverSock.close(); return; }
      let user = null;
      try {
        user = await env.DB.prepare("SELECT uuid, is_active, limit_gb, used_gb, limit_req, used_req, expiry_days, created_at, username, max_connections, ip_limit, active_ips FROM users WHERE uuid = ?").bind(reqUUID).first();
      } catch (e) {}
      if (!user || user.is_active === 0) { serverSock.close(); return; }
      if (user.limit_gb && user.used_gb >= user.limit_gb) { serverSock.close(); return; }
      if (user.limit_req && (user.used_req + (USER_REQ_CACHE.get(user.username) || 0)) >= user.limit_req) { serverSock.close(); return; }
      if (user.expiry_days && user.created_at) {
        const created = new Date(user.created_at);
        const expiryDate = new Date(created.getTime() + (user.expiry_days * 24 * 60 * 60 * 1000));
        if (new Date() > expiryDate) {
          try { await env.DB.prepare("UPDATE users SET is_active = 0, last_active = 0 WHERE uuid = ?").bind(reqUUID).run(); } catch (e) {}
          serverSock.close(); return;
        }
      }
      validUUID = reqUUID;
      username = user.username;
      isHeaderParsed = true;
      let currentReqs = USER_REQ_CACHE.get(username) || 0;
      USER_REQ_CACHE.set(username, currentReqs + 1);
      let activeCount = ACTIVE_CONNECTIONS_COUNT.get(username) || 0;
      if (user.max_connections && user.max_connections > 0 && activeCount >= user.max_connections) { serverSock.close(); return; }
      ACTIVE_CONNECTIONS_COUNT.set(username, activeCount + 1);
      if (activeCount === 0) {
        const setOnlineTask = async () => {
          try {
            const now = Date.now();
            GLOBAL_LAST_ACTIVE_WRITE.set(username, now);
            await env.DB.prepare("UPDATE users SET last_active = ? WHERE username = ?").bind(now, username).run();
          } catch (e) {}
        };
        if (ctx) ctx.waitUntil(setOnlineTask());
        else setOnlineTask();
      }
      try {
        let offset = 17;
        const optLen = chunkBuffer[offset++];
        offset += optLen;
        const cmd = chunkBuffer[offset++];
        const port = (chunkBuffer[offset++] << 8) | chunkBuffer[offset++];
        const addrType = chunkBuffer[offset++];
        let addr = '';
        if (addrType === 1) {
          addr = `${chunkBuffer[offset++]}.${chunkBuffer[offset++]}.${chunkBuffer[offset++]}.${chunkBuffer[offset++]}`;
        } else if (addrType === 2) {
          const domainLen = chunkBuffer[offset++];
          addr = new TextDecoder().decode(chunkBuffer.slice(offset, offset + domainLen));
          offset += domainLen;
        } else if (addrType === 3) {
          offset += 16;
          addr = "ipv6-unsupported";
        }
        const rawData = chunkBuffer.slice(offset);
        const respHeader = new Uint8Array([chunkBuffer[0], 0]);
        if (cmd === 2) {
          if (port === 53) { isDnsQuery = true; await forwardVlessUDP(rawData, serverSock, respHeader, addBytes); }
          else serverSock.close();
          return;
        }
        const connectTCP = async (dataPayload = null, useFallback = true) => {
          if (remoteConnWrapper.connectingPromise) { await remoteConnWrapper.connectingPromise; return; }
          const task = (async () => {
            let s = null;
            try { s = await connectDirect(addr, port, dataPayload); }
            catch (err) {
              if (useFallback && proxyIP) s = await connectDirect(proxyIP, port, dataPayload);
              else throw err;
            }
            remoteConnWrapper.socket = s;
            s.closed.catch(() => {}).finally(() => closeSocketQuietly(serverSock));
            connectStreams(s, serverSock, respHeader, null, (b) => { addBytes(b); });
          })();
          remoteConnWrapper.connectingPromise = task;
          try { await task; }
          finally { if (remoteConnWrapper.connectingPromise === task) remoteConnWrapper.connectingPromise = null; }
        };
        remoteConnWrapper.retryConnect = async () => connectTCP(null, false);
        await connectTCP(rawData, true);
      } catch (e) { serverSock.close(); }
    }
  };

  const handleWsError = (err) => {
    if (wsFailed) return;
    wsFailed = true; wsStopped = true; wsQueueBytes = 0; wsQueueItems = 0;
    upstreamQueue.clear(); releaseRemoteWriter(); closeSocketQuietly(serverSock); setOffline();
  };

  const pushToChain = (task) => { wsChain = wsChain.then(task).catch(handleWsError); };

  serverSock.addEventListener('message', (event) => {
    if (wsStopped || wsFailed) return;
    const size = event.data.byteLength || 0;
    const nextBytes = wsQueueBytes + size;
    const nextItems = wsQueueItems + 1;
    if (nextBytes > UPSTREAM_QUEUE_MAX_BYTES || nextItems > UPSTREAM_QUEUE_MAX_ITEMS) { handleWsError(new Error('ws queue overflow')); return; }
    wsQueueBytes = nextBytes; wsQueueItems = nextItems;
    pushToChain(async () => {
      wsQueueBytes = Math.max(0, wsQueueBytes - size); wsQueueItems = Math.max(0, wsQueueItems - 1);
      if (wsFailed) return;
      await processWsMessage(event.data);
    });
  });

  serverSock.addEventListener('close', () => {
    clearInterval(heartbeat); closeSocketQuietly(serverSock); setOffline();
    if (wsFinished) return; wsFinished = true; wsStopped = true;
    pushToChain(async () => { if (wsFailed) return; await upstreamQueue.awaitEmpty(); releaseRemoteWriter(); });
  });

  serverSock.addEventListener('error', (err) => { handleWsError(err); });

  return new Response(null, { status: 101, webSocket: clientSock });
}

function isIPv4(value) {
  const parts = String(value || '').split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function stripIPv6Brackets(hostname = '') {
  const host = String(hostname || '').trim();
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function isIPHostname(hostname = '') {
  const host = stripIPv6Brackets(hostname);
  if (isIPv4(host)) return true;
  if (!host.includes(':')) return false;
  try { new URL(`http://[${host}]/`); return true; } catch (e) { return false; }
}

function convertToUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data || 0);
}

function concatBytes(...chunkList) {
  const chunks = chunkList.map(convertToUint8Array);
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { result.set(c, offset); offset += c.byteLength; }
  return result;
}

function closeSocketQuietly(socket) {
  try {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) socket.close();
  } catch (e) {}
}

async function dohQuery(domain, recordType) {
  const cacheKey = `${domain}:${recordType}`;
  if (DNS_CACHE.has(cacheKey)) {
    const cached = DNS_CACHE.get(cacheKey);
    if (Date.now() < cached.expires) return cached.data;
    DNS_CACHE.delete(cacheKey);
  }
  try {
    const typeMap = { 'A': 1, 'AAAA': 28 };
    const qtype = typeMap[recordType.toUpperCase()] || 1;
    const encodeDomain = (name) => {
      const parts = name.endsWith('.') ? name.slice(0, -1).split('.') : name.split('.');
      const bufs = [];
      for (const label of parts) {
        const enc = new TextEncoder().encode(label);
        bufs.push(new Uint8Array([enc.length]), enc);
      }
      bufs.push(new Uint8Array([0]));
      return concatBytes(...bufs);
    };
    const qname = encodeDomain(domain);
    const query = new Uint8Array(12 + qname.length + 4);
    const qview = new DataView(query.buffer);
    qview.setUint16(0, crypto.getRandomValues(new Uint16Array(1))[0]);
    qview.setUint16(2, 0x0100);
    qview.setUint16(4, 1);
    query.set(qname, 12);
    qview.setUint16(12 + qname.length, qtype);
    qview.setUint16(12 + qname.length + 2, 1);
    const response = await fetch(DOH_RESOLVER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/dns-message', 'Accept': 'application/dns-message' },
      body: query,
    });
    if (!response.ok) return [];
    const buf = new Uint8Array(await response.arrayBuffer());
    const dv = new DataView(buf.buffer);
    const qdcount = dv.getUint16(4);
    const ancount = dv.getUint16(6);
    const parseName = (pos) => {
      const labels = [];
      let p = pos, jumped = false, endPos = -1, safe = 128;
      while (p < buf.length && safe-- > 0) {
        const len = buf[p];
        if (len === 0) { if (!jumped) endPos = p + 1; break; }
        if ((len & 0xC0) === 0xC0) {
          if (!jumped) endPos = p + 2;
          p = ((len & 0x3F) << 8) | buf[p + 1];
          jumped = true; continue;
        }
        labels.push(new TextDecoder().decode(buf.slice(p + 1, p + 1 + len)));
        p += len + 1;
      }
      if (endPos === -1) endPos = p + 1;
      return [labels.join('.'), endPos];
    };
    let offset = 12;
    for (let i = 0; i < qdcount; i++) {
      const [, end] = parseName(offset);
      offset = Number(end) + 4;
    }
    const answers = [];
    for (let i = 0; i < ancount && offset < buf.length; i++) {
      const [name, nameEnd] = parseName(offset);
      offset = Number(nameEnd);
      const type = dv.getUint16(offset); offset += 2;
      offset += 2;
      const ttl = dv.getUint32(offset); offset += 4;
      const rdlen = dv.getUint16(offset); offset += 2;
      const rdata = buf.slice(offset, offset + rdlen);
      offset += rdlen;
      let data;
      if (type === 1 && rdlen === 4)
        data = `${rdata[0]}.${rdata[1]}.${rdata[2]}.${rdata[3]}`;
      else if (type === 28 && rdlen === 16) {
        const segs = [];
        for (let j = 0; j < 16; j += 2) segs.push(((rdata[j] << 8) | rdata[j + 1]).toString(16));
        data = segs.join(':');
      } else
        data = Array.from(rdata).map(b => b.toString(16).padStart(2, '0')).join('');
      answers.push({ name, type, TTL: ttl, data });
    }
    DNS_CACHE.set(cacheKey, { data: answers, expires: Date.now() + DNS_CACHE_TTL });
    return answers;
  } catch (e) { return []; }
}

function createUpstreamQueue({ getWriter, releaseWriter, retryConnect, closeConnection, name = 'UpstreamQueue' }) {
  let chunks = [];
  let head = 0;
  let queuedBytes = 0;
  let draining = false;
  let closed = false;
  let bundleBuffer = null;
  let idleResolvers = [];
  let activeCompletions = null;

  const settleCompletions = (completions, err = null) => {
    if (!completions) return;
    for (const comp of completions) { if (comp) { if (err) comp.reject(err); else comp.resolve(); } }
  };
  const rejectQueued = (err) => { for (let i = head; i < chunks.length; i++) { const item = chunks[i]; if (item && item.completions) settleCompletions(item.completions, err); } };
  const compact = () => { if (head > 32 && head * 2 >= chunks.length) { chunks = chunks.slice(head); head = 0; } };
  const resolveIdle = () => { if (queuedBytes || draining || !idleResolvers.length) return; const resolvers = idleResolvers; idleResolvers = []; for (const resolve of resolvers) resolve(); };
  const clear = (err = null) => {
    const closeErr = err || (closed ? new Error(`${name}: queue closed`) : null);
    if (closeErr) { rejectQueued(closeErr); settleCompletions(activeCompletions, closeErr); activeCompletions = null; }
    chunks = []; head = 0; queuedBytes = 0; resolveIdle();
  };
  const shift = () => {
    if (head >= chunks.length) return null;
    const item = chunks[head]; chunks[head++] = undefined; queuedBytes -= item.chunk.byteLength; compact(); return item;
  };
  const bundle = () => {
    const first = shift();
    if (!first) return null;
    if (head >= chunks.length || first.chunk.byteLength >= UPSTREAM_BUNDLE_TARGET_BYTES) return first;
    let byteLength = first.chunk.byteLength;
    let end = head;
    let allowRetry = first.allowRetry;
    let completions = first.completions || null;
    while (end < chunks.length) {
      const next = chunks[end];
      const nextLength = byteLength + next.chunk.byteLength;
      if (nextLength > UPSTREAM_BUNDLE_TARGET_BYTES) break;
      byteLength = nextLength;
      allowRetry = allowRetry && next.allowRetry;
      if (next.completions) completions = completions ? completions.concat(next.completions) : next.completions;
      end++;
    }
    if (end === head) return first;
    const output = (bundleBuffer ||= new Uint8Array(UPSTREAM_BUNDLE_TARGET_BYTES));
    output.set(first.chunk);
    let offset = first.chunk.byteLength;
    while (head < end) {
      const next = chunks[head]; chunks[head++] = undefined; queuedBytes -= next.chunk.byteLength;
      output.set(next.chunk, offset); offset += next.chunk.byteLength;
    }
    compact();
    return { chunk: output.subarray(0, byteLength), allowRetry, completions };
  };
  const drain = async () => {
    if (draining || closed) return;
    draining = true;
    try {
      for (; ;) {
        if (closed) break;
        const item = bundle();
        if (!item) break;
        let writer = getWriter();
        if (!writer) throw new Error(`${name}: remote writer unavailable`);
        const completions = item.completions || null;
        activeCompletions = completions;
        try {
          try { await writer.write(item.chunk); }
          catch (err) {
            releaseWriter?.();
            if (!item.allowRetry || typeof retryConnect !== 'function') throw err;
            await retryConnect();
            writer = getWriter();
            if (!writer) throw err;
            await writer.write(item.chunk);
          }
          settleCompletions(completions);
        } catch (err) { settleCompletions(completions, err); throw err; }
        finally { if (activeCompletions === completions) activeCompletions = null; }
      }
    } catch (err) { closed = true; clear(err); try { closeConnection?.(err); } catch (_) {} }
    finally { draining = false; if (!closed && head < chunks.length) queueMicrotask(drain); else resolveIdle(); }
  };
  const enqueue = (data, allowRetry = true, waitForFlush = false) => {
    if (closed) return false;
    if (!getWriter()) return false;
    const chunk = convertToUint8Array(data);
    if (!chunk.byteLength) return true;
    const nextBytes = queuedBytes + chunk.byteLength;
    const nextItems = chunks.length - head + 1;
    if (nextBytes > UPSTREAM_QUEUE_MAX_BYTES || nextItems > UPSTREAM_QUEUE_MAX_ITEMS) {
      closed = true;
      const err = Object.assign(new Error(`${name}: upload queue overflow (${nextBytes}B/${nextItems})`), { isQueueOverflow: true });
      clear(err);
      try { closeConnection?.(err); } catch (_) {}
      throw err;
    }
    let completionPromise = null;
    let completions = null;
    if (waitForFlush) {
      completions = [];
      completionPromise = new Promise((resolve, reject) => completions.push({ resolve, reject }));
    }
    chunks.push({ chunk, allowRetry, completions });
    queuedBytes = nextBytes;
    if (!draining) queueMicrotask(drain);
    return waitForFlush ? completionPromise.then(() => true) : true;
  };
  return {
    writeAndAwait(data, allowRetry = true) { return enqueue(data, allowRetry, true); },
    async awaitEmpty() { if (!queuedBytes && !draining) return; await new Promise(resolve => idleResolvers.push(resolve)); },
    clear() { closed = true; clear(); }
  };
}

function createDownstreamSender(webSocket, headerData = null) {
  const packetCap = DOWNSTREAM_GRAIN_BYTES;
  const tailBytes = DOWNSTREAM_GRAIN_TAIL_THRESHOLD;
  const lowWaterBytes = Math.max(4096, tailBytes << 3);
  let header = headerData;
  let pendingBuffer = new Uint8Array(packetCap);
  let pendingBytes = 0;
  let flushTimer = null;
  let microtaskQueued = false;
  let generation = 0;
  let scheduledGeneration = 0;
  let waitRounds = 0;
  let flushPromise = null;

  const sendRawChunk = async (chunk) => {
    if (webSocket.readyState !== WebSocket.OPEN) throw new Error('ws.readyState is not open');
    webSocket.send(chunk);
  };
  const attachResponseHeader = (chunk) => {
    if (!header) return chunk;
    const merged = new Uint8Array(header.length + chunk.byteLength);
    merged.set(header, 0); merged.set(chunk, header.length);
    header = null;
    return merged;
  };
  const flush = async () => {
    while (flushPromise) await flushPromise;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null; microtaskQueued = false;
    if (!pendingBytes) return;
    const output = pendingBuffer.subarray(0, pendingBytes).slice();
    pendingBuffer = new Uint8Array(packetCap); pendingBytes = 0; waitRounds = 0;
    flushPromise = sendRawChunk(output).finally(() => { flushPromise = null; });
    return flushPromise;
  };
  const scheduleFlush = () => {
    if (flushTimer || microtaskQueued) return;
    microtaskQueued = true;
    scheduledGeneration = generation;
    queueMicrotask(() => {
      microtaskQueued = false;
      if (!pendingBytes || flushTimer) return;
      if (packetCap - pendingBytes < tailBytes) { flush().catch(() => closeSocketQuietly(webSocket)); return; }
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (!pendingBytes) return;
        if (packetCap - pendingBytes < tailBytes) { flush().catch(() => closeSocketQuietly(webSocket)); return; }
        if (waitRounds < 2 && (generation !== scheduledGeneration || pendingBytes < lowWaterBytes)) {
          waitRounds++; scheduledGeneration = generation; scheduleFlush(); return;
        }
        flush().catch(() => closeSocketQuietly(webSocket));
      }, Math.max(DOWNSTREAM_GRAIN_SILENT_MS, 1));
    });
  };
  return {
    async sendDirect(data) {
      let chunk = convertToUint8Array(data);
      if (!chunk.byteLength) return;
      chunk = attachResponseHeader(chunk);
      await sendRawChunk(chunk);
    },
    async send(data) {
      let chunk = convertToUint8Array(data);
      if (!chunk.byteLength) return;
      chunk = attachResponseHeader(chunk);
      let offset = 0;
      const totalBytes = chunk.byteLength;
      while (offset < totalBytes) {
        if (!pendingBytes && totalBytes - offset >= packetCap) {
          const sendBytes = Math.min(packetCap, totalBytes - offset);
          const view = offset || sendBytes !== totalBytes ? chunk.subarray(offset, offset + sendBytes) : chunk;
          await sendRawChunk(view); offset += sendBytes; continue;
        }
        const copyBytes = Math.min(packetCap - pendingBytes, totalBytes - offset);
        pendingBuffer.set(chunk.subarray(offset, offset + copyBytes), pendingBytes);
        pendingBytes += copyBytes; offset += copyBytes; generation++;
        if (pendingBytes === packetCap || packetCap - pendingBytes < tailBytes) await flush();
        else scheduleFlush();
      }
    },
    flush
  };
}

async function waitForBackpressure(ws) {
  if (typeof ws.bufferedAmount === 'number')
    while (ws.bufferedAmount > 256 * 1024) await new Promise(r => setTimeout(r, 100));
}

async function connectStreams(remoteSocket, webSocket, headerData, retryFunc, onBytes) {
  let header = headerData, hasData = false, reader, useBYOB = false;
  const BYOB_LIMIT = 64 * 1024;
  const downstreamSender = createDownstreamSender(webSocket, header);
  header = null;
  try { reader = remoteSocket.readable.getReader({ mode: 'byob' }); useBYOB = true; }
  catch (e) { reader = remoteSocket.readable.getReader(); }
  try {
    if (!useBYOB) {
      while (true) {
        await waitForBackpressure(webSocket);
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        hasData = true;
        if (typeof onBytes === 'function') onBytes(value.byteLength);
        await downstreamSender.send(value);
      }
    } else {
      let readBuffer = new ArrayBuffer(BYOB_LIMIT);
      while (true) {
        await waitForBackpressure(webSocket);
        const { done, value } = await reader.read(new Uint8Array(readBuffer, 0, BYOB_LIMIT));
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        hasData = true;
        if (typeof onBytes === 'function') onBytes(value.byteLength);
        if (value.byteLength >= DOWNSTREAM_GRAIN_BYTES) {
          await downstreamSender.flush();
          await downstreamSender.sendDirect(value);
          readBuffer = new ArrayBuffer(BYOB_LIMIT);
        } else {
          await downstreamSender.send(value);
          readBuffer = value.buffer.byteLength >= BYOB_LIMIT ? value.buffer : new ArrayBuffer(BYOB_LIMIT);
        }
      }
    }
    await downstreamSender.flush();
  } catch (err) { closeSocketQuietly(webSocket); }
  finally {
    try { reader.cancel(); } catch (e) {}
    try { reader.releaseLock(); } catch (e) {}
  }
  if (!hasData && retryFunc) await retryFunc();
}

async function buildRaceCandidates(address, port) {
  if (!PRELOAD_RACE_DIAL || isIPHostname(address)) return null;
  const [aRecords, aaaaRecords] = await Promise.all([dohQuery(address, 'A'), dohQuery(address, 'AAAA')]);
  const ipv4List = [...new Set(aRecords.flatMap(r => r.type === 1 && typeof r.data === 'string' && isIPv4(r.data) ? [r.data] : []))];
  const ipv6List = [...new Set(aaaaRecords.flatMap(r => r.type === 28 && typeof r.data === 'string' && isIPHostname(r.data) ? [r.data] : []))];
  const limit = Math.max(1, TCP_CONCURRENCY | 0);
  const ipList = ipv4List.length >= limit ? ipv4List.slice(0, limit) : ipv4List.concat(ipv6List.slice(0, limit - ipv4List.length));
  if (ipList.length === 0) return null;
  return ipList.map((hostname, attempt) => ({ hostname, port, attempt, resolvedFrom: address }));
}

async function connectDirect(address, port, initialData = null) {
  const raceCandidates = await buildRaceCandidates(address, port);
  const candidates = raceCandidates || Array.from({ length: TCP_CONCURRENCY }, () => ({ hostname: address, port }));
  const openConnection = async (host, prt) => {
    const socket = connect({ hostname: host, port: prt });
    await Promise.race([socket.opened, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000))]);
    return socket;
  };
  if (candidates.length === 1) {
    const s = await openConnection(candidates[0].hostname, candidates[0].port);
    if (initialData && initialData.byteLength > 0) {
      const w = s.writable.getWriter(); await w.write(convertToUint8Array(initialData)); w.releaseLock();
    }
    return s;
  }
  const attempts = candidates.map(c => openConnection(c.hostname, c.port).then(socket => ({ socket, candidate: c })));
  let winner = null;
  try {
    winner = await Promise.any(attempts);
    if (initialData && initialData.byteLength > 0) {
      const w = winner.socket.writable.getWriter(); await w.write(convertToUint8Array(initialData)); w.releaseLock();
    }
    return winner.socket;
  } finally {
    if (winner)
      for (const attempt of attempts) attempt.then(({ socket }) => { if (socket !== winner.socket) try { socket.close(); } catch (e) {} }).catch(() => {});
  }
}

async function forwardVlessUDP(udpChunk, webSocket, respHeader, onBytes) {
  const requestData = convertToUint8Array(udpChunk);
  try {
    const tcpSocket = connect({ hostname: '8.8.4.4', port: 53 });
    let vlessHeader = respHeader;
    const writer = tcpSocket.writable.getWriter();
    await writer.write(requestData);
    writer.releaseLock();
    await tcpSocket.readable.pipeTo(new WritableStream({
      async write(chunk) {
        const response = convertToUint8Array(chunk);
        if (typeof onBytes === 'function') onBytes(response.byteLength);
        if (webSocket.readyState !== WebSocket.OPEN) return;
        if (vlessHeader) {
          const merged = new Uint8Array(vlessHeader.length + response.byteLength);
          merged.set(vlessHeader, 0); merged.set(response, vlessHeader.length);
          webSocket.send(merged.buffer); vlessHeader = null;
        } else { webSocket.send(response); }
      }
    }));
  } catch (e) {}
}

function extractUUIDFromVless(data) {
  if (data.byteLength < 17) return null;
  const hex = [...data.slice(1, 17)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}`;
}
