/**
 * Saving what the user told Henry about themselves.
 *
 * There used to be two answers to "how does Henry store the name someone typed
 * into setup?". One place wrote settings rows, another wrote a fact through a
 * preload method that did not exist — so the write was a silent no-op and the
 * user was told their answer had been saved. This module is the one place that
 * answers it, and both the first-launch stage and Settings → Profile call it.
 *
 * Two rules the callers rely on:
 *
 *   1. Only what the user actually supplied is written. A blank field is not
 *      stored, and it does not blank anything that is already there — leaving
 *      a field empty means "I did not say", not "erase what you know".
 *   2. The stored value is the supplied value. No wrapping sentence, no example
 *      text, no substitution. `e.g. Topher` is a placeholder attribute on the
 *      input and never reaches this module; the test proves that by reading
 *      every row back out of the database.
 */

export interface UserProfileFields {
  name?: string;
  location?: string;
  role?: string;
  goal?: string;
}

export type UserProfileFieldKey = keyof UserProfileFields;

export interface ProfileField {
  key: UserProfileFieldKey;
  label: string;
  /** Shown in the input. It is an example, and it is never a value. */
  placeholder: string;
  /** Category in the same vocabulary the Memory panel writes. */
  memoryType: string;
  /** Settings rows this field is authoritative for. */
  settingKeys: readonly string[];
}

/**
 * The questions first launch asks, in the order it asks them.
 *
 * Name and location are the two things Henry already has somewhere to put
 * (`user_name` is what the coder prompt greets by; `location` is what the
 * weather and local context read), so they are stored as both settings and
 * memories. Role and goal have no settings column — they are memory only.
 */
export const PROFILE_FIELDS: readonly ProfileField[] = [
  {
    key: 'name',
    label: 'Your name',
    placeholder: 'e.g. Topher',
    memoryType: 'identity',
    settingKeys: ['owner_name', 'user_name'],
  },
  {
    key: 'location',
    label: 'Where you are',
    placeholder: 'e.g. Portland, OR',
    memoryType: 'identity',
    settingKeys: ['location'],
  },
  {
    key: 'role',
    label: 'What you do',
    placeholder: 'e.g. Freelance designer',
    memoryType: 'work',
    settingKeys: [],
  },
  {
    key: 'goal',
    label: 'Biggest goal right now',
    placeholder: 'e.g. Double revenue this year',
    memoryType: 'goal',
    settingKeys: [],
  },
];

export type ProfileSource = 'onboarding' | 'settings';

/** What was actually written, so a caller can tell the user the truth. */
export interface SavedProfile {
  /** Settings keys written. */
  settings: string[];
  /** Personal-memory rows written, as `key: value`. */
  memories: string[];
  /** One entry per field that could not be stored. Empty means fully saved. */
  failures: string[];
}

interface ProfileBridge {
  saveSetting?: (key: string, value: string) => Promise<unknown>;
  savePersonalMemory?: (item: Record<string, unknown>) => Promise<{ id?: string | null } | null>;
}

function bridge(): ProfileBridge | undefined {
  return typeof window === 'undefined' ? undefined : (window.henryAPI as unknown as ProfileBridge | undefined);
}

/** The trimmed value the user supplied for `key`, or '' when they supplied none. */
export function suppliedValue(fields: UserProfileFields, key: UserProfileFieldKey): string {
  return (fields[key] ?? '').trim();
}

/** True when at least one field holds something the user typed. */
export function hasAnythingToSave(fields: UserProfileFields): boolean {
  return PROFILE_FIELDS.some((field) => suppliedValue(fields, field.key) !== '');
}

/**
 * Persist a profile through the same settings rows and the same personal-memory
 * table Henry already uses everywhere else.
 *
 * `source` is recorded on the memory row so a fact written during first launch
 * can be told apart from one typed into the Memory panel later. `remember`
 * decides whether a memory row is written at all: Settings → Profile edits an
 * existing profile and stores settings only, so saving it twice cannot pile up
 * duplicate memories.
 */
export async function saveUserProfile(
  fields: UserProfileFields,
  options: { source: ProfileSource; remember: boolean },
): Promise<SavedProfile> {
  const { source, remember } = options;
  const api = bridge();
  const saved: SavedProfile = { settings: [], memories: [], failures: [] };

  for (const field of PROFILE_FIELDS) {
    const value = suppliedValue(fields, field.key);
    if (!value) continue;

    for (const key of field.settingKeys) {
      if (!api?.saveSetting) {
        saved.failures.push(`${field.label} (no settings bridge)`);
        continue;
      }
      try {
        await api.saveSetting(key, value);
        saved.settings.push(key);
      } catch (err: unknown) {
        saved.failures.push(`${field.label} → ${key}: ${message(err)}`);
      }
    }

    if (!remember) continue;

    if (!api?.savePersonalMemory) {
      saved.failures.push(`${field.label} (no memory bridge)`);
      continue;
    }
    try {
      await api.savePersonalMemory({
        memoryKey: field.key,
        memoryValue: value,
        memoryType: field.memoryType,
        source,
        confidenceScore: 1,
      });
      saved.memories.push(`${field.key}: ${value}`);
    } catch (err: unknown) {
      saved.failures.push(`${field.label}: ${message(err)}`);
    }
  }

  return saved;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
