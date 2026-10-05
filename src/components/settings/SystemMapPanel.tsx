/**
 * System Map — the Settings panel.
 *
 * Onboarding can only ask once. Software gets installed, folders get moved, and
 * an inventory built on day one goes stale. This is where the user comes back:
 * to see what the map currently holds, to rebuild it, and to change what the
 * next rebuild will leave out.
 *
 * ── What this panel will not do ────────────────────────────────────────────
 *
 * It does not scan on mount, on tab focus, or on "refresh". A rebuild starts
 * when the user presses Rebuild, with the exclusions currently shown on screen —
 * never a set the panel silently reinstates, and never a scan that starts
 * without the exclusions being re-readable at the moment of the click.
 *
 * A rebuild is offered only against a map that already exists, so the button
 * cannot be mistaken for "build it for me now" in a build where nothing has
 * been built.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_EXCLUSION_CATEGORIES,
  getSystemMapContents,
  getSystemMapExclusions,
  saveSystemMapExclusions,
  type SystemMapContents,
  type SystemMapExclusions,
} from '../../henry/systemMap';
import ExclusionsEditor from '../systemMap/ExclusionsEditor';
import MapContentsView from '../systemMap/MapContentsView';
import RuntimeOffers from '../systemMap/RuntimeOffers';
import ScanProgressView from '../systemMap/ScanProgressView';
import { useSystemMapScan } from '../systemMap/useSystemMapScan';

const cardCls = 'bg-henry-card border border-henry-border rounded-xl p-4';

const buttonCls =
  'text-xs px-3 py-1.5 rounded-md border border-henry-border text-henry-text hover:bg-henry-bg disabled:opacity-40 disabled:cursor-not-allowed';

type Mode = 'contents' | 'exclusions';

export default function SystemMapPanel() {
  const [contents, setContents] = useState<SystemMapContents | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<Mode>('contents');
  const [exclusions, setExclusions] = useState<SystemMapExclusions>({
    categories: DEFAULT_EXCLUSION_CATEGORIES.map((c) => ({ ...c })),
    folders: [],
  });
  const [notice, setNotice] = useState<string | null>(null);

  const { phase, progress, error, start, cancel } = useSystemMapScan();
  const scanning = phase === 'scanning';

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getSystemMapContents(), getSystemMapExclusions()]).then(
      ([map, saved]) => {
        if (cancelled) return;
        setContents(map);
        setExclusions(saved);
        setLoaded(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // A rebuild that finished replaces what is on screen; the stored map changed
  // underneath this panel and showing the old one would be a lie.
  useEffect(() => {
    if (phase === 'completed') void getSystemMapContents().then(setContents);
  }, [phase]);

  const rebuild = useCallback(async () => {
    setNotice(null);
    await saveSystemMapExclusions(exclusions);
    await start(exclusions);
  }, [exclusions, start]);

  const openExclusions = useCallback(() => {
    setNotice(null);
    setMode('exclusions');
  }, []);

  return (
    <div className={cardCls}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-henry-text">System map</h3>
          <p className="text-[11px] text-henry-text-muted mt-1 leading-relaxed max-w-prose">
            A one-time inventory of this computer — drives, applications, folders, files,
            development tools and AI software — so Henry knows what is here instead of
            looking again each time. It records file names, types, sizes and dates, never
            file contents.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={openExclusions}
            disabled={scanning}
            className={buttonCls}
          >
            Exclusions
          </button>
          <button
            type="button"
            onClick={() => void rebuild()}
            disabled={!loaded || scanning || !contents}
            className={buttonCls}
            title={
              contents
                ? 'Scan this computer again'
                : 'No system map has been built yet — build one from first-run setup'
            }
          >
            {scanning ? 'Scanning…' : 'Rebuild System Map'}
          </button>
        </div>
      </div>

      {!loaded && (
        <p className="text-[11px] text-henry-text-muted mt-3">Reading the system map…</p>
      )}

      {loaded && !contents && mode === 'contents' && (
        <p className="text-[11px] text-henry-text-muted mt-3">
          No system map has been built on this computer yet. Build one from first-run
          setup, or skip it — Henry works without one.
        </p>
      )}

      {notice && <p className="text-[11px] text-henry-text-muted mt-3">{notice}</p>}

      <div className="mt-4 space-y-4">
        {scanning && (
          <>
            <ScanProgressView progress={progress} />
            <button type="button" onClick={() => void cancel()} className={buttonCls}>
              Cancel scan
            </button>
          </>
        )}

        {phase === 'failed' && error && (
          <p className="text-[11px] text-red-400">That scan did not finish: {error}</p>
        )}

        {phase === 'cancelled' && (
          <p className="text-[11px] text-henry-text-muted">
            Scan cancelled. The existing map was left as it was.
          </p>
        )}

        {mode === 'exclusions' && !scanning && (
          <>
            <ExclusionsEditor
              exclusions={exclusions}
              onChange={setExclusions}
              available={DEFAULT_EXCLUSION_CATEGORIES}
            />
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void rebuild()} className={buttonCls}>
                {contents ? 'Save and rebuild' : 'Save exclusions'}
              </button>
              <button
                type="button"
                onClick={() => {
                  void saveSystemMapExclusions(exclusions);
                  setNotice('Exclusions saved. They apply to the next scan.');
                  setMode('contents');
                }}
                className={buttonCls}
              >
                Save exclusions
              </button>
              <button type="button" onClick={() => setMode('contents')} className={buttonCls}>
                Back
              </button>
            </div>
          </>
        )}

        {mode === 'contents' && contents && !scanning && (
          <>
            <MapContentsView contents={contents} />
            <RuntimeOffers />
          </>
        )}
      </div>
    </div>
  );
}