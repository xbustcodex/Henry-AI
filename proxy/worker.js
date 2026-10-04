/**
 * Henry AI — Cloudflare Worker: AI Proxy + Companion Relay
 *
 * Two functional layers:
 *
 * 1. AI PROXY — Routes from mobile Capacitor apps to AI providers,
 *    bypassing CORS restrictions.
 *
 *    /proxy/openai/*      → api.openai.com
 *    /proxy/anthropic/*   → api.anthropic.com
 *    /proxy/google/*      → generativelanguage.googleapis.com
 *    /proxy/groq/*        → api.groq.com
 *    /proxy/openrouter/*  → openrouter.ai
 *    /proxy/ddg/*         → api.duckduckgo.com
 *
 * 2. COMPANION RELAY — Cloud relay so iPhone/iPad can reach desktop
 *    Henry even when not on the same WiFi network.
 *
 *    POST /relay/register           Register a device (desktop or mobile)
 *    POST /relay/desktop/announce   Desktop announces itself (host, port, token)
 *    GET  /relay/desktop/:deviceId  Mobile looks up desktop endpoint
 *    POST /relay/push               Desktop pushes sync events for mobile
 *    GET  /relay/events             Mobile polls for queued events
 *    POST /relay/mobile             Mobile sends a capture/action to desktop
 *    GET  /relay/mobile/pending     Desktop polls for mobile-initiated messages
 *    DELETE /relay/device/:id       Unregister a device
 *
 *    Requires a KV namespace binding named HENRY_RELAY in wrangler.toml:
 *      [[kv_namespaces]]
 *      binding = "HENRY_RELAY"
 *      id = "<your-kv-namespace-id>"
 *
 * Deploy:
 *   cd proxy
 *   npx wrangler deploy
 */

// ── AI Proxy routes ────────────────────────────────────────────────────────

const AI_ROUTES = {
  '/proxy/openai':     'https://api.openai.com',
  '/proxy/anthropic':  'https://api.anthropic.com',
  '/proxy/google':     'https://generativelanguage.googleapis.com',
  '/proxy/groq':       'https://api.groq.com',
  '/proxy/openrouter': 'https://openrouter.ai',
  '/proxy/ddg':        'https://api.duckduckgo.com',
};

// ── CORS ───────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

function jsonRes(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', ...extra },
  });
}

// ── KV helpers ─────────────────────────────────────────────────────────────

const EVENT_TTL = 60 * 60;      // 1 hour TTL for queued events
const DEVICE_TTL = 7 * 24 * 3600; // 7 days TTL for device registrations

async function kvGet(env, key) {
  if (!env.HENRY_RELAY) return null;
  try {
    const val = await env.HENRY_RELAY.get(key, 'json');
    return val;
  } catch {
    return null;
  }
}

async function kvPut(env, key, value, ttl = DEVICE_TTL) {
  if (!env.HENRY_RELAY) return;
  try {
    await env.HENRY_RELAY.put(key, JSON.stringify(value), { expirationTtl: ttl });
  } catch { /* ignore */ }
}

async function kvDelete(env, key) {
  if (!env.HENRY_RELAY) return;
  try {
    await env.HENRY_RELAY.delete(key);
  } catch { /* ignore */ }
}

async function kvList(env, prefix) {
  if (!env.HENRY_RELAY) return [];
  try {
    const list = await env.HENRY_RELAY.list({ prefix });
    return list.keys ?? [];
  } catch {
    return [];
  }
}

// ── Auth ───────────────────────────────────────────────────────────────────

function getToken(req) {
  const auth = req.headers.get('Authorization') ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  const url = new URL(req.url);
  return url.searchParams.get('token') ?? '';
}

async function validateRelayToken(env, token) {
  if (!token) return null;
  const deviceId = await kvGet(env, `token:${token}`);
  return deviceId ?? null;
}

// ── Relay route handlers ───────────────────────────────────────────────────

async function handleRelay(req, env, path, url) {
  const method = req.method;

  // Register a device (desktop or mobile)
  // POST /relay/register  { deviceId, token, platform, name }
  if (path === '/relay/register' && method === 'POST') {
    const body = await req.json().catch(() => null);
    if (!body?.deviceId || !body?.token) return jsonRes(400, { error: 'deviceId and token required' });

    await kvPut(env, `device:${body.deviceId}`, {
      id: body.deviceId,
      platform: body.platform ?? 'unknown',
      name: body.name ?? 'Unknown',
      registeredAt: new Date().toISOString(),
    });
    // Map token → deviceId for auth
    await kvPut(env, `token:${body.token}`, body.deviceId);

    return jsonRes(200, { ok: true });
  }

  // Desktop announces its LAN address so mobile can use it as primary route
  // POST /relay/desktop/announce  { host, port } (auth required)
  if (path === '/relay/desktop/announce' && method === 'POST') {
    const token = getToken(req);
    const deviceId = await validateRelayToken(env, token);
    if (!deviceId) return jsonRes(401, { error: 'Unauthorized' });

    const body = await req.json().catch(() => null);
    await kvPut(env, `desktop:${deviceId}`, {
      deviceId,
      host: body?.host,
      port: body?.port,
      lastSeen: new Date().toISOString(),
    });

    return jsonRes(200, { ok: true });
  }

  // Mobile looks up desktop endpoint (for LAN fallback discovery)
  // GET /relay/desktop/:deviceId
  if (path.startsWith('/relay/desktop/') && method === 'GET') {
    const token = getToken(req);
    const callerId = await validateRelayToken(env, token);
    if (!callerId) return jsonRes(401, { error: 'Unauthorized' });

    const desktopId = path.split('/')[3];
    const info = await kvGet(env, `desktop:${desktopId}`);
    if (!info) return jsonRes(404, { error: 'Desktop not found' });
    return jsonRes(200, info);
  }

  // Desktop pushes sync events for mobile to pick up
  // POST /relay/push  { events: SyncEvent[], targetDeviceId?: string }
  if (path === '/relay/push' && method === 'POST') {
    const token = getToken(req);
    const deviceId = await validateRelayToken(env, token);
    if (!deviceId) return jsonRes(401, { error: 'Unauthorized' });

    const body = await req.json().catch(() => null);
    const events = Array.isArray(body?.events) ? body.events : [];

    // Queue each event with a unique key
    for (const event of events) {
      const key = `event:${deviceId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      await kvPut(env, key, event, EVENT_TTL);
    }

    return jsonRes(200, { queued: events.length });
  }

  // Mobile polls for events from desktop
  // GET /relay/events?since=<timestamp>
  if (path === '/relay/events' && method === 'GET') {
    const token = getToken(req);
    const deviceId = await validateRelayToken(env, token);
    if (!deviceId) return jsonRes(401, { error: 'Unauthorized' });

    // Find the desktop that this mobile is linked to
    const linkKey = `link:${deviceId}`;
    const desktopId = await kvGet(env, linkKey);
    if (!desktopId) return jsonRes(200, []);

    const since = parseInt(url.searchParams.get('since') ?? '0', 10);
    const keys = await kvList(env, `event:${desktopId}:`);
    const events = [];

    for (const k of keys.slice(0, 50)) {
      const event = await kvGet(env, k.name);
      if (event && event.timestamp > since) {
        events.push(event);
      }
    }

    return jsonRes(200, events);
  }

  // Link a mobile device to a desktop device
  // POST /relay/link  { desktopDeviceId }
  if (path === '/relay/link' && method === 'POST') {
    const token = getToken(req);
    const deviceId = await validateRelayToken(env, token);
    if (!deviceId) return jsonRes(401, { error: 'Unauthorized' });

    const body = await req.json().catch(() => null);
    if (!body?.desktopDeviceId) return jsonRes(400, { error: 'desktopDeviceId required' });

    await kvPut(env, `link:${deviceId}`, body.desktopDeviceId);
    return jsonRes(200, { ok: true });
  }

  // Mobile sends a capture or action to the desktop
  // POST /relay/mobile  { type, payload }
  if (path === '/relay/mobile' && method === 'POST') {
    const token = getToken(req);
    const deviceId = await validateRelayToken(env, token);
    if (!deviceId) return jsonRes(401, { error: 'Unauthorized' });

    const body = await req.json().catch(() => null);
    if (!body) return jsonRes(400, { error: 'Bad request' });

    // Find the desktop this mobile is linked to
    const desktopId = await kvGet(env, `link:${deviceId}`);
    if (!desktopId) return jsonRes(404, { error: 'Not linked to a desktop' });

    // Queue message for desktop to pick up
    const key = `mobile:${desktopId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    await kvPut(env, key, { ...body, fromDevice: deviceId, timestamp: Date.now() }, EVENT_TTL);

    return jsonRes(200, { ok: true });
  }

  // Desktop polls for mobile-initiated messages (captures, action decisions)
  // GET /relay/mobile/pending
  if (path === '/relay/mobile/pending' && method === 'GET') {
    const token = getToken(req);
    const deviceId = await validateRelayToken(env, token);
    if (!deviceId) return jsonRes(401, { error: 'Unauthorized' });

    const keys = await kvList(env, `mobile:${deviceId}:`);
    const messages = [];

    for (const k of keys.slice(0, 50)) {
      const msg = await kvGet(env, k.name);
      if (msg) {
        messages.push(msg);
        await kvDelete(env, k.name); // consume on read
      }
    }

    return jsonRes(200, messages);
  }

  // Unregister a device
  // DELETE /relay/device/:id
  if (path.startsWith('/relay/device/') && method === 'DELETE') {
    const token = getToken(req);
    const callerId = await validateRelayToken(env, token);
    if (!callerId) return jsonRes(401, { error: 'Unauthorized' });

    const targetId = path.split('/')[3];
    if (callerId !== targetId) return jsonRes(403, { error: 'Cannot unlink another device' });

    await kvDelete(env, `device:${targetId}`);
    await kvDelete(env, `desktop:${targetId}`);
    return jsonRes(200, { ok: true });
  }

  return jsonRes(404, { error: 'Unknown relay route' });
}

// ── Main fetch handler ─────────────────────────────────────────────────────

export default {
  async fetch(request, env, _ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ── Relay routes ─────────────────────────────────────────────────────
    if (path.startsWith('/relay/')) {
      return handleRelay(request, env, path, url);
    }

    // ── AI proxy routes ───────────────────────────────────────────────────
    const entry = Object.entries(AI_ROUTES).find(([prefix]) => path.startsWith(prefix));
    if (!entry) {
      return new Response(JSON.stringify({ error: 'Unknown route' }), {
        status: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const [prefix, targetBase] = entry;
    const upstreamPath = path.slice(prefix.length) || '/';
    const targetUrl = `${targetBase}${upstreamPath}${url.search}`;

    const forwardHeaders = new Headers(request.headers);
    ['host', 'origin', 'referer', 'cf-connecting-ip', 'cf-ray', 'cf-visitor',
     'cf-ipcountry', 'x-forwarded-for', 'x-forwarded-proto'].forEach((h) =>
      forwardHeaders.delete(h)
    );

    let response;
    try {
      response = await fetch(targetUrl, {
        method: request.method,
        headers: forwardHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 502,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const responseHeaders = new Headers(response.headers);
    Object.entries(CORS).forEach(([k, v]) => responseHeaders.set(k, v));
    responseHeaders.delete('transfer-encoding');
    responseHeaders.delete('content-encoding');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  },
};
