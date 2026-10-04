// @vitest-environment jsdom
/**
 * First-run detection.
 *
 * The failure this guards is specific: on the machine that developed Henry,
 * setup was already "done" because configuration existed, so a fresh install
 * could reach the same conclusion for the same reason and walk straight past
 * setup. The verdict must therefore come from a marker the flow writes, and a
 * profile must be re-gated only when NOTHING about it has ever been configured.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  FIRST_RUN_KEY,
  FIRST_RUN_SETTING,
  isFreshProfile,
  shouldGateOnSetup,
  markFirstRunComplete,
  clearFirstRunMarker,
} from './firstRun';

beforeEach(() => {
  localStorage.clear();
});

describe('a profile that has never been configured', () => {
  it('is fresh when every signal is empty', () => {
    expect(isFreshProfile({
      marker: null,
      settings: {},
      providers: [],
      conversations: [],
      workspacePresent: false,
    })).toBe(true);
  });

  it('is fresh when the signals are not supplied at all', () => {
    expect(isFreshProfile({})).toBe(true);
  });

  it('is fresh when settings hold only untouched defaults', () => {
    // A brand-new database used to be seeded with exactly these rows. Defaults
    // are not decisions, and must not be able to answer "already set up".
    expect(isFreshProfile({
      settings: {
        setup_complete: 'false',
        theme: 'dark',
        companion_model: '',
        companion_provider: '',
        worker_model: '',
        worker_provider: '',
        default_temperature: '0.7',
        workspace_path: '',
      },
      providers: [],
    })).toBe(true);
  });
});

describe('a profile that belongs to somebody', () => {
  it('is not fresh once setup has completed', () => {
    expect(isFreshProfile({ settings: { setup_complete: 'true' } })).toBe(false);
  });

  it('is not fresh once the first-run marker exists in localStorage', () => {
    expect(isFreshProfile({ marker: 'true' })).toBe(false);
  });

  it('is not fresh once the first-run marker exists in the database', () => {
    expect(isFreshProfile({ settings: { [FIRST_RUN_SETTING]: 'true' } })).toBe(false);
  });

  it('is not fresh once Henry has spoken to a configured user', () => {
    // Even the cleared 'false' value counts: the flag existing at all means
    // this profile already had a working provider behind it.
    expect(isFreshProfile({ settings: { henry_first_launch: 'false' } })).toBe(false);
  });

  it('is not fresh when a provider row holds a credential', () => {
    expect(isFreshProfile({ providers: [{ id: 'openrouter', apiKey: 'sk-or-user-key' }] })).toBe(false);
  });

  it('is not fresh when a credentialed provider row exists in snake_case form', () => {
    expect(isFreshProfile({ providers: [{ id: 'openrouter', api_key: 'sk-or-user-key' }] })).toBe(false);
  });

  it('is still fresh for a keyless local row, because that is not a credential', () => {
    expect(isFreshProfile({ providers: [{ id: 'ollama', api_key: '', enabled: true }] })).toBe(true);
  });

  it('is not fresh once there is a conversation', () => {
    expect(isFreshProfile({ conversations: [{ id: 'c1' }] })).toBe(false);
  });

  it('is not fresh once a workspace has been indexed', () => {
    expect(isFreshProfile({ workspacePresent: true })).toBe(false);
  });

  it('never re-gates a profile that already has configuration, even with no marker', () => {
    const fresh = isFreshProfile({ settings: { setup_complete: 'true' } });
    expect(shouldGateOnSetup({ fresh, completedThisSession: false })).toBe(false);
  });
});

describe('the gate', () => {
  it('gates a fresh profile', () => {
    expect(shouldGateOnSetup({ fresh: true, completedThisSession: false })).toBe(true);
  });

  it('does not re-gate within the session that just ran setup', () => {
    expect(shouldGateOnSetup({ fresh: true, completedThisSession: true })).toBe(false);
  });

  it('does not gate a configured profile', () => {
    expect(shouldGateOnSetup({ fresh: false, completedThisSession: false })).toBe(false);
  });
});

describe('the marker', () => {
  it('is written to localStorage synchronously and mirrored to the database', () => {
    const saveSetting = vi.fn(async () => true);
    window.henryAPI = { saveSetting } as unknown as typeof window.henryAPI;

    markFirstRunComplete();

    expect(localStorage.getItem(FIRST_RUN_KEY)).toBe('true');
    expect(saveSetting).toHaveBeenCalledWith(FIRST_RUN_SETTING, 'true');
  });

  it('is cleared when the user explicitly reopens setup', () => {
    localStorage.setItem(FIRST_RUN_KEY, 'true');
    clearFirstRunMarker();
    expect(localStorage.getItem(FIRST_RUN_KEY)).toBeNull();
  });

  it('survives a renderer with no bridge at all', () => {
    delete (window as Partial<Window>).henryAPI;
    expect(() => markFirstRunComplete()).not.toThrow();
    expect(localStorage.getItem(FIRST_RUN_KEY)).toBe('true');
  });
});