/**
 * The System Map stage.
 *
 * ── What it promises, and in what order ────────────────────────────────────
 *
 * It asks to scan this computer once, so Henry stops rediscovering it in every
 * conversation. It is OPTIONAL: it has an explicit Skip, it never blocks, and
 * the wizard's only required stage is still `ai`. A first launch that skips it
 * is a first launch that completes exactly as fast as it did before this stage
 * existed — nothing here runs on mount, so there is no scan to wait for and no
 * cost to declining.
 *
 * The stage has three screens, and they are in the order the decision actually
 * happens in:
 *
 *   1. **Review.** The offer, the plain-English exclusions, and the promise that
 *      file *contents* are never read. The user's edited exclusion set is held
 *      in this component and is what gets sent.
 *   2. **Scanning.** Live progress and a Cancel. Nothing is editable here — the
 *      set cannot change underneath a running walk.
 *   3. **Ready.** What the map actually contains, any agent runtimes the scan
 *      turned up (offered, never applied), and the way on.
 *
 * Cancelling from (2) returns to (1) with the exclusions intact and a plain
 * statement that nothing was kept — a user who changes their mind mid-scan
 * should be able to change it again without retyping.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CONTENTS_NEVER_READ,
  DEFAULT_EXCLUSION_CATEGORIES,
  defaultExclusions,
  getSystemMapExclusions,
  saveSystemMapExclusions,
  type SystemMapExclusions,
} from '../../../henry/systemMap';
import {
  StageActions,
  StageCard,
  StageHeading,
  StageNote,
  StagePrimaryAction,
  StageScreen,
  StageSecondaryAction,
  STAGE_PROSE_LEADING,
  STAGE_PROSE_WIDTH,
} from '../layout';
import ExclusionsEditor from '../../systemMap/ExclusionsEditor';
import MapContentsView from '../../systemMap/MapContentsView';
import RuntimeOffers from '../../systemMap/RuntimeOffers';
import ScanProgressView from '../../systemMap/ScanProgressView';
import { useSystemMapScan } from '../../systemMap/useSystemMapScan';

/** Which of the three screens is showing. */
type View = 'review' | 'scanning' | 'ready';

export default function SystemMapStage({
  onNext,
  onSkip,
}: {
  onNext: () => void;
  onSkip: () => void;
}) {
  const [view, setView] = useState<View>('review');
  const [exclusions, setExclusions] = useState<SystemMapExclusions>(defaultExclusions);
  // Set once the real persisted set arrives, so an in-flight edit is never
  // clobbered by a slower read that started before the user touched anything.
  const [loaded, setLoaded] = useState(false);
  const [stopped, setStopped] = useState(false);

  // Pressing Cancel has to win even when it lands in the microtask gap
  // between "persist the exclusions" and "the scan actually begins". Without
  // this the scan would start *after* the stop and the stage would sit on
  // "Scanning…" for a scan the user had already called off.
  const stopRequested = useRef(false);

  const { phase, progress, contents, error, start, cancel, reset } = useSystemMapScan();

  useEffect(() => {
    let cancelled = false;
    void getSystemMapExclusions().then((found) => {
      if (cancelled) return;
      if (found.categories.length || found.folders.length) setExclusions(found);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The scan's terminal state decides the screen, not the button that was
  // pressed — a scan that fails or is cancelled must not leave the stage
  // claiming to be "Ready". A stop the user already asked for is not undone by
  // a late arrival from a scan that was on its way out anyway.
  useEffect(() => {
    if (stopRequested.current) return;
    if (phase === 'completed') setView('ready');
    else if (phase === 'cancelled') setView('review');
    else if (phase === 'scanning') setView('scanning');
  }, [phase]);

  const build = useCallback(async () => {
    stopRequested.current = false;
    setStopped(false);
    setView('scanning');
    // Persist first so the same exclusions can be re-opened and edited later
    // from Settings, then scan with exactly this set.
    await saveSystemMapExclusions(exclusions);
    if (stopRequested.current) return;
    await start(exclusions);
  }, [exclusions, start]);

  const stop = useCallback(async () => {
    stopRequested.current = true;
    await cancel();
    reset();
    setStopped(true);
    setView('review');
  }, [cancel, reset]);

  if (view === 'scanning') {
    return (
      <StageScreen>
        <StageHeading title="Scanning this computer…">
          <p>
            Henry is reading names, types, sizes and dates so it knows what this machine
            has. You can stop it at any point — nothing is kept unless the scan finishes.
          </p>
        </StageHeading>

        <ScanProgressView progress={progress} />

        {phase === 'failed' && error && <StageNote tone="warning">{error}</StageNote>}

        <StageActions>
          <StageSecondaryAction onClick={() => void stop()}>
            Cancel scan
          </StageSecondaryAction>
        </StageActions>
      </StageScreen>
    );
  }

  if (view === 'ready' && contents) {
    return (
      <StageScreen>
        <StageHeading icon="🗺️" title="Henry’s system map is ready">
          <p>
            Built from a single scan of this computer. Henry can now answer questions
            about what is installed here without looking again every time.
          </p>
        </StageHeading>

        <MapContentsView contents={contents} />

        <RuntimeOffers />

        <StageActions>
          {/* Nothing to skip any more — the map is built. Declining now would
              only mean declining a map that already exists. */}
          <StagePrimaryAction onClick={onNext}>Continue →</StagePrimaryAction>
        </StageActions>
      </StageScreen>
    );
  }

  return (
    <StageScreen>
      <StageHeading icon="🗺️" title="Build Henry&rsquo;s system map">
        <p>
          Henry can scan this computer once to understand its drives, applications,
          folders, files, development tools and available AI software. This creates a
          local system inventory so Henry knows what is available without rediscovering
          everything each time.
        </p>
        <p>It is your computer, so this is entirely optional — you can skip it and build the map later.</p>
      </StageHeading>

      {stopped && (
        <StageNote tone="warning">
          Scan stopped. Nothing was kept, and your exclusions below are still exactly as
          you left them.
        </StageNote>
      )}

      {phase === 'failed' && error && !stopped && (
        <StageNote tone="warning">That scan did not finish: {error}</StageNote>
      )}

      <ExclusionsEditor
        exclusions={exclusions}
        onChange={setExclusions}
        available={DEFAULT_EXCLUSION_CATEGORIES}
      />

      <StageCard label="What is recorded">
        <p className={`text-sm text-henry-text-dim ${STAGE_PROSE_LEADING} ${STAGE_PROSE_WIDTH}`}>
          {CONTENTS_NEVER_READ}
        </p>
        <ul
          className={`text-sm text-henry-text-dim ${STAGE_PROSE_LEADING} ${STAGE_PROSE_WIDTH} space-y-1.5`}
        >
          <li>File names</li>
          <li>File types</li>
          <li>File sizes</li>
          <li>File dates</li>
        </ul>
      </StageCard>

      <StageActions>
        <StagePrimaryAction onClick={() => void build()} disabled={!loaded}>
          Build System Map
        </StagePrimaryAction>
        <StageSecondaryAction onClick={onSkip}>Skip</StageSecondaryAction>
      </StageActions>
    </StageScreen>
  );
}