import { useState } from 'react';
import {
  StageScreen,
  StageHeading,
  StageCard,
  StageActions,
  StagePrimaryAction,
  StageSecondaryAction,
  STAGE_PROSE_LEADING,
  STAGE_PROSE_WIDTH,
} from '../layout';

interface Props {
  onNext: () => void;
  onSkip: () => void;
}

const PANELS = [
  { icon: '💬', name: 'Chat', desc: 'Talk to Henry. Ask anything — he knows your tasks, reminders, habits, calendar, and memory.' },
  { icon: '☀️', name: 'Today', desc: 'Your daily launchpad. Habits to check in, your schedule, and a one-tap daily plan.' },
  { icon: '✓', name: 'Tasks', desc: 'Full task list with AI triage. Henry can add, complete, and prioritize tasks from chat.' },
  { icon: '⏰', name: 'Reminders', desc: 'Time-based reminders with snooze. Henry shows a badge in the sidebar when something is due.' },
  { icon: '◎', name: 'Goals', desc: 'Long-term goals with AI coaching. Set a target date and Henry nags when it is overdue.' },
  { icon: '📔', name: 'Journal', desc: 'Daily journal with mood tracker, AI reflection prompts, and a streak counter.' },
  { icon: '❤️', name: 'Health', desc: 'Log water, steps, sleep, exercise, and calories, with charts to show trends over time.' },
  { icon: '💰', name: 'Finance', desc: 'Income, expenses, budgets, bank CSV import, and alerts when you overspend a category.' },
  { icon: '🗓️', name: 'Weekly', desc: 'Weekly review wizard — what got done, what did not, what needs to move.' },
  { icon: '📄', name: 'Quoting', desc: 'Create quotes and invoices for clients. Line items, totals, client management, PDF export.' },
  { icon: '🎙', name: 'Recorder', desc: 'Voice memos with transcription. Transcripts are saved and searchable.' },
  { icon: '🖨', name: 'Print Studio', desc: 'For makers: generate print-ready files and manage print queues and jobs.' },
  { icon: '🏭', name: 'Maker Studio', desc: 'Machines, materials, production runs, waste tracking, maintenance logs.' },
  { icon: '🖼', name: 'Image Gen', desc: 'Generate images from a description. Pick a model and a size.' },
  { icon: '🎬', name: 'Video Gen', desc: 'Generate short video clips. Great for social content.' },
  { icon: '🧠', name: 'Memory', desc: 'Everything Henry remembers about you. Facts are injected into every conversation.' },
  { icon: '🌐', name: 'HQ', desc: 'Command center: active automations, recent captures, ambient brain status.' },
  { icon: '⚙️', name: 'Settings', desc: 'AI providers, accent colours, routing, backup and export.' },
];

/** Optional tour of the sidebar — skippable, and never the only way to find a panel. */
export default function PanelsStage({ onNext, onSkip }: Props) {
  const [index, setIndex] = useState(0);
  const panel = PANELS[index];

  return (
    <StageScreen>
      <StageHeading icon="🗂" title="Everything in the sidebar">
        <p>Henry has {PANELS.length} panels. Here is what each one does.</p>
      </StageHeading>

      <div>
        <div className="bg-henry-surface/40 border border-henry-border/30 rounded-2xl p-6">
          <div>
            <div className="flex items-center gap-4 mb-4">
              <span className="text-4xl">{panel.icon}</span>
              <div>
                <p className="text-henry-text font-bold text-lg">{panel.name}</p>
                <p className="text-henry-text-muted text-[11px] mt-1">
                  {index + 1} of {PANELS.length}
                </p>
              </div>
            </div>
            <p className={`text-henry-text-dim text-sm ${STAGE_PROSE_LEADING} ${STAGE_PROSE_WIDTH}`}>
              {panel.desc}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between mt-5 px-1">
          <button
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={index === 0}
            className="w-10 h-10 rounded-full border border-henry-border/40 text-henry-text-dim hover:border-henry-text-muted hover:text-henry-text disabled:opacity-20 transition-all text-sm"
          >
            ←
          </button>
          <div className="flex gap-1.5 items-center">
            {PANELS.map((p, i) => (
              <button
                key={p.name}
                onClick={() => setIndex(i)}
                title={p.name}
                className={
                  'rounded-full transition-all ' +
                  (i === index ? 'w-4 h-2 bg-henry-accent' : 'w-2 h-2 bg-white/20 hover:bg-white/40')
                }
              />
            ))}
          </div>
          <button
            onClick={() => setIndex((i) => Math.min(PANELS.length - 1, i + 1))}
            disabled={index === PANELS.length - 1}
            className="w-10 h-10 rounded-full border border-henry-border/40 text-henry-text-dim hover:border-henry-text-muted hover:text-henry-text disabled:opacity-20 transition-all text-sm"
          >
            →
          </button>
        </div>
      </div>

      <StageCard tone="quiet" label="All panels at a glance">
        <div className="flex flex-wrap gap-3">
          {PANELS.map((p, i) => (
            <button
              key={p.name}
              onClick={() => setIndex(i)}
              title={p.name}
              className={
                'text-xl transition-all ' + (i === index ? 'scale-125' : 'opacity-50 hover:opacity-100')
              }
            >
              {p.icon}
            </button>
          ))}
        </div>
      </StageCard>

      <StageActions>
        <StagePrimaryAction onClick={onNext}>Got it — continue →</StagePrimaryAction>
        <StageSecondaryAction onClick={onSkip}>Skip the tour</StageSecondaryAction>
      </StageActions>
    </StageScreen>
  );
}