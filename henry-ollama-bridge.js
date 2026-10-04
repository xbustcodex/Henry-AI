#!/usr/bin/env node
/**
 * Local HTTP bridge in front of Ollama with an explicit execution gate.
 *
 * Usage (from repo root so Node can find this file):
 *   HENRY_ALLOW_EXECUTION=true npm run bridge:ollama
 *   HENRY_ALLOW_EXECUTION=true node ./henry-ollama-bridge.js
 *
 * Env:
 *   HENRY_ALLOW_EXECUTION  — must be "true" to forward POST/chat (and other mutating) requests.
 *                            When unset or false, only read-only GETs to /api/version and /api/tags are proxied.
 *   OLLAMA_HOST            — upstream base URL (default http://127.0.0.1:11434)
 *   HENRY_BRIDGE_HOST      — bind address (default 127.0.0.1)
 *   HENRY_BRIDGE_PORT      — listen port (default 11534)
 *
 * Point another tool at http://127.0.0.1:11534 instead of Ollama directly when you want a hard gate.
 */

const http = require('http');
const { URL } = require('url');

const ALLOW = process.env.HENRY_ALLOW_EXECUTION === 'true';
const UPSTREAM = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const LISTEN_HOST = process.env.HENRY_BRIDGE_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.HENRY_BRIDGE_PORT || 11534);

function allowRequest(req) {
  if (ALLOW) return true;
  if (req.method !== 'GET') return false;
  let path = '/';
  try {
    path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  } catch {
    return false;
  }
  return path === '/api/version' || path === '/api/tags';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function stripHopByHop(headers) {
  const out = { ...headers };
  const drop = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailers',
    'transfer-encoding',
    'upgrade',
    'host',
  ]);
  for (const k of Object.keys(out)) {
    if (drop.has(k.toLowerCase())) delete out[k];
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  if (!allowRequest(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error:
          'HENRY_ALLOW_EXECUTION is not true — this bridge refuses model/chat and other non-read-only calls. ' +
          'Run: HENRY_ALLOW_EXECUTION=true node henry-ollama-bridge.js',
      })
    );
    return;
  }

  const targetUrl = `${UPSTREAM}${req.url || '/'}`;
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = await readBody(req);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
      return;
    }
  }

  try {
    const r = await fetch(targetUrl, {
      method: req.method,
      headers: stripHopByHop(req.headers),
      body: body && body.length ? body : undefined,
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const headers = {};
    r.headers.forEach((v, k) => {
      if (k === 'transfer-encoding') return;
      headers[k] = v;
    });
    res.writeHead(r.status, headers);
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: `Upstream fetch failed (${UPSTREAM}): ${e.message || e}`,
      })
    );
  }
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(
    `[henry-ollama-bridge] listening http://${LISTEN_HOST}:${LISTEN_PORT} → ${UPSTREAM} (HENRY_ALLOW_EXECUTION=${ALLOW})`
  );
});
