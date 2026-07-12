#!/usr/bin/env node

/* node:coverage ignore file */

/**
 * epic-plan-decompose.js — RETIRED delegate CLI (Epic #4474, PR7).
 *
 * The 12-phase plan pipeline collapsed to context → author → persist:
 *
 *   - `--emit-context` moved to `plan-context.js` (the single authoring
 *     envelope carries the decomposer context — ticket schema, risk
 *     heuristics, ticket cap — alongside the spec half).
 *   - The persist half (ticket validator, file-assumption gate, DAG,
 *     budget, story creation, healthcheck, `agent::ready` flip) moved to
 *     `plan-persist.js` (single GitHub-write surface).
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
  buildDecomposerSystemPrompt,
  buildDecompositionContext,
} from './lib/orchestration/epic-plan-decompose/phases/context.js';
export {
  orderTicketsForCreation,
  resolveDependencies,
} from './lib/orchestration/epic-plan-decompose/phases/dag.js';
export { runDecomposePhase } from './lib/orchestration/epic-plan-decompose/phases/persist.js';

// CLI execution is retired — fail loudly with the successor surface instead
// of silently doing nothing (a stale automation script should break visibly).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.stderr.write(
    '[epic-plan-decompose] retired (Epic #4474): the plan pipeline is ' +
      'context → author → persist.\n' +
      '  - authoring envelope:  node .agents/scripts/plan-context.js --epic <id>\n' +
      '  - persist (all gates): node .agents/scripts/plan-persist.js --epic <id> --tickets ...\n' +
      'This file survives one release as an import shim only.\n',
  );
  process.exit(1);
}
