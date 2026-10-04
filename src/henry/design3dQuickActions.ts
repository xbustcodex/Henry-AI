/**
 * Quick-start prompts for Design3D mode — switch workflow + seed composer.
 */

import type { Design3DWorkflowTypeId } from './design3dTypes';
import { DESIGN3D_REFERENCE_LIMITATIONS_LINE } from './design3dReferenceContext';

export interface Design3DQuickAction {
  id: string;
  workflowId: Design3DWorkflowTypeId;
  label: string;
  buildPrompt: (referencePath: string | null) => string;
}

function refLine(path: string | null): string {
  if (path?.trim()) {
    return `Workspace reference path (Henry does not auto-load file contents): \`${path.trim()}\`. I can describe what I see if you paste details or dimensions.`;
  }
  return 'No reference file is set yet — describe the object or set a reference in the Files tab.';
}

export const DESIGN3D_QUICK_ACTIONS: Design3DQuickAction[] = [
  {
    id: 'reverse',
    workflowId: 'reverse_engineer_object',
    label: 'Reverse engineer object',
    buildPrompt: (path) =>
      `${refLine(path)}

Work through a **reverse-engineering** plan for this object. Infer only what is justified from my description/reference; **never** claim sub-mm or exact geometry from a photo alone. Separate **measured** (with how it was measured) vs **estimated** (with range/uncertainty). Cover: visible features, uncertain areas, recommended CAD path, STL/3MF export plan, printability, and confidence/risk.

${DESIGN3D_REFERENCE_LIMITATIONS_LINE}`,
  },
  {
    id: 'custom_part',
    workflowId: 'custom_part_design',
    label: 'Design custom part',
    buildPrompt: (path) =>
      `${refLine(path)}

Help me **design a custom part** from requirements I’ll state below. Keep **requirements vs assumptions** explicit; whenever dimensions matter for fit, ask for **measured** inputs and treat everything else as labeled estimates.

${DESIGN3D_REFERENCE_LIMITATIONS_LINE}`,
  },
  {
    id: 'fit_check',
    workflowId: 'fit_check_revision',
    label: 'Fit-check revision',
    buildPrompt: (path) =>
      `${refLine(path)}

I need a **fit check / revision** cycle. Summarize the current design intent, the fit issue, what was **measured**, proposed dimensional changes (with tolerance thinking), and a reprint/re-export checklist. No false precision.

${DESIGN3D_REFERENCE_LIMITATIONS_LINE}`,
  },
  {
    id: 'stl_handoff',
    workflowId: 'stl_3mf_handoff',
    label: 'STL / 3MF handoff',
    buildPrompt: (path) =>
      `${refLine(path)}

Produce an **STL / 3MF handoff** checklist: units/scale, manifold expectations, naming, validation steps, and slicer notes. State clearly what cannot be verified without the actual mesh files.

${DESIGN3D_REFERENCE_LIMITATIONS_LINE}`,
  },
];
