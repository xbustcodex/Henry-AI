/**
 * Small metadata prefix for saved Design3D markdown plans.
 */

import type { Design3DWorkflowTypeId } from './design3dTypes';
import { getDesign3DWorkflowType } from './design3dTypes';

export function prependDesign3dPlanMetadata(
  body: string,
  meta: { workflowId: Design3DWorkflowTypeId; referencePath: string | null }
): string {
  const w = getDesign3DWorkflowType(meta.workflowId);
  const when = new Date().toISOString();
  const lines = [
    '<!--',
    'Henry Design3D plan',
    `workflow: ${w?.label ?? meta.workflowId}`,
    meta.referencePath?.trim()
      ? `reference: ${meta.referencePath.trim()}`
      : 'reference: (none)',
    `generated: ${when}`,
    'generated_by: Henry AI (Design3D mode)',
    'measured_vs_estimated: Label every number; measured needs a source. Estimates are not exact — especially from images alone.',
    '-->',
    '',
  ];
  return `${lines.join('\n')}${body.trimStart()}`;
}
