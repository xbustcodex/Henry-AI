/**
 * Lightweight file reference hint for Design3D (Files tab selection via localStorage).
 */

export const HENRY_LAST_WORKSPACE_FILE_KEY = 'henry_last_workspace_file';

export const HENRY_DESIGN3D_REF_CHANGED_EVENT = 'henry-design3d-ref-changed';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tif|tiff|heic|svg)$/i;
const MODEL_EXT = /\.(stl|3mf|obj|step|stp|iges|igs|scad|fcstd|blend)$/i;

/** Shown in UI and prompts — honest limits. */
export const DESIGN3D_REFERENCE_LIMITATIONS_LINE =
  'Reference files guide the plan; exact dimensions still require direct measurement. Henry only sees the path here — not file contents unless you paste or describe them.';

export type Design3DReferenceKind = 'image' | 'model' | 'document';

export function readLastWorkspaceFilePath(): string | null {
  try {
    const raw = localStorage.getItem(HENRY_LAST_WORKSPACE_FILE_KEY)?.trim();
    return raw || null;
  } catch {
    return null;
  }
}

/** Persist active Design3D reference and notify listeners (same-tab). */
export function setDesign3dReferencePath(path: string): void {
  const p = path.trim();
  if (!p) return;
  try {
    localStorage.setItem(HENRY_LAST_WORKSPACE_FILE_KEY, p);
    window.dispatchEvent(
      new CustomEvent(HENRY_DESIGN3D_REF_CHANGED_EVENT, { detail: { path: p } })
    );
  } catch {
    /* ignore */
  }
}

export function clearDesign3dReferencePath(): void {
  try {
    localStorage.removeItem(HENRY_LAST_WORKSPACE_FILE_KEY);
    window.dispatchEvent(
      new CustomEvent(HENRY_DESIGN3D_REF_CHANGED_EVENT, { detail: { path: null } })
    );
  } catch {
    /* ignore */
  }
}

export function classifyReferencePath(relativePath: string): Design3DReferenceKind {
  const base = relativePath.split('/').pop() || relativePath;
  if (IMAGE_EXT.test(base)) return 'image';
  if (MODEL_EXT.test(base)) return 'model';
  return 'document';
}

export function referenceKindLabel(kind: Design3DReferenceKind): string {
  if (kind === 'image') return 'Likely image';
  if (kind === 'model') return 'Likely 3D / CAD-related';
  return 'Likely document / other';
}

/** One-line hint for memory block: file name + kind. */
export function describeReferencePathHint(relativePath: string): string {
  const base = relativePath.split('/').pop() || relativePath;
  const kind = classifyReferencePath(relativePath);
  const kindShort = kind === 'image' ? 'image' : kind === 'model' ? '3D/mesh-related' : 'file';
  return `\`${relativePath}\` (${kindShort})`;
}

export function buildDesign3dReferenceFilesNote(paths: string[]): string | null {
  const unique = [...new Set(paths.map((p) => p.trim()).filter(Boolean))];
  if (unique.length === 0) return null;
  const lines = unique.map(describeReferencePathHint);
  return `Reference files (Design3D reference — Henry cannot see file contents in chat unless you paste or describe them): ${lines.join('; ')}`;
}

/**
 * Extra system-prompt section: active reference + honesty + measurement ask.
 */
export function buildDesign3dReferencePromptSection(
  referencePath: string | null,
  workflowLabel: string
): string {
  const honesty =
    'Unknown geometry must stay unknown. When fit, mating, or tolerances matter, explicitly request **measured** dimensions (calipers, CAD, drawing) and keep **estimates** labeled with uncertainty — especially from a single image.';

  if (!referencePath?.trim()) {
    return `## Active Design3D reference
- **None selected.** The user may set a workspace file as the Design3D reference from the Files tab.
- Active workflow (UI): **${workflowLabel}**
- ${DESIGN3D_REFERENCE_LIMITATIONS_LINE}
- ${honesty}`;
  }

  const p = referencePath.trim();
  const kind = classifyReferencePath(p);
  return `## Active Design3D reference
- **Path:** \`${p}\`
- **Heuristic type:** ${referenceKindLabel(kind)} (from extension only — not content analysis)
- **Active workflow (UI):** **${workflowLabel}**
- ${DESIGN3D_REFERENCE_LIMITATIONS_LINE}
- ${honesty}`;
}

/** Plain text for “Copy reference summary” in the UI. */
export function buildDesign3dReferenceSummaryPlain(
  referencePath: string | null,
  workflowLabel: string
): string {
  return buildDesign3dReferencePromptSection(referencePath, workflowLabel);
}
