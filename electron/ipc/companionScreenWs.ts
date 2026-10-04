// electron/ipc/companionScreenWs.ts
// Real-time screen stream over WebSocket, with multi-display support.
//
// Client connects to: ws(s)://host/ws/screen?token=<jwt>
// Client sends: { type: 'config', displayId, width, height, quality, fps, paused }
// Server sends: 'hello' message with list of displays, then JPEG frames.

import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'http';
import { desktopCapturer, screen as electronScreen } from 'electron';
import { verifyTokenString } from './companionAuth';

interface ClientState {
  ws: WebSocket;
  deviceId: string;
  displayId: number;        // electron Display.id
  width: number;
  height: number;
  quality: number;
  fps: number;
  paused: boolean;
  // Fix G: track consecutive capture failures so we can send a single
  // diagnostic message to the client (e.g. Screen Recording permission
  // not granted → desktopCapturer returns no sources / null thumbnails)
  // instead of silently sending no frames forever.
  captureFailStreak: number;
  reportedFailure: boolean;
}

const clients = new Set<ClientState>();
let loopRunning = false;

async function captureDisplay(displayId: number, width: number, height: number, quality: number): Promise<Buffer | null> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
      fetchWindowIcons: false,
    });
    // desktopCapturer source `display_id` is a string in newer Electron;
    // match against numeric display id.
    let src = sources.find(s => String((s as any).display_id) === String(displayId));
    if (!src) {
      // Fallback: index by position in getAllDisplays
      const all = electronScreen.getAllDisplays();
      const idx = all.findIndex(d => d.id === displayId);
      if (idx >= 0 && idx < sources.length) src = sources[idx];
    }
    if (!src) src = sources[0];
    if (!src) return null;
    return src.thumbnail.toJPEG(quality);
  } catch (e) {
    console.error('[henry:screen] capture failed', e);
    return null;
  }
}

async function streamLoop() {
  if (loopRunning) return;
  loopRunning = true;
  try {
    while (clients.size > 0) {
      const t0 = Date.now();
      const tasks = Array.from(clients).map(async (c) => {
        if (c.paused || c.ws.readyState !== WebSocket.OPEN) return;
        const jpeg = await captureDisplay(c.displayId, c.width, c.height, c.quality);
        if (jpeg && c.ws.readyState === WebSocket.OPEN) {
          // Fix G: backpressure — if the previous frame hasn't drained yet
          // (slow WiFi to iPad), skip this one rather than queueing memory.
          // ws.bufferedAmount > ~2 MB ≈ ~5+ frames pending → drop.
          if (c.ws.bufferedAmount > 2_000_000) return;
          c.ws.send(jpeg, { binary: true });
          c.captureFailStreak = 0;
        } else if (!jpeg && c.ws.readyState === WebSocket.OPEN) {
          // Fix G: tell the client what's wrong instead of an empty canvas.
          // Most common cause: Screen Recording permission not granted to
          // Electron in System Settings → Privacy & Security. A few failures
          // in a row are needed to avoid false positives on transient errors.
          c.captureFailStreak++;
          if (c.captureFailStreak >= 3 && !c.reportedFailure) {
            c.reportedFailure = true;
            try {
              c.ws.send(JSON.stringify({
                type: 'error',
                code: 'no_screen_recording',
                message: 'Screen Recording permission not granted. Open System Settings → Privacy & Security → Screen Recording, enable Henry AI / Electron, then restart Henry.',
              }));
            } catch { /* socket may be closing */ }
          }
        }
      });
      await Promise.all(tasks);
      const minFps = Math.min(...Array.from(clients).map(c => c.fps), 15);
      const frameMs = Math.max(1000 / minFps, 33);
      const elapsed = Date.now() - t0;
      await new Promise(r => setTimeout(r, Math.max(0, frameMs - elapsed)));
    }
  } finally {
    loopRunning = false;
  }
}

export function attachScreenWs(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url) { socket.destroy(); return; }
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws/screen') return;

    const token = url.searchParams.get('token') ?? undefined;
    const session = verifyTokenString(token);
    if (!session || !session.scope.includes('view')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, session));
  });

  wss.on('connection', (ws: WebSocket, _req: any, session: any) => {
    const primary = electronScreen.getPrimaryDisplay();
    const all = electronScreen.getAllDisplays();

    const state: ClientState = {
      ws,
      deviceId: session.deviceId,
      displayId: primary.id,
      width: 1280,
      height: 800,
      quality: 55,
      fps: 15,
      paused: false,
      captureFailStreak: 0,
      reportedFailure: false,
    };
    clients.add(state);

    ws.send(JSON.stringify({
      type: 'hello',
      displays: all.map((d, i) => ({
        id: d.id,
        label: d.label || (d.id === primary.id ? 'Main' : `Display ${i + 1}`),
        primary: d.id === primary.id,
        width: d.bounds.width,
        height: d.bounds.height,
        scaleFactor: d.scaleFactor,
      })),
      activeDisplayId: state.displayId,
    }));

    streamLoop();

    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'config') {
        if (typeof msg.displayId === 'number') {
          const ok = all.some(d => d.id === msg.displayId);
          if (ok) state.displayId = msg.displayId;
        }
        if (typeof msg.width  === 'number') state.width  = Math.max(320, Math.min(2560, msg.width  | 0));
        if (typeof msg.height === 'number') state.height = Math.max(240, Math.min(1600, msg.height | 0));
        if (typeof msg.quality === 'number') state.quality = Math.max(20, Math.min(90, msg.quality | 0));
        if (typeof msg.fps     === 'number') state.fps     = Math.max(2, Math.min(30, msg.fps | 0));
        if (typeof msg.paused  === 'boolean') state.paused = msg.paused;
      }
    });

    ws.on('close', () => { clients.delete(state); });
    ws.on('error', () => { clients.delete(state); try { ws.terminate(); } catch {} });
  });

  return wss;
}

export function activeViewers(): number { return clients.size; }
