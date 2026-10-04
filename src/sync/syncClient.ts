/**
 * Henry Companion Sync Client
 *
 * Runs on mobile (Capacitor) and connects to the desktop sync server
 * (or cloud relay as fallback). Handles:
 *   - Connecting / reconnecting
 *   - Fetching snapshots
 *   - Sending captures (voice, text, photo, file)
 *   - Sending action decisions (approve / reject)
 *   - Receiving real-time updates via Server-Sent Events (SSE)
 */

import type {
  CompanionConnectionConfig,
  CompanionConnectionStatus,
  SyncSnapshot,
  SyncEvent,
  CapturePayload,
  CaptureResult,
  ActionDecision,
  SyncNotification,
  DeviceInfo,
} from './types';

const LS_CONFIG_KEY = 'henry:companion:config';
const LS_SNAPSHOT_KEY = 'henry:companion:snapshot';

// ── Config storage ─────────────────────────────────────────────────────────

export function loadConnectionConfig(): CompanionConnectionConfig | null {
  try {
    const raw = localStorage.getItem(LS_CONFIG_KEY);
    return raw ? (JSON.parse(raw) as CompanionConnectionConfig) : null;
  } catch {
    return null;
  }
}

export function saveConnectionConfig(config: CompanionConnectionConfig): void {
  try {
    localStorage.setItem(LS_CONFIG_KEY, JSON.stringify(config));
  } catch { /* ignore */ }
}

export function clearConnectionConfig(): void {
  try {
    localStorage.removeItem(LS_CONFIG_KEY);
    localStorage.removeItem(LS_SNAPSHOT_KEY);
  } catch { /* ignore */ }
}

export function loadCachedSnapshot(): SyncSnapshot | null {
  try {
    const raw = localStorage.getItem(LS_SNAPSHOT_KEY);
    return raw ? (JSON.parse(raw) as SyncSnapshot) : null;
  } catch {
    return null;
  }
}

function cacheSnapshot(snap: SyncSnapshot): void {
  try {
    localStorage.setItem(LS_SNAPSHOT_KEY, JSON.stringify(snap));
  } catch { /* ignore */ }
}

// ── URL builder ────────────────────────────────────────────────────────────

function baseUrl(config: CompanionConnectionConfig): string {
  if (config.useRelay && config.relayUrl) {
    return config.relayUrl.replace(/\/$/, '');
  }
  return `http://${config.host}:${config.port}`;
}

function authHeaders(config: CompanionConnectionConfig): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-Henry-Token': config.token,
    'X-Henry-Device': config.deviceId,
  };
}

// ── Core HTTP helpers ──────────────────────────────────────────────────────

async function get<T>(
  config: CompanionConnectionConfig,
  path: string,
  timeout = 8000
): Promise<T> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${baseUrl(config)}${path}`, {
      method: 'GET',
      headers: authHeaders(config),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(tid);
  }
}

async function post<T>(
  config: CompanionConnectionConfig,
  path: string,
  body: unknown,
  timeout = 12000
): Promise<T> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${baseUrl(config)}${path}`, {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(tid);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Check whether the desktop is reachable. */
export async function pingDesktop(config: CompanionConnectionConfig): Promise<boolean> {
  try {
    await get<{ ok: boolean }>(config, '/sync/health', 4000);
    return true;
  } catch {
    return false;
  }
}

/** Fetch a full snapshot from the desktop. */
export async function fetchSnapshot(
  config: CompanionConnectionConfig
): Promise<SyncSnapshot> {
  const snap = await get<SyncSnapshot>(config, '/sync/snapshot');
  cacheSnapshot(snap);
  return snap;
}

/** Fetch only deltas since a given timestamp. */
export async function fetchEvents(
  config: CompanionConnectionConfig,
  since: number
): Promise<SyncEvent[]> {
  return get<SyncEvent[]>(config, `/sync/events?since=${since}`);
}

/** Fetch messages for a specific conversation. */
export async function fetchMessages(
  config: CompanionConnectionConfig,
  conversationId: string
) {
  return get<unknown[]>(config, `/sync/conversations/${conversationId}`);
}

/** Linked devices as seen by the desktop sync server (same token scope). */
export async function fetchLinkedDevices(
  config: CompanionConnectionConfig
): Promise<DeviceInfo[]> {
  return get<DeviceInfo[]>(config, '/sync/devices');
}

/** Send a text/voice/photo/file capture to the desktop. */
export async function sendCapture(
  config: CompanionConnectionConfig,
  capture: CapturePayload
): Promise<CaptureResult> {
  return post<CaptureResult>(config, '/sync/capture', capture);
}

/** Send a text prompt to be processed by Henry on the desktop. */
export async function sendPrompt(
  config: CompanionConnectionConfig,
  opts: {
    text: string;
    conversationId?: string;
    contextNote?: string;
  }
) {
  return post(config, '/sync/prompt', opts);
}

/** Approve or reject a pending action. */
export async function sendActionDecision(
  config: CompanionConnectionConfig,
  decision: ActionDecision
): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>(
    config,
    `/sync/actions/${decision.actionId}/decide`,
    decision
  );
}

/** Register / update push token on desktop. */
export async function registerPushToken(
  config: CompanionConnectionConfig,
  pushToken: string
): Promise<void> {
  await post(config, '/sync/push-token', {
    deviceId: config.deviceId,
    pushToken,
  }).catch(() => { /* best effort */ });
}

// ── SSE Real-time stream ───────────────────────────────────────────────────

export type SyncEventHandler = (event: SyncEvent) => void;
export type StatusChangeHandler = (status: CompanionConnectionStatus) => void;

export class SyncStream {
  private config: CompanionConnectionConfig;
  private es: EventSource | null = null;
  private onEvent: SyncEventHandler;
  private onStatus: StatusChangeHandler;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 3000;
  private stopped = false;

  constructor(
    config: CompanionConnectionConfig,
    onEvent: SyncEventHandler,
    onStatus: StatusChangeHandler
  ) {
    this.config = config;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    this.onStatus('disconnected');
  }

  updateConfig(config: CompanionConnectionConfig) {
    this.config = config;
    this.stop();
    this.stopped = false;
    this.connect();
  }

  private connect() {
    if (this.stopped) return;
    this.onStatus('connecting');

    const url =
      `${baseUrl(this.config)}/sync/stream` +
      `?token=${encodeURIComponent(this.config.token)}` +
      `&device=${encodeURIComponent(this.config.deviceId)}`;

    try {
      this.es = new EventSource(url);

      this.es.onopen = () => {
        this.reconnectDelay = 3000;
        this.onStatus('connected');
      };

      this.es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as SyncEvent;
          this.onEvent(event);
        } catch { /* ignore malformed events */ }
      };

      this.es.onerror = () => {
        this.es?.close();
        this.es = null;
        this.onStatus('disconnected');
        if (!this.stopped) this.scheduleReconnect();
      };
    } catch {
      this.onStatus('error');
      if (!this.stopped) this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
      this.connect();
    }, this.reconnectDelay);
  }
}

// ── Singleton stream management ────────────────────────────────────────────

let _stream: SyncStream | null = null;
let _statusHandler: StatusChangeHandler | null = null;
let _eventHandler: SyncEventHandler | null = null;

export function initSyncStream(
  config: CompanionConnectionConfig,
  onEvent: SyncEventHandler,
  onStatus: StatusChangeHandler
): void {
  _eventHandler = onEvent;
  _statusHandler = onStatus;

  if (_stream) {
    _stream.stop();
  }
  _stream = new SyncStream(config, onEvent, onStatus);
  _stream.start();
}

export function stopSyncStream(): void {
  _stream?.stop();
  _stream = null;
}

export function refreshSyncStream(config: CompanionConnectionConfig): void {
  if (_stream && _eventHandler && _statusHandler) {
    _stream.updateConfig(config);
  } else if (_eventHandler && _statusHandler) {
    _stream = new SyncStream(config, _eventHandler, _statusHandler);
    _stream.start();
  }
}
