/**
 * Live scan progress.
 *
 * ── Why the bar is allowed to be indeterminate ──────────────────────────────
 *
 * A filesystem walk does not know how many files are ahead of it until it has
 * walked the tree — and the scanner does not pretend otherwise: `totalFiles`
 * arrives null on every event, on the first crawl and on the incremental
 * rebuild alike. Drawing a bar against a guessed total, or against a count that
 * only grows because the scan itself is growing it, is the kind of small lie
 * that makes people wait on a progress bar. So the bar stays indeterminate and
 * says so, rather than implying a number is on its way.
 *
 * The determinate branch is kept because the field is nullable for a reason and
 * a build that *can* count ahead should not have to lie about not being able to.
 *
 * Counts are rendered as plain numbers and the *current folder* is named,
 * because "is it stuck or is it working?" is answered by knowing where it is.
 */

import { formatBytes, type SystemMapScanProgress } from '../../henry/systemMap';
import { StageCard, STAGE_PROSE_LEADING } from '../onboarding/layout';

const statCls = 'rounded-xl border border-henry-border/40 px-4 py-3';
const statValueCls = 'text-lg font-semibold text-henry-text tabular-nums';
const statLabelCls = 'text-[11px] uppercase tracking-wider text-henry-text-muted mt-0.5';

export default function ScanProgressView({
  progress,
}: {
  progress: SystemMapScanProgress | null;
}) {
  const total = progress?.totalFiles ?? null;
  const scanned = progress?.filesScanned ?? 0;
  // Null means "the scanner cannot say how much is left", which is a different
  // claim from 0% and must not be drawn as an empty track that looks finished.
  const percent =
    total && total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : null;

  return (
    <StageCard label="Scanning…">
      <div className="space-y-5">
        <div>
          <div
            role="progressbar"
            aria-label="Scan progress"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(percent === null
              ? {}
              : { 'aria-valuenow': percent, 'aria-valuetext': `${percent}% complete` })}
            className="h-2 w-full rounded-full bg-henry-bg overflow-hidden border border-henry-border/40"
          >
            {percent === null ? (
              <div className="h-full w-1/3 rounded-full bg-henry-accent animate-pulse" />
            ) : (
              <div
                className="h-full rounded-full bg-henry-accent transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            )}
          </div>
          <p className={`text-xs text-henry-text-muted mt-2 ${STAGE_PROSE_LEADING}`}>
            {percent === null
              ? `No total to work towards — ${scanned.toLocaleString()} files found so far.`
              : `${percent}% — ${scanned.toLocaleString()} of ${total!.toLocaleString()} files`}
          </p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className={statCls}>
            <p className={statValueCls}>{scanned.toLocaleString()}</p>
            <p className={statLabelCls}>files seen</p>
          </div>
          <div className={statCls}>
            <p className={statValueCls}>{formatBytes(progress?.bytesScanned ?? 0)}</p>
            <p className={statLabelCls}>size seen</p>
          </div>
          <div className={statCls}>
            <p className={statValueCls}>{(progress?.foldersScanned ?? 0).toLocaleString()}</p>
            <p className={statLabelCls}>folders</p>
          </div>
          <div className={statCls}>
            <p className={statValueCls}>{(progress?.appsFound ?? 0).toLocaleString()}</p>
            <p className={statLabelCls}>applications</p>
          </div>
        </div>

        {progress?.currentFolder && (
          <p className={`text-xs text-henry-text-muted font-mono truncate ${STAGE_PROSE_LEADING}`}>
            Now reading <span className="text-henry-text-dim">{progress.currentFolder}</span>
          </p>
        )}

        {!progress && (
          <p className={`text-xs text-henry-text-muted ${STAGE_PROSE_LEADING}`}>
            Starting the scan. This usually takes under a minute.
          </p>
        )}
      </div>
    </StageCard>
  );
}