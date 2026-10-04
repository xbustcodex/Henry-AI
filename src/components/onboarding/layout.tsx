import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * The shared onboarding layout — one vertical rhythm for every first-launch
 * screen.
 *
 * These screens were each built by hand, and they were all built slightly
 * differently: `space-y-5` here, `space-y-3` there, a full-width accent button
 * with a text link tucked eight pixels underneath it that read as half of the
 * same control. The result was a flow where cards, fields, instructions and
 * actions were pressed against each other with no way to tell where one idea
 * stopped and the next began.
 *
 * Two rules hold across everything below:
 *
 * 1. Sections are separated by real space (`STAGE_SECTION_GAP`), never by
 *    shrinking type or padding a card until it fits.
 * 2. Nothing here sets a viewport height. A stage is as tall as it needs to be
 *    and the wizard frame scrolls it (`../wizard/SetupWizard`), so at 125%
 *    display scaling or a short window the content stays whole and the actions
 *    stay reachable — nothing is clipped, overlapped or crushed to fit.
 */

/** Between major sections of a stage: heading, cards, actions. */
export const STAGE_SECTION_GAP = 'space-y-10';

/** Between the blocks inside one card. */
export const STAGE_CARD_GAP = 'space-y-5';

/**
 * A comfortable measure for running copy: ~576px, which at the onboarding body
 * size is roughly 75 characters a line. Full size — a narrow measure is fixed
 * with a max-width, never with a smaller font.
 */
export const STAGE_PROSE_WIDTH = 'max-w-xl';

/** Leading for that copy. */
export const STAGE_PROSE_LEADING = 'leading-relaxed';

/** The actions are a landmark of their own, so they read as a unit. */
export const STAGE_ACTIONS_LABEL = 'Stage actions';

/** The rule + margin that separates the actions from informational content. */
export const STAGE_ACTIONS_SEPARATOR = 'mt-12 pt-8 border-t border-henry-border/30';

/**
 * The body of a stage.
 *
 * Carries the section rhythm itself, which is what makes the spacing
 * *consistent*: every screen is a `STAGE_SECTION_GAP` stack whether or not it
 * remembers to be one.
 */
export function StageScreen({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`${STAGE_SECTION_GAP} ${className}`.trim()}>{children}</div>;
}

/** Icon, title, and the sentences that say what this screen is for. */
export function StageHeading({
  icon,
  title,
  children,
}: {
  icon?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="text-center">
      {icon ? (
        <div className="text-5xl mb-5" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <h2 className="text-2xl font-bold text-henry-text">{title}</h2>
      {children ? (
        <div
          className={`mt-4 mx-auto ${STAGE_PROSE_WIDTH} ${STAGE_PROSE_LEADING} text-sm text-henry-text-dim space-y-2`}
        >
          {children}
        </div>
      ) : null}
    </header>
  );
}

type CardTone = 'default' | 'accent' | 'quiet' | 'success' | 'warning';

const CARD_TONES: Record<CardTone, string> = {
  default: 'bg-henry-surface/40 border-henry-border/30',
  accent: 'bg-henry-accent/8 border-henry-accent/25',
  quiet: 'bg-henry-surface/20 border-henry-border/20',
  success: 'bg-green-500/10 border-green-500/30',
  warning: 'bg-amber-500/5 border-amber-500/30',
};


/**
 * One card.
 *
 * `label` is the card's own heading, set apart from its contents — so a block
 * of explanation inside a card never runs straight into the card's title.
 */
export function StageCard({
  label,
  tone = 'default',
  children,
  className = '',
}: {
  label?: ReactNode;
  tone?: CardTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border p-6 ${CARD_TONES[tone]} ${className}`.trim()}>
      <div className={STAGE_CARD_GAP}>
        {label ? (
          <p className="text-[11px] uppercase tracking-widest text-henry-text-muted">{label}</p>
        ) : null}
        {children}
      </div>
    </section>
  );
}

type NoteTone = 'muted' | 'accent' | 'warning';

const NOTE_TONES: Record<NoteTone, string> = {
  muted: 'bg-henry-surface/20 border-henry-border/25 text-henry-text-muted',
  accent: 'bg-henry-accent/8 border-henry-accent/25 text-henry-text-dim',
  warning: 'bg-amber-500/5 border-amber-500/30 text-amber-200/90',
};

/** A quiet aside — the kind of sentence that is helpful but is not a control. */
export function StageNote({ children, tone = 'muted' }: { children: ReactNode; tone?: NoteTone }) {
  return (
    <div
      className={`rounded-xl border p-5 text-sm ${STAGE_PROSE_LEADING} ${NOTE_TONES[tone]}`}
    >
      {children}
    </div>
  );
}

/**
 * The action area.
 *
 * Its own element, its own landmark, and separated from the last piece of
 * explanation by a rule and real space. This is what stops a screen reading as
 * one undifferentiated block of controls.
 */
export function StageActions({ children }: { children: ReactNode }) {
  return (
    <nav aria-label={STAGE_ACTIONS_LABEL} className={`${STAGE_ACTIONS_SEPARATOR} space-y-4`}>
      {children}
    </nav>
  );
}

/** The way forward. One filled control per screen, full width, unmistakable. */
export function StagePrimaryAction({
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`w-full py-4 rounded-xl bg-henry-accent text-white text-sm font-bold hover:bg-henry-accent-hover transition-all shadow-lg shadow-henry-accent/20 disabled:opacity-40 disabled:cursor-not-allowed ${className}`.trim()}
    >
      {children}
    </button>
  );
}

/**
 * Skipping is a real decision, so it gets a real control — outlined, dimmer,
 * and a full step away from the primary button above it. It never shares an
 * element, a border or a fill with the action it sits next to.
 */
export function StageSecondaryAction({
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`w-full py-3.5 rounded-xl border border-henry-border/50 text-henry-text-dim text-sm font-medium hover:border-henry-text-muted hover:text-henry-text transition-all ${className}`.trim()}
    >
      {children}
    </button>
  );
}

/** A quiet move — Back, or an offer to change a choice already made. */
export function StageTextAction({
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`px-5 py-3 text-henry-text-dim hover:text-henry-text transition-colors text-sm ${className}`.trim()}
    >
      {children}
    </button>
  );
}

/** A numbered step in an instruction list. */
export function StageStepBadge({ n }: { n: number }) {
  return (
    <span className="flex-shrink-0 w-7 h-7 rounded-full bg-henry-accent/15 border border-henry-accent/40 text-henry-accent flex items-center justify-center text-[11px] font-bold mt-0.5">
      {n}
    </span>
  );
}

/** One step of an instruction list: a badge and a comfortable measure of text. */
export function StageStep({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-4">
      <StageStepBadge n={n} />
      <div className={`text-sm text-henry-text-dim ${STAGE_PROSE_LEADING} ${STAGE_PROSE_WIDTH}`}>
        {children}
      </div>
    </li>
  );
}

/** A form field: label, control, and room to breathe around both. */
export function StageField({
  label,
  htmlFor,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="text-[11px] uppercase tracking-wider text-henry-text-muted block mb-2"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

/** The shared input/select look, so a field reads the same on every screen. */
export const STAGE_CONTROL =
  'w-full bg-henry-bg border border-henry-border rounded-xl px-4 py-3 text-sm text-henry-text outline-none focus:border-henry-accent/60 transition-all';
