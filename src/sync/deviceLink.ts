/**
 * Henry Companion — Device Pairing
 *
 * Mobile side: handles scanning the pairing QR code (or entering the code
 * manually), completing the handshake, and storing the connection config.
 *
 * Desktop side: the actual pairing server lives in electron/ipc/syncBridge.ts.
 */

import type {
  PairRequest,
  PairResponse,
  CompanionConnectionConfig,
} from './types';
import { saveConnectionConfig, clearConnectionConfig } from './syncClient';
import { platform, getAppleHandsetProduct } from '../capacitor';
import { Capacitor } from '@capacitor/core';

// ── Pair code parsing ──────────────────────────────────────────────────────

export interface ParsedPairCode {
  host: string;
  port: number;
  pairToken: string;
  relayUrl?: string;
}

/** Parse a QR payload string or a manually-typed short code.
 *
 * QR format: JSON {"h":"192.168.x.x","p":4242,"t":"TOKEN","r":"https://..."}
 * Manual format: "192.168.x.x:4242:TOKEN"
 */
export function parsePairCode(raw: string): ParsedPairCode | null {
  const trimmed = raw.trim();

  // Try JSON (QR code path)
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if (!obj.h || !obj.p || !obj.t) return null;
      return {
        host: String(obj.h),
        port: Number(obj.p),
        pairToken: String(obj.t),
        relayUrl: obj.r ? String(obj.r) : undefined,
      };
    } catch {
      return null;
    }
  }

  // Try colon-delimited manual entry: "host:port:token"
  const parts = trimmed.split(':');
  if (parts.length >= 3) {
    const port = Number(parts[1]);
    if (isNaN(port) || port < 1 || port > 65535) return null;
    return {
      host: parts[0],
      port,
      pairToken: parts.slice(2).join(':'),
    };
  }

  return null;
}

/** Build the JSON payload that gets encoded into the QR code on the desktop. */
export function buildPairCodePayload(
  host: string,
  port: number,
  pairToken: string,
  relayUrl?: string
): string {
  // QR code must be a real URL so iPhone Safari opens it directly
  const base = relayUrl || `http://${host}:${port}`;
  return `${base}/?token=${pairToken}`;
}

// ── Pairing handshake ──────────────────────────────────────────────────────

function deviceName(): string {
  const p = Capacitor.getPlatform();
  if (p === 'ios') {
    const kind = getAppleHandsetProduct();
    return kind === 'ipad' ? 'iPad' : 'iPhone';
  }
  if (p === 'android') return 'Android';
  return 'Mobile';
}

/** Complete the pairing handshake with the desktop.
 *
 * Sends the pair token to the desktop, which validates it and returns
 * a long-lived companion token. Stores the resulting config to localStorage.
 */
export async function completePairing(
  parsed: ParsedPairCode,
  opts: { deviceName?: string; pushToken?: string } = {}
): Promise<CompanionConnectionConfig> {
  const baseUrl = `http://${parsed.host}:${parsed.port}`;

  const body: PairRequest = {
    pairToken: parsed.pairToken,
    deviceName: opts.deviceName ?? deviceName(),
    platform: platform,
    pushToken: opts.pushToken,
    appleProduct: platform === 'ios' ? getAppleHandsetProduct() : undefined,
  };

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 10000);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/sync/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Pairing failed' })) as { error?: string };
    throw new Error(err.error ?? `Pairing failed (${res.status})`);
  }

  const data = (await res.json()) as PairResponse;

  const config: CompanionConnectionConfig = {
    host: parsed.host,
    port: parsed.port,
    token: data.companionToken,
    deviceId: data.deviceId,
    desktopName: data.desktopName,
    pairedAt: new Date().toISOString(),
    useRelay: false,
    relayUrl: parsed.relayUrl,
  };

  saveConnectionConfig(config);
  return config;
}

/** Remove all pairing data (unlink from desktop). */
export function unlinkDevice(): void {
  clearConnectionConfig();
}

// ── Relay upgrade ──────────────────────────────────────────────────────────

/** Try to enable cloud relay after LAN pairing.
 *  The relay URL must be configured in the desktop settings first.
 */
export function enableRelay(
  config: CompanionConnectionConfig,
  relayUrl: string
): CompanionConnectionConfig {
  const updated: CompanionConnectionConfig = { ...config, useRelay: true, relayUrl };
  saveConnectionConfig(updated);
  return updated;
}

export function disableRelay(
  config: CompanionConnectionConfig
): CompanionConnectionConfig {
  const updated: CompanionConnectionConfig = { ...config, useRelay: false };
  saveConnectionConfig(updated);
  return updated;
}
