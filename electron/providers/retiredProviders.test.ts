/**
 * Provider retirement — the seam between "Henry removed a provider" and "an
 * install that still has one behaves sanely".
 *
 * Removing Groq left three things it had to get right, and each is a way a user
 * loses their setup silently if it is wrong:
 *
 *   - the leftover `providers` row, holding a live credential that must stop
 *     being read and must never appear in a log;
 *   - the leftover `companion_provider=groq` selection, which used to drive a
 *     fallback loop and ask for a key the user had already given;
 *   - the boundary itself — a retired id that reaches execution has to fail
 *     with "no longer available", not answer from somewhere else.
 *
 * The classification assertions live here too rather than in
 * `classification.test.ts`: retiring a provider must not disturb the gating
 * rules for the providers that remain, and `opencode-zen` must stay
 * credential-optional (free Zen models run unauthenticated — a key only widens
 * the catalogue).
 */
import { describe, it, expect } from 'vitest';
import {
  RETIRED_PROVIDER_IDS,
  RETIRED_PROVIDER_UNAVAILABLE_MESSAGE,
  isRetiredProviderId,
  migrateRetiredProviders,
  retiredProviderError,
  retiredProviderUnavailableMessage,
  type RetiredProviderMigrationDb,
} from './retiredProviders';
import { requiresApiKey } from './classification';

// ── A minimal in-memory SQLite stand-in ────────────────────────────────

interface ProviderRow {
  id: string;
  name: string;
  api_key: string;
  enabled: number;
}
interface SettingRow {
  key: string;
  value: string;
}

/**
 * Records every statement it is handed, so a test can assert on what the
 * migration *looked at* — the only way to prove a credential column is never
 * read. The real thing runs against better-sqlite3 at boot.
 */
function fakeDb(options: { providers?: boolean; settings?: boolean } = {}) {
  const providers = new Map<string, ProviderRow>();
  const settings = new Map<string, string>();
  const statements: string[] = [];
  const tableExists = new Map<string, boolean>();
  if (options.providers !== false) tableExists.set('providers', true);
  if (options.settings !== false) tableExists.set('settings', true);

  const db: RetiredProviderMigrationDb = {
    prepare(sql: string) {
      statements.push(sql);
      const lowered = sql.toLowerCase();
      return {
        get(...params: unknown[]) {
          if (lowered.includes('sqlite_master')) {
            const name = String(params[0]);
            return tableExists.get(name) ? { name } : undefined;
          }
          return undefined;
        },
        run(...params: unknown[]) {
          if (lowered.includes('delete from providers')) {
            for (const id of params.map(String)) providers.delete(id);
          }
          if (lowered.includes('update settings')) {
            settings.set(String(params[0]), '');
          }
          return undefined;
        },
        all(...params: unknown[]) {
          if (lowered.includes('from providers')) {
            return [...providers.values()].map((row) => ({ id: row.id }));
          }
          if (lowered.includes('from settings')) {
            return [...settings.entries()].map(([key, value]) => ({ key, value }));
          }
          return [];
        },
      };
    },
  };
  return { db, providers, settings, statements };
}

function seedGroqInstall() {
  const store = fakeDb();
  // Obviously fake credential — the migration must never see its value, and the
  // shape only matters for proving it is not read or echoed.
  store.providers.set('groq', {
    id: 'groq',
    name: 'Groq',
    api_key: 'gsk_FAKE_TEST_KEY_000000000',
    enabled: 1,
  });
  store.providers.set('opencode-zen', {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    api_key: 'enc:v1:not-a-real-secret',
    enabled: 1,
  });
  store.settings.set('companion_provider', 'groq');
  store.settings.set('worker_provider', 'groq');
  store.settings.set('chat_fast_provider', 'opencode-zen');
  return store;
}

// ── Migration ───────────────────────────────────────────────────────────

describe('migrating a provider Henry no longer supports', () => {
  it('drops the retired provider row and blanks the selection that named it', () => {
    const { db, providers, settings } = seedGroqInstall();

    const report = migrateRetiredProviders(db);

    expect(report.removedProviderIds).toEqual(['groq']);
    expect(providers.has('groq')).toBe(false);
    expect(report.clearedSettings.sort()).toEqual(['companion_provider', 'worker_provider']);
    expect(settings.get('companion_provider')).toBe('');
    expect(settings.get('worker_provider')).toBe('');
  });

  it('leaves every supported provider and its selection intact', () => {
    const { db, providers, settings } = seedGroqInstall();

    migrateRetiredProviders(db);

    expect(providers.get('opencode-zen')?.api_key).toBe('enc:v1:not-a-real-secret');
    expect(settings.get('chat_fast_provider')).toBe('opencode-zen');
  });

  it('never reads the credential column, so the old key cannot reach a log', () => {
    const { db, statements } = seedGroqInstall();

    migrateRetiredProviders(db);

    const readCredential = statements.filter(
      (sql) => /select[\s\S]*\bapi_key\b/i.test(sql),
    );
    expect(readCredential).toEqual([]);
  });

  it('is idempotent — a second launch finds nothing left to do', () => {
    const { db } = seedGroqInstall();

    migrateRetiredProviders(db);
    const second = migrateRetiredProviders(db);

    expect(second.removedProviderIds).toEqual([]);
    expect(second.clearedSettings).toEqual([]);
  });

  it('is a no-op, not a crash, when the tables do not exist yet', () => {
    const { db } = fakeDb({ providers: false, settings: false });

    expect(migrateRetiredProviders(db)).toEqual({ removedProviderIds: [], clearedSettings: [] });
  });

  it('still clears the stale selection when only the providers table is missing', () => {
    const { db, settings } = fakeDb({ providers: false });
    settings.set('companion_provider', 'groq');

    const report = migrateRetiredProviders(db);

    expect(report.removedProviderIds).toEqual([]);
    expect(report.clearedSettings).toEqual(['companion_provider']);
  });

  it('is a no-op on a fresh install, which must arrive with no provider rows at all', () => {
    // A brand-new profile has to survive this migration untouched and empty: a
    // fresh database that arrives with a provider row would read, everywhere
    // downstream, as "this user already configured a provider".
    const { db, statements } = fakeDb();

    expect(migrateRetiredProviders(db)).toEqual({ removedProviderIds: [], clearedSettings: [] });
    expect(statements.some((sql) => /insert/i.test(sql))).toBe(false);
  });

});

// ── The retirement boundary ─────────────────────────────────────────────

describe('a retired provider selected at execution time', () => {
  it('names the provider and asks for a supported one', () => {
    expect(retiredProviderUnavailableMessage('groq')).toBe(
      `groq is no longer a supported provider. ${RETIRED_PROVIDER_UNAVAILABLE_MESSAGE}`,
    );
    expect(RETIRED_PROVIDER_UNAVAILABLE_MESSAGE).toContain(
      'previously selected provider is no longer available',
    );
  });

  it('routes nowhere: it throws rather than resolving to anything else', () => {
    const error = retiredProviderError('groq');
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('no longer');
    expect(error?.message).not.toMatch(/openai|anthropic|gemini|ollama|opencode/i);
  });

  it('leaves supported providers alone, so the guard cannot misfire', () => {
    for (const id of ['openai', 'anthropic', 'google', 'ollama', 'opencode', 'opencode-zen', 'relay', '']) {
      expect(retiredProviderError(id)).toBeNull();
      expect(isRetiredProviderId(id)).toBe(false);
    }
    expect(RETIRED_PROVIDER_IDS).toContain('groq');
  });

  it('matches the id case-insensitively, because saved rows are hand-edited', () => {
    expect(isRetiredProviderId('  GROQ ')).toBe(true);
    expect(retiredProviderUnavailableMessage('Groq')?.startsWith('groq ')).toBe(true);
  });
});

// ── Classification is unaffected by the removal ─────────────────────────

describe('gating the providers that remain', () => {
  it('still blocks an ordinary credentialed provider with no key', () => {
    for (const id of ['openai', 'anthropic', 'google', 'relay']) {
      expect(requiresApiKey({ id, name: id, api_key: '' })).toBe(true);
      expect(requiresApiKey({ id, name: id, api_key: 'fake-test-key-000' })).toBe(false);
    }
  });

  it('keeps opencode-zen credential-optional — a key widens the catalogue, it does not enable it', () => {
    expect(requiresApiKey({ id: 'opencode-zen', name: 'OpenCode Zen', api_key: '' })).toBe(false);
    expect(requiresApiKey({ id: 'opencode-zen', name: 'OpenCode Zen', api_key: '' })).toBe(false);
    expect(requiresApiKey({ id: 'opencode', name: 'OpenCode (CLI)', api_key: '' })).toBe(false);
    expect(requiresApiKey({ id: 'ollama', name: 'Ollama (Local)', api_key: '' })).toBe(false);
  });
});