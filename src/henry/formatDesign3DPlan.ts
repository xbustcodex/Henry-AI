/**
 * Lightweight markdown scaffold for Design3D planning outputs.
 */

import type { Design3DWorkflowTypeId } from './design3dTypes';
import { getDesign3DWorkflowType } from './design3dTypes';

/** Canonical section set for generic plans (workflows may override via suggestedSections). */
export const DESIGN3D_PLAN_SECTIONS = [
  'Object / Part Goal',
  'Visible Features',
  'Measured Dimensions',
  'Estimated Dimensions',
  'Uncertain Areas',
  'Recommended Modeling Path',
  'STL / 3MF Plan',
  'Printability Notes',
  'Confidence / Risk Notes',
] as const;

export function getDesign3DPlanScaffoldMarkdown(workflowId: Design3DWorkflowTypeId): string {
  const w = getDesign3DWorkflowType(workflowId);
  const sections = w?.suggestedSections.length ? w.suggestedSections : [...DESIGN3D_PLAN_SECTIONS];
  const lines: string[] = [`# Design3D plan — ${w?.label ?? 'Plan'}`, '', `*${w?.description ?? ''}*`, ''];
  for (const section of sections) {
    lines.push(`## ${section}`, '', '_…_', '');
  }
  return lines.join('\n').trimEnd() + '\n';
}
