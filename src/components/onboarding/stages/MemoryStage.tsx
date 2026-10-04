import { useState } from 'react';
import { isMacOS } from '../../../utils/platform';
import { useStore } from '../../../store';
import {
  PROFILE_FIELDS,
  hasAnythingToSave,
  saveUserProfile,
  suppliedValue,
  type UserProfileFields,
} from '../../../henry/userProfile';

interface Props {
  /** Called only after the supplied values are stored. */
  onNext: () => void;
  /** An explicit, remembered deferral. It never writes anything. */
  onSkip: () => void;
}

/**
 * Teaching Henry about the user.
 *
 * This stage used to render ONE button whose label flipped between "Save and
 * continue" and "Skip — continue" depending on whether anything had been typed.
 * Two things were wrong with that: the save called a preload method that does
 * not exist (`saveMemoryFact`), so it was a silent no-op, and a label that
 * changes meaning is indistinguishable from a save that never appears. Both
 * actions are now separate buttons, and the save is a real write through the
 * same settings rows and the same personal-memory table the rest of Henry uses.
 */
export default function MemoryStage({ onNext, onSkip }: Props) {
  const [values, setValues] = useState<UserProfileFields>({ name: '', location: '', role: '', goal: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const canSave = hasAnythingToSave(values);

  async function save() {
    if (!canSave || saving) return;
    setSaving(true);
    setError('');
    try {
      const saved = await saveUserProfile(values, { source: 'onboarding', remember: true });

      // Anything that did not land is reported rather than swallowed. Advancing
      // past a failed save is how the user was told their details were kept
      // when they were not.
      if (saved.failures.length > 0) {
        setError(`Henry could not save: ${saved.failures.join('; ')}. What you typed is still here — try again.`);
        return;
      }

      // Keep the rest of the app in step with what was just written.
      const { updateSetting } = useStore.getState();
      for (const field of PROFILE_FIELDS) {
        const value = suppliedValue(values, field.key);
        if (!value) continue;
        for (const key of field.settingKeys) updateSetting(key, value);
      }

      onNext();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Henry could not save that. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="text-center">
        <p className="text-5xl mb-3">🧠</p>
        <h2 className="text-2xl font-bold text-white">Teach Henry about you</h2>
        <p className="text-white/55 text-sm mt-2 leading-relaxed">
          Memory is what makes Henry useful instead of generic. Fill in whatever is worth keeping —
          every field is optional.
        </p>
      </div>

      <div className="bg-henry-accent/10 border border-henry-accent/25 rounded-2xl p-4 space-y-3">
        <p className="text-[10px] uppercase tracking-widest text-henry-accent/80">
          Tell Henry about yourself right now
        </p>
        {PROFILE_FIELDS.map((field) => (
          <div key={field.key}>
            <label htmlFor={`profile-${field.key}`} className="text-[10px] text-white/50 uppercase tracking-wider block mb-1">
              {field.label}
            </label>
            <input
              id={`profile-${field.key}`}
              value={values[field.key] ?? ''}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              placeholder={field.placeholder}
              className="w-full bg-white/5 border border-white/15 rounded-xl px-3 py-2 text-sm text-white placeholder-white/25 outline-none focus:border-henry-accent/50 transition-all"
            />
          </div>
        ))}
        <p className="text-[10px] text-white/35 leading-relaxed">
          These save to your own memory, on this computer. The greyed-out text is an example only —
          Henry never stores it. Add more anytime — say &ldquo;remember that&hellip;&rdquo; in chat or
          open the Memory panel.
        </p>
      </div>

      <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-3">
        <p className="text-[10px] uppercase tracking-widest text-white/40">Three ways to save a memory</p>
        <ol className="space-y-4">
          <li className="flex gap-3">
            <Badge n={1} />
            <p className="text-sm text-white/80 leading-relaxed">
              <b className="text-white">Pin any AI response</b> — every response has a 📌 button.
            </p>
          </li>
          <li className="flex gap-3">
            <Badge n={2} />
            <p className="text-sm text-white/80 leading-relaxed">
              <b className="text-white">Tell Henry in chat</b> — &ldquo;remember I prefer direct answers&rdquo;.
            </p>
          </li>
          <li className="flex gap-3">
            <Badge n={3} />
            <p className="text-sm text-white/80 leading-relaxed">
              <b className="text-white">Open the Memory panel</b> and add facts directly.
            </p>
          </li>
        </ol>
      </div>

      <div className="bg-white/3 border border-white/8 rounded-xl p-3">
        <p className="text-white/50 text-[11px] leading-relaxed">
          <b className="text-white/70">Back up your data:</b> everything Henry knows — memories, tasks,
          journal, health, finance — lives in a SQLite database on your{' '}
          {isMacOS() ? 'Mac' : 'computer'}. Use Settings → General → Export Backup any time.
        </p>
      </div>

      {error && (
        <p role="alert" className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="space-y-2">
        <button
          onClick={() => void save()}
          disabled={!canSave || saving}
          className="w-full py-3.5 rounded-xl bg-henry-accent text-white font-bold text-sm hover:bg-henry-accent/85 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : 'Save & Continue →'}
        </button>
        <button
          onClick={onSkip}
          className="block w-full text-center text-white/45 text-xs hover:text-white/75 transition-all"
        >
          Skip — teach Henry later
        </button>
        {!canSave && (
          <p className="text-center text-[11px] text-white/35">
            Nothing typed yet, so there is nothing to save.
          </p>
        )}
      </div>
    </div>
  );
}

function Badge({ n }: { n: number }) {
  return (
    <span className="flex-shrink-0 w-6 h-6 rounded-full bg-henry-accent/20 border border-henry-accent/40 text-henry-accent flex items-center justify-center text-[11px] font-bold mt-0.5">
      {n}
    </span>
  );
}