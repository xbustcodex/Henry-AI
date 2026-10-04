/**
 * _keyStorage.ts — Encrypt provider API keys at rest using Electron's safeStorage.
 *
 * safeStorage uses the OS keychain on macOS (Keychain), Windows (DPAPI),
 * and a generic libsecret/kwallet bridge on Linux. Falls back to plaintext
 * with a console warning when encryption isn't available (e.g., headless CI).
 *
 * Wire format for stored values:
 *   "enc:v1:<base64-ciphertext>"  — encrypted
 *   "<anything-else>"             — legacy plaintext (auto-migrated on next save)
 *
 * Importantly: reads tolerate BOTH formats so existing user rows aren't lost
 * when this ships. Plaintext rows get re-encrypted next time the user touches
 * the provider in Settings.
 */

import { safeStorage } from 'electron';
import type Database from 'better-sqlite3';

const ENC_PREFIX = 'enc:v1:';

/**
 * Returns true when safeStorage can actually encrypt on this machine.
 * On macOS/Windows this is essentially always true. On Linux it depends
 * on whether libsecret or kwallet is available.
 */
export function canEncrypt(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** Encrypt a plaintext API key for storage. Returns plaintext if encryption isn't available. */
export function encryptKey(plaintext: string): string {
  if (!plaintext) return '';
  if (!canEncrypt()) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[keyStorage] safeStorage unavailable — API key will be stored as plaintext.');
    }
    return plaintext;
  }
  try {
    const buf = safeStorage.encryptString(plaintext);
    return ENC_PREFIX + buf.toString('base64');
  } catch (e) {
    console.error('[keyStorage] encryptString failed, storing plaintext:', e);
    return plaintext;
  }
}

/** Decrypt a stored value. Returns plaintext unchanged when the value isn't encrypted. */
export function decryptKey(stored: string | null | undefined): string {
  if (!stored) return '';
  if (!stored.startsWith(ENC_PREFIX)) {
    // Legacy plaintext — return as-is. Caller can choose to re-save to upgrade.
    return stored;
  }
  if (!canEncrypt()) {
    // Encrypted value on a machine that can't decrypt — return empty so caller
    // re-prompts the user instead of leaking the encrypted blob.
    console.error('[keyStorage] Found encrypted value but safeStorage is unavailable.');
    return '';
  }
  try {
    const b64 = stored.slice(ENC_PREFIX.length);
    const buf = Buffer.from(b64, 'base64');
    return safeStorage.decryptString(buf);
  } catch (e) {
    console.error('[keyStorage] decryptString failed:', e);
    return '';
  }
}

/** True if the given stored value is already in encrypted form. */
export function isEncrypted(stored: string | null | undefined): boolean {
  return !!stored && stored.startsWith(ENC_PREFIX);
}

/**
 * One-time startup migration: encrypt any plaintext keys already sitting in
 * the providers table. Safe to call on every launch — already-encrypted rows
 * are detected by their prefix and skipped.
 */
export function migrateProviderKeys(db: Database.Database): void {
  if (!canEncrypt()) return;
  try {
    const rows = db
      .prepare('SELECT id, api_key FROM providers')
      .all() as Array<{ id: string; api_key: string }>;
    let count = 0;
    for (const row of rows) {
      if (row.api_key && !row.api_key.startsWith(ENC_PREFIX)) {
        const encrypted = encryptKey(row.api_key);
        if (encrypted !== row.api_key) {
          db.prepare('UPDATE providers SET api_key = ? WHERE id = ?').run(encrypted, row.id);
          count++;
        }
      }
    }
    if (count > 0) {
      console.log(`[Henry] Migrated ${count} API key(s) to encrypted at-rest storage.`);
    }
  } catch (e) {
    console.error('[Henry] migrateProviderKeys failed:', e);
  }
}
