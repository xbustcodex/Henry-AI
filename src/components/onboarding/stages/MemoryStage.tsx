import { useState } from 'react';
import { isMacOS } from '../../../utils/platform';

interface Props {
  onNext: () => void;
}

interface MemoryBridge {
  saveMemoryFact?: (fact: { fact: string; category: string; importance: number }) => Promise<unknown>;
}

const FIELDS = [
  { label: 'Your name', placeholder: 'Alex', key: 'name' },
  { label: 'What you do', placeholder: 'Freelance designer', key: 'job' },
  { label: 'Biggest goal right now', placeholder: 'Double revenue this year', key: 'goal' },
] as const;

type FieldKey = (typeof FIELDS)[number]['key'];

/**
 * Teaching Henry about the user.
 *
 * Optional: empty fields are simply not saved, and nothing is ever filled in
 * for them. What the user types here is written to their own memory — no
 * example name, no sample business, no assumed employer.
 */
export default function MemoryStage({ onNext }: Props) {
  const [values, setValues] = useState<Record<FieldKey, string>>({ name: '', job: '', goal: '' });
  const [saved, setSaved] = useState(false);

  const answers: Array<{ fact: string }> = [];
  if (values.name.trim()) answers.push({ fact: `User's name is ${values.name.trim()}` });
  if (values.job.trim()) answers.push({ fact: `User works as: ${values.job.trim()}` });
  if (values.goal.trim()) answers.push({ fact: `User's main goal right now: ${values.goal.trim()}` });

  async function saveAndContinue() {
    if (!saved) {
      const api = typeof window === 'undefined' ? undefined : window.henryAPI as unknown as MemoryBridge | undefined;
      for (const answer of answers) {
        try {
          await api?.saveMemoryFact?.({ ...answer, category: 'personal', importance: 3 });
        } catch {
          /* a fact the user can re-enter later is not worth blocking on */
        }
      }
      setSaved(true);
    }
    onNext();
  }

  return (
    <div className="space-y-5">
      <div className="text-center">
        <p className="text-5xl mb-3">🧠</p>
        <h2 className="text-2xl font-bold text-white">Teach Henry about you</h2>
        <p className="text-white/55 text-sm mt-2 leading-relaxed">
          Memory is what makes Henry useful instead of generic. Leave anything blank — it is not required.
        </p>
      </div>

      <div className="bg-henry-accent/10 border border-henry-accent/25 rounded-2xl p-4 space-y-3">
        <p className="text-[10px] uppercase tracking-widest text-henry-accent/80">
          Tell Henry about yourself right now
        </p>
        {FIELDS.map((field) => (
          <div key={field.key}>
            <label className="text-[10px] text-white/50 uppercase tracking-wider block mb-1">
              {field.label}
            </label>
            <input
              value={values[field.key]}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              placeholder={field.placeholder}
              className="w-full bg-white/5 border border-white/15 rounded-xl px-3 py-2 text-sm text-white placeholder-white/25 outline-none focus:border-henry-accent/50 transition-all"
            />
          </div>
        ))}
        <p className="text-[10px] text-white/35 leading-relaxed">
          These save to your own memory, on this computer. Add more anytime — say &ldquo;remember
          that&hellip;&rdquo; in chat or open the Memory panel.
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

      <button
        onClick={() => void saveAndContinue()}
        className="w-full py-3.5 rounded-xl bg-henry-accent text-white font-bold text-sm hover:bg-henry-accent/85 transition-all"
      >
        {answers.length > 0 ? `Save and continue →` : 'Skip — continue →'}
      </button>
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