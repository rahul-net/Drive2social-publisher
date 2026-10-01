// Create Post wizard — 7-step shell (Phase 7).
//
// All 7 steps are fully implemented:
//   1. Select video   — Drive picker
//   2. Preview        — signed preview URL + file facts
//   3. Generate       — Gemini AI metadata generation
//   4. Edit metadata  — fully editable form
//   5. Destinations   — YouTube channel / Facebook Page selection
//   6. Settings       — privacy, category, kids flag, notify, Page
//   7. Review & publish — summary, duplicate protection, enqueue

export interface WizardStepDef {
  n: number;
  id: string;
  label: string;
  /** Reserved for future phases that add placeholder steps. */
  comingSoon: boolean;
}

export const WIZARD_STEPS: WizardStepDef[] = [
  { n: 1, id: "select", label: "Select video", comingSoon: false },
  { n: 2, id: "preview", label: "Preview", comingSoon: false },
  { n: 3, id: "generate", label: "Generate metadata", comingSoon: false },
  { n: 4, id: "edit", label: "Edit metadata", comingSoon: false },
  { n: 5, id: "destinations", label: "Destinations", comingSoon: false },
  { n: 6, id: "settings", label: "Settings", comingSoon: false },
  { n: 7, id: "review", label: "Review & publish", comingSoon: false },
];
