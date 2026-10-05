/**
 * What the map currently contains.
 *
 * The point of this view is that the system map is not a black box. Henry
 * claims to know about this computer; the user is entitled to see the shape of
 * that claim — how many files, how big, which applications, which development
 * tools, which AI software, when it was built — and, just as importantly, to
 * see that it is EMPTY when nothing has been built yet.
 *
 * Every number here is metadata Henry collected: names, types, sizes, dates.
 * Nothing in this component can display file content, because the map does not
 * contain any.
 */

import { formatBytes, type SystemMapContents, type SystemMapEntrySummary } from '../../henry/systemMap';
import { StageCard, STAGE_PROSE_LEADING } from '../onboarding/layout';

function EntryList({
  title,
  entries,
  empty,
}: {
  title: string;
  entries: SystemMapEntrySummary[];
  empty: string;
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-widest text-henry-text-muted">{title}</p>
      {entries.length === 0 ? (
        <p className={`text-sm text-henry-text-muted mt-2 ${STAGE_PROSE_LEADING}`}>{empty}</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-2">
          {entries.map((entry) => (
            <li
              key={entry.name}
              className="rounded-lg border border-henry-border/40 px-3 py-1.5 text-xs text-henry-text-dim"
            >
              {entry.name}
              {entry.version && (
                <span className="text-henry-text-muted font-mono ml-1.5">{entry.version}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function MapContentsView({ contents }: { contents: SystemMapContents }) {
  const built = new Date(contents.builtAt);
  const topTypes = [...contents.fileTypes].sort((a, b) => b.count - a.count).slice(0, 8);

  return (
    <StageCard label="What Henry now knows about this computer" tone="success">
      <div className="space-y-5">
        <p className={`text-sm text-henry-text-dim ${STAGE_PROSE_LEADING}`}>
          Built {built.toLocaleString()} from {contents.fileCount.toLocaleString()} files totalling{' '}
          {formatBytes(contents.totalBytes)}. This is the whole inventory — there is nothing
          hidden inside it.
        </p>

        <EntryList
          title={`Applications (${contents.apps.length})`}
          entries={contents.apps}
          empty="No applications were identified."
        />
        <EntryList
          title={`Development tools (${contents.devTools.length})`}
          entries={contents.devTools}
          empty="No development tools were identified."
        />
        <EntryList
          title={`AI software (${contents.aiSoftware.length})`}
          entries={contents.aiSoftware}
          empty="No AI software was identified."
        />

        {topTypes.length > 0 && (
          <div>
            <p className="text-[11px] uppercase tracking-widest text-henry-text-muted">
              Most common file types
            </p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {topTypes.map((type) => (
                <li
                  key={type.type}
                  className="rounded-lg border border-henry-border/40 px-3 py-1.5 text-xs text-henry-text-dim"
                >
                  <span className="font-mono">{type.type}</span>
                  <span className="text-henry-text-muted ml-1.5">
                    {type.count.toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {contents.folders.length > 0 && (
          <div>
            <p className="text-[11px] uppercase tracking-widest text-henry-text-muted">
              Folders inventoried ({contents.folders.length})
            </p>
            <ul className="mt-2 space-y-1.5">
              {contents.folders.map((folder) => (
                <li key={folder.path} className="text-xs flex justify-between gap-4">
                  <span className="font-mono text-henry-text-dim truncate" title={folder.path}>
                    {folder.label || folder.path}
                  </span>
                  <span className="text-henry-text-muted shrink-0 tabular-nums">
                    {folder.fileCount.toLocaleString()} files · {formatBytes(folder.totalBytes)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </StageCard>
  );
}