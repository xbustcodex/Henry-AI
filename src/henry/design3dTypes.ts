/**
 * Design3D / CAD / print-planning workflows (no mesh generation in-app).
 */

export interface Design3DWorkflowType {
  id: string;
  label: string;
  description: string;
  readonly suggestedSections: readonly string[];
  /** User may reference photos, renders, or screenshots */
  imageReferencesExpected: boolean;
  /** Prompt should insist on real measurements vs estimates when this is true */
  measurementsRequired: boolean;
}

export const DESIGN3D_WORKFLOW_TYPES = [
  {
    id: 'reverse_engineer_object',
    label: 'Reverse-engineer object',
    description: 'Infer geometry from references; never claim pixel-perfect dimensions without measurement.',
    suggestedSections: [
      'Object / Part Goal',
      'Visible features',
      'Measured dimensions',
      'Estimated dimensions',
      'Uncertain areas',
      'Recommended modeling path',
      'STL / 3MF plan',
      'Printability notes',
      'Confidence / risk',
    ],
    imageReferencesExpected: true,
    measurementsRequired: true,
  },
  {
    id: 'custom_part_design',
    label: 'Custom part design',
    description: 'Design a new part from requirements; separate spec vs assumption.',
    suggestedSections: [
      'Requirements',
      'Constraints & interfaces',
      'Measured vs assumed dimensions',
      'Modeling approach (CAD / OpenSCAD)',
      'Export plan (STL / 3MF)',
      'Verification steps',
    ],
    imageReferencesExpected: false,
    measurementsRequired: true,
  },
  {
    id: 'fit_check_revision',
    label: 'Fit check / revision',
    description: 'Iterate clearances, tolerances, and test fits; document what was measured.',
    suggestedSections: [
      'Current design summary',
      'Fit issue',
      'Measured data',
      'Proposed change',
      'Reprint / re-export checklist',
    ],
    imageReferencesExpected: true,
    measurementsRequired: true,
  },
  {
    id: 'print_prep_plan',
    label: 'Print prep plan',
    description: 'Slicer-oriented plan: orientation, supports, material, layer height, checks.',
    suggestedSections: [
      'Model source',
      'Target printer / material',
      'Orientation & supports',
      'Layer height / infill notes',
      'Pre-flight checklist',
      'Post-processing',
    ],
    imageReferencesExpected: false,
    measurementsRequired: false,
  },
  {
    id: 'openscad_starter',
    label: 'OpenSCAD starter',
    description: 'Parametric sketch guidance; parameters vs hard-coded magic numbers.',
    suggestedSections: [
      'Parameters',
      'Module breakdown',
      'Draft OpenSCAD outline',
      'Export notes',
    ],
    imageReferencesExpected: false,
    measurementsRequired: false,
  },
  {
    id: 'stl_3mf_handoff',
    label: 'STL / 3MF handoff',
    description: 'Explicit handoff: units, manifold expectations, naming, and validation.',
    suggestedSections: [
      'Units & scale',
      'Mesh expectations (manifold, normals)',
      'File naming',
      'Validation steps (mesh tools)',
      'Downstream slicer notes',
    ],
    imageReferencesExpected: false,
    measurementsRequired: false,
  },
] as const satisfies readonly Design3DWorkflowType[];

export type Design3DWorkflowTypeId = (typeof DESIGN3D_WORKFLOW_TYPES)[number]['id'];

export const DESIGN3D_WORKFLOW_TYPE_IDS = DESIGN3D_WORKFLOW_TYPES.map((w) => w.id) as Design3DWorkflowTypeId[];

export const DEFAULT_DESIGN3D_WORKFLOW_TYPE_ID: Design3DWorkflowTypeId = 'custom_part_design';

export function isDesign3DWorkflowTypeId(value: string): value is Design3DWorkflowTypeId {
  return (DESIGN3D_WORKFLOW_TYPE_IDS as readonly string[]).includes(value);
}

export function getDesign3DWorkflowType(id: string): Design3DWorkflowType | undefined {
  return DESIGN3D_WORKFLOW_TYPES.find((w) => w.id === id);
}
