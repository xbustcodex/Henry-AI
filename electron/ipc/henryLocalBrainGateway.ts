/**
 * Henry Local Brain Gateway — loopback HTTP proxy on 127.0.0.1:11534 → Ollama :11434.
 *
 * Started from main on app ready so first-run setup can point `ollama_base_url` at Henry’s
 * controlled endpoint. External tools can use the same URL.
 */

import http from 'http';
import type Database from 'better-sqlite3';
import { ipcMain } from 'electron';
import { log } from '../lib/log';

const DEFAULT_GATEWAY_PORT = 11534;
const UPSTREAM = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

let listenPort: number | null = null;
let server: http.Server | null = null;

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function stripHopByHop(headers: http.IncomingHttpHeaders): Record<string, string> {
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
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!v || drop.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(',') : v;
  }
  return out;
}

/**
 * Listen on loopback only. Safe default: enabled unless HENRY_DISABLE_OLLAMA_GATEWAY=1.
 */
export function startHenryLocalBrainGateway(db: Database.Database): void {
  if (process.env.HENRY_DISABLE_OLLAMA_GATEWAY === '1') {
    log.debug('[Henry] Ollama gateway disabled (HENRY_DISABLE_OLLAMA_GATEWAY=1)');
    return;
  }
  if (server) return;

  const upstream = UPSTREAM.replace(/\/$/, '');
  const port = Number(process.env.HENRY_BRIDGE_PORT || DEFAULT_GATEWAY_PORT);

  const s = http.createServer(async (req, res) => {
    const targetUrl = `${upstream}${req.url || '/'}`;
    let body: Buffer | undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        body = await readBody(req);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
        return;
      }
    }

    try {
      const bodyInit: BodyInit | undefined =
        body && body.length > 0 ? new Blob([new Uint8Array(body)]) : undefined;
      const r = await fetch(targetUrl, {
        method: req.method,
        headers: stripHopByHop(req.headers),
        body: bodyInit,
      });
      const buf = Buffer.from(await r.arrayBuffer());
      const headers: Record<string, string> = {};
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
          error: `Upstream Ollama failed (${upstream}): ${e instanceof Error ? e.message : String(e)}`,
        })
      );
    }
  });

  s.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[Henry] Ollama gateway port ${port} in use — continuing without gateway.`);
    } else {
      console.error('[Henry] Ollama gateway error:', err);
    }
  });

  s.listen(port, '127.0.0.1', () => {
    listenPort = port;
    server = s;
    log.info(`[Henry] Local brain gateway http://127.0.0.1:${port} → ${upstream}`);
  });
}

export function stopHenryLocalBrainGateway(): void {
  if (server) {
    server.close();
    server = null;
    listenPort = null;
  }
}

export function registerHenryLocalBrainGatewayIpc(db: Database.Database): void {
  ipcMain.handle('henry:localGatewayStatus', () => {
    const upstream = UPSTREAM.replace(/\/$/, '');
    if (!listenPort) {
      return { active: false, url: null as string | null, upstream };
    }
    return {
      active: true,
      port: listenPort,
      url: `http://127.0.0.1:${listenPort}`,
      upstream,
    };
  });
}
