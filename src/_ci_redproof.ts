// DELIBERATE CI RED-PROOF — do NOT merge.
// Implicit-any parameter: fails `tsc --noEmit` under strictest (TS7006),
// proving the `quality (typecheck)` gate goes red in CI. Delete after the proof.
export const broken = (x) => x * 2;
