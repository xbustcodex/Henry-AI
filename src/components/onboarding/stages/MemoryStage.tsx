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
import {
  StageScreen,
  StageHeading,
  StageCard,
  StageNote,
  StageActions,
  StagePrimaryAction,
  StageSecondaryAction,
  StageStep,
  StageField,
  STAGE_CONTROL,
  STAGE_PROSE_LEADING,
  STAGE_PROSE_WIDTH,
} from '../layout';

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
    <StageScreen>
      <StageHeading icon="🧠" title="Teach Henry about you">
        <p>
          Memory is what makes Henry useful instead of generic. Fill in whatever is worth keeping —
          every field is optional.
        </p>
      </StageHeading>

      <StageCard tone="accent" label="Tell Henry about yourself right now">
        {PROFILE_FIELDS.map((field) => (
          <StageField key={field.key} label={field.label} htmlFor={`profile-${field.key}`}>
            <input
              id={`profile-${field.key}`}
              value={values[field.key] ?? ''}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              placeholder={field.placeholder}
              aria-label={field.label}
              className={`${STAGE_CONTROL} placeholder-white/25`}
            />
          </StageField>
        ))}
        <p className={`text-henry-text-muted text-sm ${STAGE_PROSE_LEADING} ${STAGE_PROSE_WIDTH}`}>
          These save to your own memory, on this computer. The greyed-out text is an example only —
          Henry never stores it. Add more anytime — say &ldquo;remember that&hellip;&rdquo; in chat
          or open the Memory panel.
        </p>
      </StageCard>

      <StageCard label="Three ways to save a memory">
        <ol className="space-y-5">
          <StageStep n={1}>
            <b className="text-henry-text">Pin any AI response</b> — every response has a 📌 button.
          </StageStep>
          <StageStep n={2}>
            <b className="text-henry-text">Tell Henry in chat</b> — &ldquo;remember I prefer
            direct answers&rdquo;.
          </StageStep>
          <StageStep n={3}>
            <b className="text-henry-text">Open the Memory panel</b> and add facts directly.
          </StageStep>
        </ol>
      </StageCard>

      <StageNote>
        <b className="text-henry-text">Back up your data:</b> everything Henry knows — memories,
        tasks, journal, health, finance — lives in a SQLite database on your{' '}
        {isMacOS() ? 'Mac' : 'computer'}. Use Settings → General → Export Backup any time.
      </StageNote>

      {error && (
        <p role="alert" className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </p>
      )}

      <StageActions>
        {!canSave && (
          <p className="text-center text-sm text-henry-text-muted">
            Nothing typed yet, so there is nothing to save.
          </p>
        )}
        <StagePrimaryAction
          onClick={() => void save()}
          disabled={!canSave || saving}
        >
          {saving ? 'Saving…' : 'Save & Continue →'}
        </StagePrimaryAction>
        <StageSecondaryAction onClick={onSkip}>Skip — teach Henry later</StageSecondaryAction>
      </StageActions>
    </StageScreen>
  );
}