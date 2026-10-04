// @vitest-environment jsdom
/**
 * "Teach Henry about you" — what the user types is actually stored.
 *
 * The defect this covers was invisible from the component: the stage rendered a
 * single button whose label flipped between "Save and continue" and "Skip", and
 * the save behind it called `saveMemoryFact`, a preload method that does not
 * exist on the bridge at all. The write was a silent no-op — the field looked
 * saved and nothing was written, on any restart.
 *
 * So this is not a component test with a stubbed bridge. It runs the real
 * renderer stage against the real main-process IPC handlers, over a real SQLite
 * file, and reads every row back out — including after the handle is closed and
 * the file is reopened, which is what "survives restart" means.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react';
import { createElement } from 'react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { useStore } from '../../../store';
import { PROFILE_FIELDS } from '../../../henry/userProfile';
import { initDatabase } from '../../../../electron/ipc/database';
import { registerMemoryHandlers } from '../../../../electron/ipc/memory';
import MemoryStage from './MemoryStage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The main process, captured rather than faked. `electron` is the only thing
 * mocked: the handlers registered below are the production ones.
 */
const handlers = new Map<string, (event: unknown, arg: unknown) => unknown>();
let dataDir = '';
import { registerSettingsHandlers } from '../../../../electron/ipc/settings';

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, arg: unknown) => unknown) => {
      if (handlers.has(channel)) throw new Error(`duplicate handler for ${channel}`);
      handlers.set(channel, fn);
    },
  },
  app: {
    getPath: () => dataDir,
    getAppPath: () => dataDir,
    getVersion: () => '0.0.0',
    isPackaged: false,
  },
  BrowserWindow: class {},
  shell: {},
  dialog: {},
  Notification: class {},
}));

// better-sqlite3 is built for Electron's ABI, so the real schema is created
// through node:sqlite instead. Same DDL, same file, same rows.
vi.mock('better-sqlite3', async () => {
  const { DatabaseSync: Sync } = await import('node:sqlite');
  class Shim {
    private inner: InstanceType<typeof Sync>;
    constructor(file: string) {
      this.inner = new Sync(file);
      this.transaction = (fn: (...args: never[]) => unknown) =>
        ((...args: never[]) => {
          this.inner.exec('BEGIN');
          try {
            const out = fn(...args);
            this.inner.exec('COMMIT');
            return out;
          } catch (error) {
            this.inner.exec('ROLLBACK');
            throw error;
          }
        }) as never;
    }
    transaction: <T extends (...args: never[]) => unknown>(fn: T) => T;
    exec(sql: string) { this.inner.exec(sql); }
    pragma() { /* WAL is an Electron-runtime concern, not an assertion here */ }
    prepare(sql: string) { return this.inner.prepare(sql); }
    close() { this.inner.close(); }
  }
  return { default: Shim };
});

type Db = ReturnType<typeof initDatabase>;

/** One real schema for the whole file — `initDatabase` costs seconds. */
let db: Db;

/** Invoke a real registered handler, the way ipcRenderer.invoke would. */
function invoke<T>(channel: string, payload: unknown): Promise<T> {
  return handlers.get(channel)!({}, payload) as Promise<T>;
}

interface StoredMemory {
  memory_key: string;
  memory_value: string;
  source: string;
}

function memories(handle: Db): StoredMemory[] {
  return handle
    .prepare('SELECT memory_key, memory_value, source FROM personal_memory ORDER BY memory_key')
    .all() as StoredMemory[];
  registerSettingsHandlers(db as never, () => null);
}

function settingsOf(handle: Db): Record<string, string> {
  const rows = handle.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'henry-profile-'));
  db = initDatabase(dataDir);
});

afterAll(() => {
  try { db.close(); } catch { /* already closed */ }
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  handlers.clear();
  registerMemoryHandlers(db as never);
  registerSettingsHandlers(db as never, () => null);
  // Every case starts from a profile with nothing in it.
  db.prepare('DELETE FROM personal_memory').run();
  db.prepare('DELETE FROM settings').run();

  // The renderer half of the bridge: the same two methods `preload.ts` exposes,
  // pointed at the handlers registered above.
  window.henryAPI = {
    saveSetting: (key: string, value: string) => invoke<boolean>('settings:save', { key, value }),
    savePersonalMemory: (item: Record<string, unknown>) =>
      invoke<{ id: string }>('memory:savePersonalMemory', item),
  } as unknown as typeof window.henryAPI;
  useStore.setState({ settings: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Fill a field the way a person does. The placeholder is never a value. */
function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function placeholders(): string[] {
  return PROFILE_FIELDS.map((field) => field.placeholder);
}

describe('a profile the user filled in', () => {
  it('stores exactly what was typed, and nothing else', async () => {
    const onNext = vi.fn();
    render(createElement(MemoryStage, { onNext, onSkip: vi.fn() }));

    type('Your name', 'Ada Lovelace');
    type('What you do', 'Analytical engine programmer');
    type('Biggest goal right now', 'Ship the difference engine');

    fireEvent.click(screen.getByText('Save & Continue →'));
    await waitFor(() => expect(onNext).toHaveBeenCalled());

    expect(memories(db)).toEqual([
      { memory_key: 'goal', memory_value: 'Ship the difference engine', source: 'onboarding' },
      { memory_key: 'name', memory_value: 'Ada Lovelace', source: 'onboarding' },
      { memory_key: 'role', memory_value: 'Analytical engine programmer', source: 'onboarding' },
    ]);
    expect(settingsOf(db)).toMatchObject({ owner_name: 'Ada Lovelace', user_name: 'Ada Lovelace' });
  });

  it('leaves the fields the user did not fill blank', async () => {
    const onNext = vi.fn();
    render(createElement(MemoryStage, { onNext, onSkip: vi.fn() }));

    type('Where you are', 'Portland, OR');
    fireEvent.click(screen.getByText('Save & Continue →'));
    await waitFor(() => expect(onNext).toHaveBeenCalled());

    expect(memories(db).map((m) => m.memory_key)).toEqual(['location']);
    expect(settingsOf(db)).toEqual({ location: 'Portland, OR' });
  });

  it('never stores the example text shown in an empty field', async () => {
    const onNext = vi.fn();
    render(createElement(MemoryStage, { onNext, onSkip: vi.fn() }));

    type('Your name', 'Grace Hopper');
    fireEvent.click(screen.getByText('Save & Continue →'));
    await waitFor(() => expect(onNext).toHaveBeenCalled());

    const stored = JSON.stringify([memories(db), settingsOf(db)]);
    for (const placeholder of placeholders()) {
      expect(stored).not.toContain(placeholder);
    }
  });

  it('is still there after a restart, because it was written to the database', async () => {
    const onNext = vi.fn();
    render(createElement(MemoryStage, { onNext, onSkip: vi.fn() }));
    type('Your name', 'Katherine Johnson');
    fireEvent.click(screen.getByText('Save & Continue →'));
    await waitFor(() => expect(onNext).toHaveBeenCalled());

    // Close the handle and open the file again: nothing left is in memory.
    db.close();
    const reopened = new DatabaseSync(path.join(dataDir, 'henry.db')) as unknown as Db;

    expect(memories(reopened)).toEqual([
      { memory_key: 'name', memory_value: 'Katherine Johnson', source: 'onboarding' },
    ]);
    expect(settingsOf(reopened)).toMatchObject({ owner_name: 'Katherine Johnson' });
    reopened.close();

    db = initDatabase(dataDir);
  });
});

describe('a profile the user left alone', () => {
  it('offers Skip, and stores nothing when it is taken', () => {
    const onNext = vi.fn();
    const onSkip = vi.fn();
    render(createElement(MemoryStage, { onNext, onSkip }));

    fireEvent.click(screen.getByText('Skip — teach Henry later'));

    expect(onSkip).toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
    expect(memories(db)).toEqual([]);
    expect(settingsOf(db)).toEqual({});
  });

  it('cannot be saved while every field is still empty', () => {
    render(createElement(MemoryStage, { onNext: vi.fn(), onSkip: vi.fn() }));

    const save = screen.getByText('Save & Continue →') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // Nothing was typed into anything: the greyed-out examples are not values.
    for (const placeholder of placeholders()) {
      expect((screen.getByPlaceholderText(placeholder) as HTMLInputElement).value).toBe('');
    }
  });

  it('stores nothing when the fields hold only whitespace', () => {
    const onNext = vi.fn();
    render(createElement(MemoryStage, { onNext, onSkip: vi.fn() }));

    for (const field of PROFILE_FIELDS) type(field.label, '   ');
    fireEvent.click(screen.getByText('Save & Continue →'));

    expect((screen.getByText('Save & Continue →') as HTMLButtonElement).disabled).toBe(true);
    expect(onNext).not.toHaveBeenCalled();
    expect(memories(db)).toEqual([]);
    expect(settingsOf(db)).toEqual({});
  });
});

describe('when the write fails', () => {
  it('says so and stays put rather than advancing past a lost answer', async () => {
    window.henryAPI = {
      saveSetting: () => Promise.resolve(true),
      savePersonalMemory: () => Promise.reject(new Error('disk is full')),
    } as unknown as typeof window.henryAPI;

    const onNext = vi.fn();
    render(createElement(MemoryStage, { onNext, onSkip: vi.fn() }));
    type('Your name', 'Ada Lovelace');
    fireEvent.click(screen.getByText('Save & Continue →'));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('disk is full'));
    expect(onNext).not.toHaveBeenCalled();
  });
});