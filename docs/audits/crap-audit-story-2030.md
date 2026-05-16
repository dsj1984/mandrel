# CRAP Audit — Story #2030

Source: `baselines/crap.json` (filtered rows with `crap > 20`). Generated
2026-05-16 against `story-2030` branch.

The framework default ceiling is **CRAP ≤ 20**. `.agentrc.json` currently
relaxes this to 30 via `delivery.quality.gates.crap.floors['*']`; Story
#2030 removes that override. Each row below is classified as **refactor**
(the score should clear ≤ 20 with a reasonable extract-method / guard-clause
change) or **override** (the complexity is structural — a per-path floor
with a follow-up issue is the correct disposition).

## Methods with CRAP > 20

| File | Method | Score | Disposition | Notes |
| --- | --- | --- | --- | --- |
| `.agents/scripts/lib/baselines/preview-gates.js` | `runCrapPreview` | 127.63 | override | Orchestration entry-point: resolves config, loads baseline, scans, compares, and builds an envelope. Each branch is structural (enabled-flag, diff scope, env overrides). Coverage gap (no unit harness around the preview adapter) drives the bulk of the score; refactor would just shuffle branches across helpers without removing them. Track under follow-up issue. |
| `.agents/scripts/lib/gates/gate-cli.js` | `resolveScopedRef` | 81.33 | refactor | 5-tier precedence chain (`--full-scope` → `--changed-since` → env primary/secondary → config.defaultScope → config.diffRef → default). Each clause is a guard return; extracting two helpers (`fromArgv`, `fromEnv`) collapses the cyclomatic count cleanly. |
| `.agents/scripts/lib/baselines/kinds/crap.js` | `evaluateBaselineCompatibility` | 52.33 | override | Multi-axis version-compat decision matrix (missing baseline / escomplex / kernel / tsTranspiler). Each branch returns a distinct operator-facing message tied to a documented Story (#791, #829). Splitting harms readability; coverage is the real driver. |
| `.agents/scripts/lib/baselines/diff-scope-cli.js` | `readPriorBaselineRows` | 30.88 | refactor | Two-kind dispatcher (`crap`, `maintainability`) with envelope + legacy-flat-map fallbacks for MI. Extracting a `parseMaintainabilityRows` helper clears the score. |
| `.agents/scripts/check-baselines.js` | `tolerantNumericFields` | 30.00 | refactor | Tiny helper that filters numeric fields out of two objects. CRAP inflated by `for…of` + nested type-checks; an `Object.entries(...).filter(...)` rewrite drops it. |
| `.agents/scripts/check-dead-exports.js` | `runKnip` | 27.32 | override | Spawns the `knip` CLI and parses JSON. Branches are all error-handling (spawn error, empty stdout, parse failure). Subprocess paths cannot be unit-exercised end-to-end; coverage gap is structural. |
| `.agents/scripts/lib/quality-floors.js` | `parseFloorFlag` | 24.06 | refactor | Argv parser with five distinct `--floor*` shapes. Replacing the `for…of` ladder with a small token-to-decision map drops the cyclomatic count below the ceiling. |

## Plan summary

- **Refactor (Task #2043):** `resolveScopedRef`, `readPriorBaselineRows`,
  `tolerantNumericFields`, `parseFloorFlag`. No behaviour change; favour
  extract-method and guard clauses.
- **Override (Task #2044):** `runCrapPreview`, `evaluateBaselineCompatibility`,
  `runKnip`. Each per-path entry in `.agentrc.json` carries a
  `follow_up` reference to a tracking issue so the relaxation is not a
  silent escape hatch.
- **Remove `*` override (Task #2045):** delete
  `delivery.quality.gates.crap.floors['*']` so the framework default of
  CRAP ≤ 20 applies repo-wide.
