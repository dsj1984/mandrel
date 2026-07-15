# Sizing capacity calibration fixture

This fixture captures a delivered Epic body (the model-evolution
recalibration Epic #3865) used to prove the v2 **model-capacity** split
advisory. Historical A/B file-ceiling plans (`plan.old.json` /
`plan.new.json`) remain as archival shape from Story #3877; the live gate
asserts every Story in `plan.new.json` fits `DEFAULT_MODEL_CAPACITY`.

## What the capacity profile represents

`profiles.json` → `capacity` mirrors `DEFAULT_MODEL_CAPACITY` in
`.agents/scripts/lib/orchestration/ticket-validator-sizing.js` and is
drift-gated by `tests/sizing-ab-calibration.test.js`. Absolute token
ceilings are fixed authored-token counts (soft 30k / hard 75k).

Per-Story file/AC ceilings (`softFiles` / `hardFiles` /
`softAcceptanceCount`) are retired. The validator scores estimated
**session mass** against those absolute ceilings.
