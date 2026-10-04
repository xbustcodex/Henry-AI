// electron/ipc/companionRemoteInput.ts
// Display-aware remote input handlers.
//
// Provides HTTP handlers (called from syncBridge) for:
//   POST /companion/displays   - list displays
//   POST /companion/v2/click   - click on a specific display, with optional double/right
//   POST /companion/v2/move    - move mouse without clicking (for hover, Pencil tracking)
//   POST /companion/v2/drag    - mouse-down → move → mouse-up (Apple Pencil drawing/dragging)
//   POST /companion/v2/scroll  - scroll on a specific display
//
// All v2 endpoints expect:
//   { displayId: <id>, x: 0..1, y: 0..1, ... }
//
// The x,y are normalized to the chosen display's bounds. We translate to
// macOS global coordinates using display.bounds.x/y offsets.

import { screen as electronScreen } from 'electron';
import { execFile, execFileSync } from 'child_process';
import { getActiveSessionFor } from './remoteSession';
import { verifyAuthHeader } from './companionAuth';
import type { IncomingMessage, ServerResponse } from 'http';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readJson<T = any>(req: IncomingMessage): Promise<T | null> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
  });
}

function jsonResponse(res: ServerResponse, status: number, body: any) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

function authAndSession(req: IncomingMessage, res: ServerResponse) {
  const sess = verifyAuthHeader(req.headers.authorization as string | undefined);
  if (!sess) { jsonResponse(res, 401, { ok: false, error: 'unauthorized' }); return null; }
  const active = getActiveSessionFor(sess.deviceId);
  if (!active) { jsonResponse(res, 409, { ok: false, error: 'no_active_session' }); return null; }
  active.touch();
  if (!_rateLimitOk(sess.deviceId)) {
    jsonResponse(res, 429, { ok: false, error: 'rate_limited', retryAfterMs: 100 });
    return null;
  }
  return { sess, active };
}

// R2-Fix 5: token-bucket rate limit per paired device. A paired client that
// turns malicious (or buggy — e.g. a runaway loop in the client) could
// otherwise flood the server with /companion/v2/click and spawn a cliclick
// subprocess per call. 60 tokens/sec steady, 200 burst is generous for
// Pencil drawing + scroll while still cutting off a true flood.
const _buckets = new Map<string, { tokens: number; lastMs: number }>();
const _RATE_PER_SEC = 60;
const _BURST = 200;
function _rateLimitOk(deviceId: string): boolean {
  _maybeSweepBuckets();
  const now = Date.now();
  let b = _buckets.get(deviceId);
  if (!b) { b = { tokens: _BURST, lastMs: now }; _buckets.set(deviceId, b); }
  // Refill since last call.
  const elapsedSec = (now - b.lastMs) / 1000;
  b.tokens = Math.min(_BURST, b.tokens + elapsedSec * _RATE_PER_SEC);
  b.lastMs = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
// Periodic sweep so disconnected devices don't accumulate. Runs lazily —
// no setInterval — so we don't keep the event loop alive unnecessarily.
let _lastSweepMs = 0;
function _maybeSweepBuckets() {
  const now = Date.now();
  if (now - _lastSweepMs < 60_000) return;
  _lastSweepMs = now;
  for (const [k, v] of _buckets) {
    if (now - v.lastMs > 5 * 60_000) _buckets.delete(k);
  }
}

// ---------------------------------------------------------------------------
// Display info
// ---------------------------------------------------------------------------
export function getDisplaysJson() {
  const displays = electronScreen.getAllDisplays();
  const primary = electronScreen.getPrimaryDisplay();
  return displays.map((d, i) => ({
    id: d.id,
    label: d.label || (d.id === primary.id ? 'Main' : `Display ${i + 1}`),
    primary: d.id === primary.id,
    bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
    workArea: { x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height },
    scaleFactor: d.scaleFactor,
    rotation: d.rotation,
  }));
}

function findDisplay(displayId: number | string | undefined) {
  const all = electronScreen.getAllDisplays();
  if (displayId === undefined || displayId === null) return electronScreen.getPrimaryDisplay();
  const idNum = Number(displayId);
  return all.find(d => d.id === idNum) || electronScreen.getPrimaryDisplay();
}

// ---------------------------------------------------------------------------
// Coordinate translation: normalized (0..1) on a display → macOS global pixels
// ---------------------------------------------------------------------------
function normToGlobal(nx: number, ny: number, displayId?: number) {
  const d = findDisplay(displayId);
  const x = Math.round(d.bounds.x + Math.max(0, Math.min(1, nx)) * d.bounds.width);
  const y = Math.round(d.bounds.y + Math.max(0, Math.min(1, ny)) * d.bounds.height);
  return { x, y, display: d };
}

// ---------------------------------------------------------------------------
// cliclick wrapper — fast, supports drag, doesn't need to spawn osascript
// Falls back to osascript if cliclick isn't installed.
// ---------------------------------------------------------------------------
let cliclickPath: string | null | undefined;  // undefined = not checked, null = not available
function getCliclick(): string | null {
  if (cliclickPath !== undefined) return cliclickPath;
  for (const p of ['/opt/homebrew/bin/cliclick', '/usr/local/bin/cliclick', '/usr/bin/cliclick']) {
    try {
      execFileSync(p, ['-V'], { timeout: 1000, stdio: 'pipe' });
      cliclickPath = p;
      return p;
    } catch { /* try next */ }
  }
  cliclickPath = null;
  return null;
}

function clickAt(x: number, y: number, opts: { double?: boolean; right?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const cc = getCliclick();
    if (cc) {
      // cliclick: c:X,Y = click, dc:X,Y = double-click, rc:X,Y = right-click
      const cmd = opts.double ? `dc:${x},${y}` : opts.right ? `rc:${x},${y}` : `c:${x},${y}`;
      execFile(cc, [cmd], { timeout: 3000 }, (err) => err ? reject(err) : resolve());
    } else {
      // osascript fallback
      let script: string;
      if (opts.right) {
        script = `tell application "System Events" to (every UI element of (current location of mouse)) -- no native right-click via plain script; require cliclick`;
        // Plain osascript can't reliably right-click. Use a workaround: hold control during click.
        script = `tell application "System Events" to key down control\ndelay 0.05\ntell application "System Events" to click at {${x}, ${y}}\ndelay 0.05\ntell application "System Events" to key up control`;
      } else if (opts.double) {
        script = `tell application "System Events" to click at {${x}, ${y}}\ndelay 0.05\ntell application "System Events" to click at {${x}, ${y}}`;
      } else {
        script = `tell application "System Events" to click at {${x}, ${y}}`;
      }
      execFile('osascript', ['-e', script], { timeout: 3000 }, (err) => err ? reject(err) : resolve());
    }
  });
}

function moveTo(x: number, y: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cc = getCliclick();
    if (cc) {
      execFile(cc, [`m:${x},${y}`], { timeout: 2000 }, (err) => err ? reject(err) : resolve());
    } else {
      // osascript can't move the mouse without clicking. Without cliclick, move = no-op.
      resolve();
    }
  });
}

function dragLine(points: Array<{x: number; y: number}>): Promise<void> {
  return new Promise((resolve, reject) => {
    const cc = getCliclick();
    if (!cc || points.length < 2) {
      // No cliclick = no drag. Without it, the best we can do is the endpoint click.
      if (points.length > 0) {
        const last = points[points.length - 1];
        clickAt(last.x, last.y).then(resolve, reject);
      } else resolve();
      return;
    }
    // cliclick chains commands: dd:X,Y (drag down/begin), then m:X,Y points, then du:X,Y (drag up/end)
    const args: string[] = [];
    args.push(`dd:${points[0].x},${points[0].y}`);
    for (let i = 1; i < points.length - 1; i++) {
      args.push(`m:${points[i].x},${points[i].y}`);
    }
    const last = points[points.length - 1];
    args.push(`du:${last.x},${last.y}`);
    execFile(cc, args, { timeout: 10000 }, (err) => err ? reject(err) : resolve());
  });
}

function scrollAt(x: number, y: number, dy: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cc = getCliclick();
    if (cc) {
      // cliclick: w:dx,dy scrolls at current mouse position; move first
      execFile(cc, [`m:${x},${y}`, `w:0,${Math.round(dy)}`], { timeout: 3000 }, (err) => err ? reject(err) : resolve());
    } else {
      // osascript fallback: AppleScript can't scroll directly; we use a sequence
      // of "scroll wheel" keystrokes which is unreliable. Tell the user to install cliclick.
      reject(new Error('scroll requires cliclick: brew install cliclick'));
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP route handlers
// ---------------------------------------------------------------------------
export async function handleDisplays(req: IncomingMessage, res: ServerResponse) {
  if (!authAndSession(req, res)) return;
  jsonResponse(res, 200, { ok: true, displays: getDisplaysJson(), cliclickAvailable: !!getCliclick() });
}

export async function handleClick(req: IncomingMessage, res: ServerResponse) {
  if (!authAndSession(req, res)) return;
  const body = await readJson<{x: number; y: number; displayId?: number; double?: boolean; right?: boolean}>(req);
  if (!body || typeof body.x !== 'number' || typeof body.y !== 'number') {
    jsonResponse(res, 400, { ok: false, error: 'missing_xy' });
    return;
  }
  const { x, y } = normToGlobal(body.x, body.y, body.displayId);
  try {
    await clickAt(x, y, { double: !!body.double, right: !!body.right });
    jsonResponse(res, 200, { ok: true, x, y });
  } catch (e: any) {
    jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
  }
}

export async function handleMove(req: IncomingMessage, res: ServerResponse) {
  if (!authAndSession(req, res)) return;
  const body = await readJson<{x: number; y: number; displayId?: number}>(req);
  if (!body || typeof body.x !== 'number' || typeof body.y !== 'number') {
    jsonResponse(res, 400, { ok: false, error: 'missing_xy' });
    return;
  }
  const { x, y } = normToGlobal(body.x, body.y, body.displayId);
  try {
    await moveTo(x, y);
    jsonResponse(res, 200, { ok: true });
  } catch (e: any) {
    jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
  }
}

export async function handleDrag(req: IncomingMessage, res: ServerResponse) {
  if (!authAndSession(req, res)) return;
  const body = await readJson<{points: Array<{x: number; y: number}>; displayId?: number}>(req);
  if (!body || !Array.isArray(body.points) || body.points.length < 2) {
    jsonResponse(res, 400, { ok: false, error: 'need at least 2 points' });
    return;
  }
  const cc = getCliclick();
  if (!cc) {
    jsonResponse(res, 501, { ok: false, error: 'drag requires cliclick: brew install cliclick' });
    return;
  }
  const globalPts = body.points.map(p => {
    const g = normToGlobal(p.x, p.y, body.displayId);
    return { x: g.x, y: g.y };
  });
  try {
    await dragLine(globalPts);
    jsonResponse(res, 200, { ok: true, count: globalPts.length });
  } catch (e: any) {
    jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
  }
}

export async function handleScroll(req: IncomingMessage, res: ServerResponse) {
  if (!authAndSession(req, res)) return;
  const body = await readJson<{x: number; y: number; dy: number; displayId?: number}>(req);
  if (!body || typeof body.x !== 'number' || typeof body.y !== 'number') {
    jsonResponse(res, 400, { ok: false, error: 'missing_xy' });
    return;
  }
  const { x, y } = normToGlobal(body.x, body.y, body.displayId);
  try {
    await scrollAt(x, y, body.dy);
    jsonResponse(res, 200, { ok: true });
  } catch (e: any) {
    jsonResponse(res, 500, { ok: false, error: String(e?.message || e) });
  }
}
