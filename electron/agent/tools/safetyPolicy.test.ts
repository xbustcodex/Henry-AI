import { describe, it, expect, vi } from 'vitest';

// The tool modules import Electron (`shell`, `safeStorage`) and the native
// better-sqlite3 addon at module top. Mock both so we can import the real tool
// DEFINITIONS in a plain Node test — we only read their declared metadata
// (name/category/safetyLevel), never execute them.
vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  app: { getPath: () => '/tmp' },
}));
vi.mock('better-sqlite3', () => ({ default: class FakeDB {} }));

import { ToolRegistry } from '../toolRegistry';
import { registerAllTools } from './index';

const reg = new ToolRegistry();
registerAllTools(reg);
const tools = reg.getAllTools();
const level = (name: string) => tools.find((t) => t.name === name)?.safetyLevel;

describe('agent tool safety policy', () => {
  it('registers a non-trivial set of tools', () => {
    expect(tools.length).toBeGreaterThanOrEqual(15);
  });

  // The crown jewels: anything that leaves the machine, spends money, or writes
  // a real-world record MUST pause for the user. If someone downgrades one of
  // these to silent/notify, this test fails loudly. These three ship in the
  // base tool set and must always be present + confirm.
  const alwaysConfirm = [
    'messages_send',         // sends an iMessage
    'email_send',            // sends an email
    'calendar_create_event', // writes a real calendar event (may sync/notify others)
  ];
  it.each(alwaysConfirm)('%s must be safetyLevel "confirm"', (name) => {
    expect(level(name), `${name} should require confirmation`).toBe('confirm');
  });

  // Tools from optional kits (web, quickbooks) — assert only when registered, so
  // the guard travels with them but the test stays green without them.
  const confirmIfPresent = [
    'qb_create_invoice', // creates a real QuickBooks invoice (money)
    'web_fetch_page',    // fetches an arbitrary URL (egress / SSRF surface)
  ];
  it.each(confirmIfPresent)('%s is confirm when registered', (name) => {
    const lvl = level(name);
    if (lvl === undefined) return; // kit not registered in this build — skip
    expect(lvl, `${name} should require confirmation`).toBe('confirm');
  });

  // Heuristic guard for FUTURE tools: anything whose name says it sends must be
  // gated. Catches a new `slack_send`/`sms_send`/etc. that forgets to confirm.
  it('every tool whose name ends in _send is confirm', () => {
    const senders = tools.filter((t) => /_send$/.test(t.name));
    expect(senders.length).toBeGreaterThan(0);
    for (const t of senders) {
      expect(t.safetyLevel, `${t.name} sends data out — must be confirm`).toBe('confirm');
    }
  });

  // Sanity: read-only tools should NOT be gated (otherwise the assistant nags
  // for every lookup). A representative sample.
  const mustNotBlock = ['memory_search', 'quote_list', 'calendar_list_events', 'email_read_recent'];
  it.each(mustNotBlock)('%s is not "confirm" (read-only)', (name) => {
    expect(level(name)).not.toBe('confirm');
  });

  it('only uses known safety levels', () => {
    const allowed = new Set(['silent', 'notify', 'confirm']);
    for (const t of tools) {
      expect(allowed.has(t.safetyLevel), `${t.name} has unknown level ${t.safetyLevel}`).toBe(true);
    }
  });
});
