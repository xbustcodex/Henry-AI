/**
 * The exclusion editor — the screen between "Henry would like to scan" and the
 * scan itself.
 *
 * ── Why this exists as its own component ───────────────────────────────────
 *
 * The consent that makes a system map acceptable is not the click on "Build
 * System Map". It is that the person can see, in their own words, what is being
 * left out, change it, and only then let the scan begin. A single confirm
 * dialog cannot carry that: it hides the list behind a second click, and the
 * list is the whole substance of the decision.
 *
 * So the editor is *inside* the stage, before the primary action, not behind
 * it. `onChange` fires immediately — there is no separate "save exclusions"
 * step to forget — and the set the user is looking at is the exact set handed
 * to `startSystemMapScan`.
 *
 * Everything is described in the user's language. A category is "Other people's
 * folders", never `/home/*`; a path the user typed themselves is shown back
 * verbatim, because that one *is* a path and pretending otherwise would make it
 * harder to check.
 */

import { useId, useState } from 'react';
import {
  addFolderExclusion,
  includeCategory,
  removeFolderExclusion,
  type SystemMapExclusionCategory,
  type SystemMapExclusions,
} from '../../henry/systemMap';
import {
  STAGE_CONTROL,
  STAGE_PROSE_LEADING,
  StageCard,
  StageTextAction,
} from '../onboarding/layout';

const rowCls = 'flex items-center justify-between gap-4 rounded-xl border border-henry-border/40 px-4 py-3';
const metaCls = 'text-xs text-henry-text-muted';

interface Props {
  exclusions: SystemMapExclusions;
  onChange: (next: SystemMapExclusions) => void;
  /** Locked while a scan runs — the set cannot change under the scan. */
  disabled?: boolean;
  /**
   * The catalogue of categories that can be excluded. Passed in so a build with
   * no scanner still offers the same choices; it defaults to Henry's own list.
   */
  available?: readonly SystemMapExclusionCategory[];
}

export default function ExclusionsEditor({
  exclusions,
  onChange,
  disabled = false,
  available,
}: Props) {
  const [folderDraft, setFolderDraft] = useState('');
  const folderInputId = useId();

  // A category the user has switched off is still a choice they made, so it is
  // still listed — dashed, marked "included" — rather than vanishing and making
  // the row count lie about how much was excluded.
  const offList = (available ?? []).filter(
    (c) => !exclusions.categories.some((e) => e.id === c.id),
  );

  function addFolder() {
    const next = addFolderExclusion(exclusions, folderDraft);
    if (next === exclusions) return;
    onChange(next);
    setFolderDraft('');
  }

  return (
    <StageCard label="What the scan will leave out">
      <div className="space-y-5">
        <p className={`text-sm text-henry-text-dim ${STAGE_PROSE_LEADING}`}>
          These are Henry&rsquo;s starting suggestions. Change any of them — anything you
          take off this list will be scanned instead.
        </p>

        <div className="space-y-2">
          {exclusions.categories.length === 0 && (
            <p className={metaCls}>Nothing is excluded by category. The whole disk is scanned.</p>
          )}

          {exclusions.categories.map((category) => (
            <div key={category.id} className={rowCls}>
              <div className="min-w-0">
                <p className="text-sm text-henry-text">{category.label}</p>
                {category.isDefault && <p className={`${metaCls} mt-0.5`}>excluded by default</p>}
              </div>
              <StageTextAction
                type="button"
                disabled={disabled}
                onClick={() => onChange(includeCategory(exclusions, category.id))}
                className="shrink-0 text-xs disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Scan it anyway
              </StageTextAction>
            </div>
          ))}

          {offList.map((category) => (
            <div key={category.id} className={`${rowCls} border-dashed opacity-70`}>
              <div className="min-w-0">
                <p className="text-sm text-henry-text-muted line-through">{category.label}</p>
                <p className={`${metaCls} mt-0.5`}>included in the scan</p>
              </div>
              <StageTextAction
                type="button"
                disabled={disabled}
                onClick={() => onChange({ ...exclusions, categories: [...exclusions.categories, category] })}
                className="shrink-0 text-xs disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Exclude again
              </StageTextAction>
            </div>
          ))}
        </div>

        <div className="border-t border-henry-border/30 pt-5 space-y-3">
          <label htmlFor={folderInputId} className="text-sm text-henry-text block">
            Folders to leave out
          </label>
          <p className={`${metaCls} ${STAGE_PROSE_LEADING}`}>
            Add anything else you would rather Henry did not look inside — a project
            folder, a personal directory. Paste the full path.
          </p>

          {exclusions.folders.length > 0 && (
            <ul className="space-y-2">
              {exclusions.folders.map((folder) => (
                <li key={folder.path} className={rowCls}>
                  <span className="text-xs font-mono text-henry-text truncate" title={folder.path}>
                    {folder.path}
                  </span>
                  <StageTextAction
                    type="button"
                    disabled={disabled}
                    onClick={() => onChange(removeFolderExclusion(exclusions, folder.path))}
                    className="shrink-0 text-xs text-red-300 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Remove
                  </StageTextAction>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col sm:flex-row gap-3">
            <input
              id={folderInputId}
              type="text"
              value={folderDraft}
              disabled={disabled}
              onChange={(e) => setFolderDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addFolder();
                }
              }}
              placeholder="/path/to/folder"
              aria-label="Folder to leave out"
              className={`${STAGE_CONTROL} font-mono text-xs`}
            />
            <StageTextAction
              type="button"
              disabled={disabled || !folderDraft.trim()}
              onClick={addFolder}
              className="shrink-0 rounded-xl border border-henry-border/50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Add folder
            </StageTextAction>
          </div>
        </div>
      </div>
    </StageCard>
  );
}