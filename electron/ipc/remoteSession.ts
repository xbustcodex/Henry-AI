// electron/ipc/remoteSession.ts
// Manages the lifecycle of a remote-control session:
//   - prompts the Mac user for consent with a native dialog
//   - shows a red, always-on-top "Remote control active" indicator
//   - enforces single active controller
//   - idle timeout (10 min of no input)
//   - writes to an audit log
//
// Used by syncBridge's /companion/* control endpoints — they call
// requireActiveSession() before injecting input.

import { BrowserWindow, dialog, ipcMain, screen as electronScreen } from 'electron';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

// ---------------------------------------------------------------------------
// Audit log (append-only JSONL)
// ---------------------------------------------------------------------------
function auditFile() {
  return path.join(app.getPath('userData'), 'remote-sessions.jsonl');
}

function audit(event: object) {
  try {
    fs.appendFileSync(
      auditFile(),
      JSON.stringify({ ts: Date.now(), ...event }) + '\n'
    );
  } catch (e) {
    // R2-Fix 7: was silent — but this is the security audit log for remote
    // control sessions (consent grants, ends, denials). Audit-write failure
    // is exactly the kind of failure that needs visibility, not silence.
    console.error('[RemoteSession] audit write failed:', e instanceof Error ? e.message : e, 'event=', event);
  }
}

export function readRecentSessions(limit = 50): any[] {
  try {
    const lines = fs.readFileSync(auditFile(), 'utf8').trim().split('\n');
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
type EndReason = 'user_ended' | 'idle' | 'disconnect' | 'replaced' | 'denied' | 'error';

export class RemoteSession extends EventEmitter {
  private indicator: BrowserWindow | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private active = false;
  private startedAt = 0;
  public readonly id = Math.random().toString(36).slice(2, 10);

  constructor(public readonly deviceId: string, public readonly deviceName: string) {
    super();
  }

  /** Show native dialog, return true if user granted control. */
  async requestConsent(): Promise<boolean> {
    const safeName = this.deviceName.slice(0, 80);
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Remote control request',
      message: `Allow "${safeName}" to control this Mac?`,
      detail:
        'The remote device will see your screen and can move the mouse, type, ' +
        'and run commands you allow. You can end the session at any time from ' +
        'the red banner in the corner of your screen.',
      buttons: ['Deny', 'Allow for this session'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    const granted = response === 1;
    if (!granted) {
      audit({ type: 'denied', deviceId: this.deviceId, deviceName: this.deviceName });
      this.emit('denied');
    }
    return granted;
  }

  /** Activate the session and show the indicator window. */
  begin() {
    if (this.active) return;
    this.active = true;
    this.startedAt = Date.now();
    this.showIndicator();
    this.resetIdleTimer();
    audit({
      type: 'started',
      sessionId: this.id,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
    });
    this.emit('started');
  }

  /** Caller must invoke this whenever an input event is processed. */
  touch() {
    if (!this.active) return;
    this.resetIdleTimer();
  }

  end(reason: EndReason = 'user_ended') {
    if (!this.active) return;
    this.active = false;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.indicator && !this.indicator.isDestroyed()) this.indicator.destroy();
    this.indicator = null;
    const duration = Date.now() - this.startedAt;
    audit({
      type: 'ended',
      sessionId: this.id,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      durationMs: duration,
      reason,
    });
    this.emit('ended', reason);
  }

  isActive() { return this.active; }

  private resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.end('idle'), 10 * 60 * 1000);
  }

  private showIndicator() {
    // Place the banner on the display under the user's cursor — robust for
    // multi-display setups where the primary display may not be where the
    // user is currently looking.
    const cursor = electronScreen.getCursorScreenPoint();
    const display = electronScreen.getDisplayNearestPoint(cursor) || electronScreen.getPrimaryDisplay();
    const safeName = this.deviceName.replace(/[<>&"']/g, '');
    const W = 340, H = 72;
    // Use bounds (not workArea) so the position is consistent across displays
    // regardless of menu-bar/dock-presence differences. Offset 40px from top to
    // clear the notch / Dynamic Island on built-in displays.
    const x = display.bounds.x + display.bounds.width - W - 20;
    const y = display.bounds.y + 40;
    const html = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif;background:linear-gradient(135deg,#dc2626 0%,#991b1b 100%);color:white;border-radius:14px;overflow:hidden;height:100vh;box-sizing:border-box;">
<div style="
  padding:14px 16px;
  display:flex;align-items:center;justify-content:space-between;gap:12px;
  -webkit-app-region:drag;user-select:none;height:100%;box-sizing:border-box;">
  <div style="display:flex;align-items:center;gap:11px;min-width:0;">
    <div class="pulse" style="width:11px;height:11px;border-radius:50%;background:#fff;flex-shrink:0;"></div>
    <div style="min-width:0;">
      <div style="font-weight:600;font-size:13px;letter-spacing:.2px;">
        Remote control active
      </div>
      <div style="opacity:.85;font-size:11px;white-space:nowrap;
        overflow:hidden;text-overflow:ellipsis;max-width:180px;">
        ${safeName}
      </div>
    </div>
  </div>
  <button id="end" style="-webkit-app-region:no-drag;
    background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.2);
    color:white;padding:8px 14px;border-radius:8px;cursor:pointer;
    font-weight:600;font-size:12px;font-family:inherit;
    transition:background .15s;">End</button>
</div>
<style>
  @keyframes pulse { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:.55; transform:scale(.85); } }
  .pulse { animation:pulse 1.4s ease-in-out infinite; }
  button:hover { background:rgba(0,0,0,.55) !important; }
</style>
<script>
  const { ipcRenderer } = require('electron');
  document.getElementById('end').addEventListener('click', () => {
    ipcRenderer.send('henry:remote:end', '${this.id}');
  });
</script>
</body></html>`;
    // R2-Fix B1: previously transparent:true + focusable:false rendered as an
    // invisible window on macOS Sonoma+. Solid red background (matching the
    // gradient's start color) + visible window class + explicit show() on
    // ready-to-show makes the banner reliably appear.
    this.indicator = new BrowserWindow({
      width: W, height: H,
      x, y,
      alwaysOnTop: true,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      closable: false,
      skipTaskbar: false,
      hasShadow: true,
      backgroundColor: '#dc2626',
      show: false, // we'll show explicitly on ready-to-show
      webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false },
    });
    this.indicator.setAlwaysOnTop(true, 'screen-saver');
    this.indicator.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.indicator.once('ready-to-show', () => {
      if (this.indicator && !this.indicator.isDestroyed()) {
        this.indicator.show();
        this.indicator.moveTop();
      }
    });
    this.indicator.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  }
}

// ---------------------------------------------------------------------------
// Global session registry — one active controller at a time.
// ---------------------------------------------------------------------------
let active: RemoteSession | null = null;
let ipcWired = false;

function wireIpc() {
  if (ipcWired) return;
  ipcWired = true;
  ipcMain.on('henry:remote:end', (_e, sessionId: string) => {
    try {
      if (active && active.id === sessionId) active.end('user_ended');
    } catch { /* never let a fire-and-forget handler throw uncaught */ }
  });
}

/** Request a session. Prompts the user; resolves null if denied/busy. */
// R2-Fix 6: previously two near-simultaneous /companion/session/request
// calls could both pass the `active?.isActive()` check (because both await
// requestConsent before either set `active`), spawn two consent dialogs,
// and the second-approved session would silently overwrite the first.
// _pendingConsent is set synchronously before the await, so the second
// caller short-circuits to "busy".
let _pendingConsent = false;
export async function requestSession(
  deviceId: string,
  deviceName: string,
): Promise<RemoteSession | null> {
  wireIpc();
  if (active?.isActive() || _pendingConsent) {
    return null;
  }
  _pendingConsent = true;
  try {
    const s = new RemoteSession(deviceId, deviceName);
    const ok = await s.requestConsent();
    if (!ok) return null;
    // Re-check active after the await — somebody else might have raced in
    // and won the consent dialog while we were awaiting (defense in depth
    // against the same dialog being spawned from another code path).
    if (active?.isActive()) return null;
    active = s;
    s.begin();
    s.on('ended', () => { if (active === s) active = null; });
    return s;
  } finally {
    _pendingConsent = false;
  }
}

/** For HTTP control endpoints: returns the active session if the given
 *  deviceId owns it, else null. */
export function getActiveSessionFor(deviceId: string): RemoteSession | null {
  if (active?.isActive() && active.deviceId === deviceId) return active;
  return null;
}

export function getActiveSession(): RemoteSession | null {
  return active?.isActive() ? active : null;
}

export function endActiveSession(reason: EndReason = 'user_ended') {
  active?.end(reason);
}
