#!/usr/bin/env node

/* node:coverage ignore file */

/**
 * epic-plan-spec.js — RETIRED delegate CLI (Epic #4474, PR7).
 *
 * The 12-phase plan pipeline collapsed to context → author → persist:
 *
 *   - `--emit-context` moved to `plan-context.js` (single authoring
 *     envelope: Epic body + docs digest + codebase snapshot + duplicate
 *     search + clarity + system prompts).
 *   - The persist half (section gate, risk verdict, managed sections,
 *     checkpoint) moved to `plan-persist.js` (single GitHub-write surface).
 *
 * This file is a **re-export shim only** — it carries external importers of
 * the historic named-export surface one more release (#4474 design §6 PR7
 * risk note) and is deleted in the next release. Internal consumers import
 * the phase modules directly; do not add new imports of this file.
 *
 * Invoking it as a CLI is refused with a pointer to the successor CLIs.
 */

// cli-opt-out: retired delegate shim (Epic #4474 PR7) — deliberately
// refuses CLI execution with a pointer to plan-context.js/plan-persist.js
// instead of wiring runAsCli around a dead main().
import { pathToFileURL } from 'node:url';

export {
  forkAndCommitEpicSnapshot,
  forkMainToEpic,
} from './lib/baseline-snapshot.js';
export {
  buildAuthoringContext,
  resolveMemoryDir,
} from './lib/orchestration/epic-plan-spec/phases/authoring-context.js';
export { drainPendingCleanupAtBoot } from './lib/orchestration/epic-plan-spec/phases/drain.js';
export {
  planEpic,
  resolveAcceptancePersistence,
} from './lib/orchestration/epic-plan-spec/phases/plan-epic.js';
export {
  loadRiskVerdict,
  validateRiskVerdict,
} from './lib/orchestration/epic-plan-spec/phases/risk-verdict.js';
export { runSpecPhase } from './lib/orchestration/epic-plan-spec/phases/run-spec-phase.js';
export { runSpecFreshnessCheck } from './lib/orchestration/epic-plan-spec/phases/spec-freshness.js';
export { resolveReviewRouting } from './lib/orchestration/plan-review-routing.js';

// CLI execution is retired — fail loudly with the successor surface instead
// of silently doing nothing (a stale automation script should break visibly).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.stderr.write(
    '[epic-plan-spec] retired (Epic #4474): the plan pipeline is ' +
      'context → author → persist.\n' +
      '  - authoring envelope:  node .agents/scripts/plan-context.js --epic <id>\n' +
      '  - persist (all gates): node .agents/scripts/plan-persist.js --epic <id> ...\n' +
      'This file survives one release as an import shim only.\n',
  );
  process.exit(1);
}
