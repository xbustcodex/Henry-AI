// electron/ipc/companionAuth.ts
// PIN-based pairing + JWT issuance for the Henry companion.
// Locks down /companion/* and /screen routes so the Cloudflare tunnel
// is no longer an open door.
//
// Storage: ~/Library/Application Support/henry-ai-desktop/pairing.json
//          ~/Library/Application Support/henry-ai-desktop/.jwt-secret

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

// ---------------------------------------------------------------------------
// Tiny JWT (HS256) — avoids adding the `jsonwebtoken` dep.
// ---------------------------------------------------------------------------
const b64url = (b: Buffer) =>
  b.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

// R3-Fix 1: JWT lifetime extended from 24h to 30 days. The whole point of the
// PIN-pair handshake is the brief, attended consent moment — after that the
// device is trusted (revocable via /sync/unpair). Forcing a re-pair every day
// was friction without a real security gain: a JWT thief and an unpair are
// the only failure modes and unpair-on-Mac handles both regardless of TTL.
function jwtSign(payload: object, secret: string, expSeconds = 60 * 60 * 24 * 30): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + expSeconds };
  const h = b64url(Buffer.from(JSON.stringify(header)));
  const p = b64url(Buffer.from(JSON.stringify(body)));
  const sig = b64url(crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

function jwtVerify(token: string, secret: string): any {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('bad_token');
  const [h, p, sig] = parts;
  const expected = b64url(crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest());
  // Constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('bad_sig');
  const payload = JSON.parse(Buffer.from(p, 'base64').toString());
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('expired');
  return payload;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
interface PairedDevice {
  name: string;
  pairedAt: number;
  lastSeen: number;
  scope: ('view' | 'control' | 'exec')[];
}

interface AuthState {
  henryId: string;                                // stable 9-digit
  unattendedHash?: string;                        // optional sha256 of password
  sessionPin?: string;                            // rotating 6-digit
  pinExpires?: number;
  pairedDevices: Record<string, PairedDevice>;
  revoked: string[];                              // deviceIds that were unpaired
}

let _state: AuthState | null = null;
let _secret: string | null = null;

function authFile() {
  return path.join(app.getPath('userData'), 'pairing.json');
}
function secretFile() {
  return path.join(app.getPath('userData'), '.jwt-secret');
}

function loadState(): AuthState {
  if (_state) return _state;
  try {
    _state = JSON.parse(fs.readFileSync(authFile(), 'utf8'));
    // Migrate old shape
    if (!_state!.revoked) _state!.revoked = [];
    return _state!;
  } catch {
    _state = {
      henryId: crypto.randomInt(100_000_000, 999_999_999).toString(),
      pairedDevices: {},
      revoked: [],
    };
    saveState();
    return _state;
  }
}

function saveState() {
  if (!_state) return;
  fs.mkdirSync(path.dirname(authFile()), { recursive: true });
  fs.writeFileSync(authFile(), JSON.stringify(_state, null, 2), { mode: 0o600 });
}

function getSecret(): string {
  if (_secret) return _secret;
  try {
    _secret = fs.readFileSync(secretFile(), 'utf8');
    return _secret!;
  } catch {
    _secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFile(), _secret, { mode: 0o600 });
    return _secret;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function getHenryId(): string {
  return loadState().henryId;
}

export function getCurrentPin(): { pin: string; expiresAt: number } {
  const s = loadState();
  if (!s.sessionPin || (s.pinExpires ?? 0) < Date.now()) {
    rotateSessionPin();
  }
  return { pin: s.sessionPin!, expiresAt: s.pinExpires! };
}

export function rotateSessionPin(): string {
  const s = loadState();
  s.sessionPin = crypto.randomInt(100_000, 999_999).toString();
  s.pinExpires = Date.now() + 30 * 60 * 1000; // 30 min
  saveState();
  return s.sessionPin;
}

export function setUnattendedPassword(pw: string | null): boolean {
  const s = loadState();
  if (pw === null || pw === '') {
    delete s.unattendedHash;
  } else {
    if (pw.length < 8) return false;
    s.unattendedHash = crypto.createHash('sha256').update(pw).digest('hex');
  }
  saveState();
  return true;
}

export function listPairedDevices() {
  const s = loadState();
  return Object.entries(s.pairedDevices).map(([id, d]) => ({ id, ...d }));
}

export function unpairDevice(deviceId: string) {
  const s = loadState();
  if (s.pairedDevices[deviceId]) {
    delete s.pairedDevices[deviceId];
    if (!s.revoked.includes(deviceId)) s.revoked.push(deviceId);
    saveState();
  }
}

// ---------------------------------------------------------------------------
// Rate limiting (per-IP, brute-force protection on /pair)
// ---------------------------------------------------------------------------
// R3-Fix 5: Map was unbounded. A scanner that never pairs successfully
// would have grown the map indefinitely. Now bounded with a soft cap + a
// lazy TTL sweep (entries with `until` more than an hour past, AND entries
// with no recent activity, are removed).
const attempts = new Map<string, { count: number; until: number; lastFailMs: number }>();
const ATTEMPTS_MAX = 500;
const ATTEMPTS_STALE_MS = 60 * 60 * 1000; // 1 hour

function _sweepAttempts() {
  const now = Date.now();
  for (const [ip, r] of attempts) {
    // Drop entries whose lockout has expired AND haven't seen activity in 1h.
    if (r.until <= now && now - r.lastFailMs > ATTEMPTS_STALE_MS) {
      attempts.delete(ip);
    }
  }
  // Hard cap: if still too big, drop the oldest by lastFailMs.
  if (attempts.size > ATTEMPTS_MAX) {
    const sorted = Array.from(attempts.entries()).sort((a, b) => a[1].lastFailMs - b[1].lastFailMs);
    const toDrop = sorted.slice(0, attempts.size - ATTEMPTS_MAX);
    for (const [ip] of toDrop) attempts.delete(ip);
  }
}

export function canAttempt(ip: string): boolean {
  const r = attempts.get(ip);
  return !r || r.until <= Date.now();
}

export function recordFail(ip: string): void {
  const now = Date.now();
  const r = attempts.get(ip) ?? { count: 0, until: 0, lastFailMs: now };
  r.count++;
  r.lastFailMs = now;
  if (r.count >= 5) {
    r.until = now + 15 * 60 * 1000;
    r.count = 0;
  }
  attempts.set(ip, r);
  // Lazy sweep — cheap and only runs alongside actual fails.
  if (attempts.size > ATTEMPTS_MAX || Math.random() < 0.05) _sweepAttempts();
}

export function clearFails(ip: string): void {
  attempts.delete(ip);
}

// ---------------------------------------------------------------------------
// Pairing + token verification
// ---------------------------------------------------------------------------
function verifyPin(pin: string): boolean {
  const s = loadState();
  const sessionOk =
    !!s.sessionPin && pin === s.sessionPin && (s.pinExpires ?? 0) > Date.now();
  if (sessionOk) return true;
  if (s.unattendedHash) {
    const h = crypto.createHash('sha256').update(pin).digest('hex');
    // Constant-time
    if (Buffer.from(h).length === Buffer.from(s.unattendedHash).length &&
        crypto.timingSafeEqual(Buffer.from(h), Buffer.from(s.unattendedHash))) {
      return true;
    }
  }
  return false;
}

export interface PairResult {
  ok: boolean;
  token?: string;
  henryId?: string;
  scope?: string[];
  error?: string;
}

export function pair(opts: {
  ip: string;
  id: string;
  pin: string;
  deviceId?: string;
  deviceName?: string;
}): PairResult {
  if (!canAttempt(opts.ip)) return { ok: false, error: 'locked_out' };
  const s = loadState();
  if (opts.id !== s.henryId) {
    recordFail(opts.ip);
    return { ok: false, error: 'bad_id' };
  }
  if (!verifyPin(opts.pin)) {
    recordFail(opts.ip);
    return { ok: false, error: 'bad_pin' };
  }
  clearFails(opts.ip);
  const deviceId = opts.deviceId || crypto.randomUUID();
  const scope: PairedDevice['scope'] = ['view', 'control', 'exec'];
  s.pairedDevices[deviceId] = {
    name: opts.deviceName || 'Unknown device',
    pairedAt: s.pairedDevices[deviceId]?.pairedAt ?? Date.now(),
    lastSeen: Date.now(),
    scope,
  };
  saveState();
  const token = jwtSign({ deviceId, name: s.pairedDevices[deviceId].name, scope }, getSecret());
  // Rotate the session PIN immediately on success so the same code can't be reused
  if (s.sessionPin) rotateSessionPin();
  return { ok: true, token, henryId: s.henryId, scope };
}

export interface VerifiedSession {
  deviceId: string;
  name: string;
  scope: string[];
}

export function verifyAuthHeader(authHeader: string | undefined): VerifiedSession | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    const payload = jwtVerify(m[1], getSecret());
    const s = loadState();
    if (s.revoked.includes(payload.deviceId)) return null;
    if (!s.pairedDevices[payload.deviceId]) return null;
    // Touch lastSeen (cheap, not flushed every request)
    s.pairedDevices[payload.deviceId].lastSeen = Date.now();
    return { deviceId: payload.deviceId, name: payload.name, scope: payload.scope };
  } catch {
    return null;
  }
}

export function verifyTokenString(token: string | undefined): VerifiedSession | null {
  if (!token) return null;
  return verifyAuthHeader(`Bearer ${token}`);
}
