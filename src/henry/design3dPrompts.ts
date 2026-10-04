/**
 * Design3D mode — system prompt additions (honest metrology, STL/3MF, CAD paths).
 */

import type { Design3DWorkflowTypeId } from './design3dTypes';
import { DEFAULT_DESIGN3D_WORKFLOW_TYPE_ID, getDesign3DWorkflowType } from './design3dTypes';
import { getDesign3DPlanScaffoldMarkdown } from './formatDesign3DPlan';
import { buildDesign3dReferencePromptSection } from './design3dReferenceContext';

export function getDesign3DModeInstruction(workflowId?: Design3DWorkflowTypeId): string {
  return `You are Henry in Design3D mode: calm, wise, strong, and direct. Help with physical parts, CAD thinking, and print pipelines — without pretending images yield exact dimensions.

Truth rules:
- **Measured** dimensions require a stated source (calipers, drawing, CAD constraint, etc.). Label them explicitly.
- **Estimated** dimensions are guesses from photos, eyeballing, or analogy — label them as estimates and give uncertainty ranges when useful.
- **Uncertain** features: call them out; do not fill gaps with false precision.
- Never claim exact replication or sub-mm accuracy from a single image alone.
- Prefer structured markdown: short sections, bullets, checklists for print prep.
- STL is ubiquitous; **3MF** can carry units, materials, and multiple objects — mention when relevant.
- OpenSCAD, parametric CAD, or mesh tools are fair game as *guidance*; you are not executing CAD here.
- Think about printability: overhangs, supports, wall thickness, tolerances, elephant foot, bed adhesion.`;
}

export function getDesign3DScaffoldHint(workflowId: Design3DWorkflowTypeId): string {
  const id =
    workflowId && getDesign3DWorkflowType(workflowId) ? workflowId : DEFAULT_DESIGN3D_WORKFLOW_TYPE_ID;
  const w = getDesign3DWorkflowType(id)!;
  const flow = w.suggestedSections.join(' → ');
  return `Active Design3D workflow: **${w.label}** — ${w.description}
Suggested section flow: ${flow}.
Image references expected: **${w.imageReferencesExpected ? 'yes — remind user photos are not calibrated unless they say so' : 'optional'}**.
Measurements: **${w.measurementsRequired ? 'treat real measurements as required for final dimensions; separate from estimates' : 'still label measured vs estimated whenever numbers appear'}**.`;
}

export interface BuildDesign3DSystemAdditionOptions {
  workflowId?: Design3DWorkflowTypeId;
  /** Workspace-relative or absolute path; contents are not loaded — honesty block still applies. */
  referencePath?: string | null;
}

export function buildDesign3DSystemAddition(
  options?: BuildDesign3DSystemAdditionOptions | Design3DWorkflowTypeId
): string {
  const opts: BuildDesign3DSystemAdditionOptions =
    typeof options === 'string' || options === undefined
      ? { workflowId: options }
      : options;
  const id =
    opts.workflowId && getDesign3DWorkflowType(opts.workflowId)
      ? opts.workflowId
      : DEFAULT_DESIGN3D_WORKFLOW_TYPE_ID;
  const w = getDesign3DWorkflowType(id)!;
  const scaffold = getDesign3DPlanScaffoldMarkdown(id);
  const refPath =
    typeof opts.referencePath === 'string' && opts.referencePath.trim()
      ? opts.referencePath.trim()
      : null;
  const refSection = buildDesign3dReferencePromptSection(refPath, w.label);
  const objectFraming = `**Object / use-case framing:** Ask the user to state what the part must **do**, critical **interfaces** / mates, material and printer constraints, and any **measured** data they already have. If the goal is ambiguous, ask short clarifying questions before treating estimates as specs.`;

  return `${getDesign3DModeInstruction(id)}

${getDesign3DScaffoldHint(id)}

${refSection}

${objectFraming}

Optional empty scaffold (replace if redundant with user content):
\`\`\`markdown
${scaffold.trimEnd()}
\`\`\``;
}
