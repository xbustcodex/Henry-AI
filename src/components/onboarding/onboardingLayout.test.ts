// @vitest-environment jsdom
/**
 * The onboarding layout, as structure.
 *
 * The owner-visible defect this guards is a layout one: cards, instructions,
 * fields and actions pressed against each other with nothing to tell them
 * apart, and screens that only looked right because the content had been
 * squeezed to fit. Those are checkable without a browser as long as they are
 * checked against the RENDERED DOM rather than the source — a class that is
 * written down is not a class that is applied.
 *
 * So every stage is rendered, and the rendered tree has to satisfy:
 *
 *  - it grows. No stage body carries a viewport height or an `overflow-hidden`
 *    that would crop content on a short window or at 125% display scaling;
 *  - it is spaced by the shared scale, so every screen breathes the same;
 *  - its actions are their own element with their own landmark, separated from
 *    the last piece of explanation;
 *  - skipping is a separate control from saving/continuing, not one button
 *    whose label means two things;
 *  - explanatory copy is capped to a readable measure and never truncated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { createElement, type ReactElement } from 'react';
import { useStore } from '../../store';
import SetupWizard from '../wizard/SetupWizard';
import WelcomeStep from '../wizard/WelcomeStep';
import ProviderStep from '../wizard/ProviderStep';
import CompleteStep from '../wizard/CompleteStep';
import HowItWorksStage from './stages/HowItWorksStage';
import PermissionsStage from './stages/PermissionsStage';
import CompanionStage from './stages/CompanionStage';
import PanelsStage from './stages/PanelsStage';
import MemoryStage from './stages/MemoryStage';
import {
  STAGE_ACTIONS_LABEL,
  STAGE_SECTION_GAP,
  STAGE_CARD_GAP,
  STAGE_ACTIONS_SEPARATOR,
} from './layout';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => {};

/** Every onboarding screen, rendered the way the wizard renders it. */
function stages(): Array<{ name: string; element: ReactElement }> {
  return [
    { name: 'welcome', element: createElement(WelcomeStep, { onNext: noop }) },
    { name: 'how it works', element: createElement(HowItWorksStage, { onNext: noop, onSkip: noop }) },
    {
      name: 'accessibility',
      element: createElement(PermissionsStage, { kind: 'accessibility', onNext: noop, onSkip: noop }),
    },
    {
      name: 'screen recording',
      element: createElement(PermissionsStage, { kind: 'screen', onNext: noop, onSkip: noop }),
    },
    { name: 'your brain', element: createElement(ProviderStep, { onNext: noop, onBack: noop }) },
    { name: 'companion', element: createElement(CompanionStage, { onNext: noop, onSkip: noop }) },
    { name: 'panels', element: createElement(PanelsStage, { onNext: noop, onSkip: noop }) },
    { name: 'memory', element: createElement(MemoryStage, { onNext: noop, onSkip: noop }) },
    {
      name: 'ready',
      element: createElement(CompleteStep, {
        onBack: noop,
        outcome: {
          provider: 'ollama',
          model: 'deepseek-r1:7b',
          hasCredential: false,
          localModels: 1,
          opencodeInstalled: false,
          skipped: ['panels'],
        },
      }),
    },
  ];
}

function classesOf(el: Element): string[] {
  return (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

function allElements(root: ParentNode): Element[] {
  return [root as Element, ...Array.from(root.querySelectorAll('*'))];
}

/** A height the user cannot scroll past: 100vh, full screen, `h-[840px]`. */
const VIEWPORT_HEIGHT = /(^|\s)h-(screen|full|\[[^\]]*(vh|px)\])|(^|\s)min-h-\[[^\]]*vh\]/;

/** Content cut off instead of wrapped or scrolled to. */
const CLIPPED = /\b(truncate|line-clamp-\d|overflow-hidden)\b/;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('henry:providers', JSON.stringify([]));
  localStorage.setItem('henry:settings', JSON.stringify({}));
  window.henryAPI = {
    opencodeStatus: async () => ({ available: false }),
    opencodeModels: async () => ({ ok: true, models: [] }),
    saveSetting: async () => true,
    saveProvider: async () => ({ ok: true }),
    getProviders: async () => [],
    getSettings: async () => ({}),
    checkAccessibility: async () => ({ granted: false }),
    checkScreenRecording: async () => ({ granted: false }),
    ollamaModels: async () => ({ models: [] }),
    computerRunShell: async () => undefined,
    onAppQuitting: () => () => {},
  } as unknown as typeof window.henryAPI;
  useStore.setState({ providers: [], settings: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('no onboarding stage crops its own content', () => {
  it('renders real content on every screen, so the checks below are not vacuous', () => {
    for (const stage of stages()) {
      cleanup();
      const { container } = render(stage.element);
      expect(container.textContent?.trim().length ?? 0, `${stage.name} rendered nothing`).toBeGreaterThan(40);
    }
  });

  it('gives no stage a fixed height or a crop', () => {
    for (const stage of stages()) {
      cleanup();
      const { container } = render(stage.element);

      const cropped = allElements(container).filter((el) => {
        const classes = classesOf(el);
        // A progress dot deliberately clips nothing; a rounded pill of fixed
        // size is a shape, not a crop of content.
        const isShape =
          classes.some((c) => /^w-\d+$/.test(c)) && classes.some((c) => /^h-\d+$/.test(c));
        if (isShape) return false;
        return (
          VIEWPORT_HEIGHT.test(el.getAttribute('class') ?? '') ||
          CLIPPED.test(el.getAttribute('class') ?? '')
        );
      });

      expect(
        cropped.map((el) => el.getAttribute('class')),
        `${stage.name} pins or clips its content`,
      ).toEqual([]);
    }
  });

  it('leaves the scrolling to the wizard frame, which is sized to flex', async () => {
    const { container } = render(createElement(SetupWizard));
    // The placeholder shown while discovery is in flight is not the frame.
    await waitFor(() => expect(document.body.textContent).toContain("Hey. I'm Henry"));

    const frame = container.querySelector('.h-screen');
    expect(frame, 'the wizard frame is missing').not.toBeNull();
    expect(classesOf(frame!), 'the frame clips what it cannot scroll').not.toContain('overflow-hidden');

    const scroller = frame!.firstElementChild!.nextElementSibling!;
    expect(classesOf(scroller), 'nothing scrolls the stage').toContain('overflow-y-auto');
    expect(classesOf(scroller), 'a flex child with no min-h-0 cannot scroll').toContain('min-h-0');
  });
});

describe('the shared spacing scale is what spaces the screens', () => {
  it('builds every stage body on the same section rhythm', () => {
    for (const stage of stages()) {
      cleanup();
      const { container } = render(stage.element);
      const root = container.firstElementChild!;

      expect(classesOf(root), `${stage.name} does not use the shared section gap`).toContain(
        STAGE_SECTION_GAP.split(' ')[0],
      );
    }
  });

  it('pads every card and holds its contents on the shared card gap', () => {
    for (const stage of stages()) {
      cleanup();
      const { container } = render(stage.element);

      for (const card of Array.from(container.querySelectorAll('section'))) {
        expect(classesOf(card), `${stage.name}: a card is not padded`).toContain('p-6');
        expect(
          classesOf(card.firstElementChild!),
          `${stage.name}: a card does not use the shared card gap`,
        ).toContain(STAGE_CARD_GAP.split(' ')[0]);
      }
    }
  });

  it('holds running copy to a readable measure instead of running it to the window edge', () => {
    for (const stage of stages()) {
      cleanup();
      const { container } = render(stage.element);
      const root = container.firstElementChild!;

      // Every run of text a person actually reads, and the width it is
      // measured against: its own cap, or the nearest one above it.
      const runs = Array.from(container.querySelectorAll('*')).filter(
        (el) => el.children.length === 0 && (el.textContent ?? '').trim().length > 30,
      );
      expect(runs.length, `${stage.name} has no running copy to measure`).toBeGreaterThanOrEqual(2);

      for (const run of runs) {
        const chain: Element[] = [];
        for (let el: Element | null = run; el && el !== root.parentElement; el = el.parentElement) {
          chain.push(el);
        }
        const styled = chain.some((el) => classesOf(el).includes('leading-relaxed'));
        // Any cap counts, narrower included — what fails is a measure that runs
        // to the window edge.
        const capped = chain.some((el) => classesOf(el).some((c) => c.startsWith('max-w-')));
        if (!styled) continue;
        expect(
          capped,
          `${stage.name}: uncapped prose — ${run.textContent?.slice(0, 40)}`,
        ).toBe(true);
      }
    }
  });
});

describe('actions are their own element, and skipping is its own control', () => {
  it('gives every stage exactly one separated action area', () => {
    for (const stage of stages()) {
      cleanup();
      const { container } = render(stage.element);
      const areas = Array.from(
        container.querySelectorAll(`nav[aria-label="${STAGE_ACTIONS_LABEL}"]`),
      );

      expect(areas.length, `${stage.name} has ${areas.length} action areas`).toBe(1);
      // A rule and real space, not a few pixels under the last paragraph.
      for (const token of STAGE_ACTIONS_SEPARATOR.split(' ')) {
        expect(classesOf(areas[0]), `${stage.name}: action area lacks ${token}`).toContain(token);
      }
      // The information above it is a sibling, not a parent.
      expect(areas[0].parentElement!.tagName, `${stage.name}: actions are not a block of their own`).toBe(
        'DIV',
      );
    }
  });

  it('keeps the way forward and the skip as separate controls, a step apart', () => {
    // Each pair lives on the screen that offers it, under the wording a user
    // actually reads.
    const screens: Array<{ name: string; primary: string; secondary: string; element: ReactElement }> = [
      {
        name: 'memory',
        primary: 'Save & Continue →',
        secondary: 'Skip — teach Henry later',
        element: createElement(MemoryStage, { onNext: noop, onSkip: noop }),
      },
      {
        name: 'how it works',
        primary: 'Got it — continue →',
        secondary: 'Skip — set up later',
        element: createElement(HowItWorksStage, { onNext: noop, onSkip: noop }),
      },
      {
        name: 'panels',
        primary: 'Got it — continue →',
        secondary: 'Skip the tour',
        element: createElement(PanelsStage, { onNext: noop, onSkip: noop }),
      },
      {
        name: 'accessibility',
        primary: 'Open Accessibility Settings →',
        secondary: 'Skip — grant later',
        element: createElement(PermissionsStage, { kind: 'accessibility', onNext: noop, onSkip: noop }),
      },
    ];

    for (const screen of screens) {
      cleanup();
      const { container } = render(screen.element);
      const area = container.querySelector(`nav[aria-label="${STAGE_ACTIONS_LABEL}"]`)!;

      const primary = Array.from(area.querySelectorAll('button')).find((b) =>
        (b.textContent ?? '').includes(screen.primary),
      );
      const skipping = Array.from(area.querySelectorAll('button')).find((b) =>
        (b.textContent ?? '').includes(screen.secondary),
      );

      expect(primary, `${screen.name}: "${screen.primary}" is not a control in the action area`).toBeDefined();
      expect(skipping, `${screen.name}: "${screen.secondary}" is not a control in the action area`).toBeDefined();

      // Two decisions, two elements: neither is inside the other.
      expect(skipping!.querySelectorAll('button'), `${screen.name}: the skip nests the primary`).toHaveLength(0);
      expect(primary!.contains(skipping!), `${screen.name}: the primary swallows the skip`).toBe(false);
      expect(skipping!.contains(primary!), `${screen.name}: the skip swallows the primary`).toBe(false);

      // And they do not look like halves of one control: filled vs outlined.
      expect(classesOf(primary!), `${screen.name}: the primary is not the filled control`).toContain(
        'bg-henry-accent',
      );
      expect(classesOf(skipping!), `${screen.name}: the skip is not an outlined control`).toContain('border');
      expect(classesOf(skipping!), `${screen.name}: the skip is styled as the primary`).not.toContain(
        'bg-henry-accent',
      );

      // A full step apart, not flush.
      expect(classesOf(area)).toContain('space-y-4');
    }
  });

  it('never offers a "Done" on the pairing screen before anything is paired', () => {
    const { container } = render(createElement(CompanionStage, { onNext: noop, onSkip: noop }));
    const area = container.querySelector(`nav[aria-label="${STAGE_ACTIONS_LABEL}"]`)!;
    const labels = Array.from(area.querySelectorAll('button')).map((b) => b.textContent);

    expect(labels).toEqual(["Skip — I'll pair my phone later"]);
  });

  it('shows the reason a required stage is holding the user beside the action', () => {
    const note = 'Choose a provider and a model first.';
    const { container } = render(
      createElement(ProviderStep, { onNext: noop, onBack: noop, note }),
    );
    const area = container.querySelector(`nav[aria-label="${STAGE_ACTIONS_LABEL}"]`)!;

    expect(area.textContent).toContain(note);
    expect(
      Array.from(area.querySelectorAll('button')).some((b) => b.textContent?.includes('Continue')),
      'the note explains a control that is not beside it',
    ).toBe(true);
  });
});
