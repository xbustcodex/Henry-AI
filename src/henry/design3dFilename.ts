/**
 * Suggested filenames for Design3D plan saves (workspace-relative).
 */

import type { Design3DWorkflowTypeId } from './design3dTypes';
import { getDesign3DWorkflowType } from './design3dTypes';

function sanitizeFilenameSegment(segment: string): string {
  return segment
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

const WORKFLOW_FILENAME_LABEL: Partial<Record<Design3DWorkflowTypeId, string>> = {
  stl_3mf_handoff: 'STL Handoff',
  print_prep_plan: 'Print Prep Plan',
  reverse_engineer_object: 'Reverse Eng Plan',
  custom_part_design: 'Design3D Plan',
  fit_check_revision: 'Fit Check Plan',
  openscad_starter: 'OpenSCAD Plan',
};

export function buildHenryDesign3DFilename(
  workflowId: Design3DWorkflowTypeId,
  options?: { date?: Date; version?: number }
): string {
  const w = getDesign3DWorkflowType(workflowId);
  const label = sanitizeFilenameSegment(
    WORKFLOW_FILENAME_LABEL[workflowId] ?? w?.label ?? 'Design3D Plan'
  );
  const d = options?.date ?? new Date();
  const monthYear = d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
  const v = options?.version ?? 1;
  return sanitizeFilenameSegment(`Henry AI – ${label} – ${monthYear} v${v}.md`) || 'Henry-AI-Design3D.md';
}

export const HENRY_DESIGN3D_SUBDIR = 'Henry-Design3D';

export function defaultDesign3DPlanRelativePath(workflowId: Design3DWorkflowTypeId): string {
  return `${HENRY_DESIGN3D_SUBDIR}/${buildHenryDesign3DFilename(workflowId)}`;
}
