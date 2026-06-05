#!/usr/bin/env node

/**
 * audit-strategy.js — Deterministic audit-strategy decision surface
 * (Story #3610 — Epic #3597 "Generalize dynamic-workflow audit orchestration").
 *
 * Surfaces {@link selectAuditStrategy} through a real, deterministic CLI entry
 * so a host or operator can resolve **which execution path** an audit lens will
 * take (`orchestrated` vs. `sequential`) before launching it. Until this entry
 * existed, `selectAuditStrategy` was referenced only by tests with no caller
 * actually invoking it — the decision logic was correct but unwired.
 *
 * The decision is a pure function of the runtime capability snapshot built from
 * `process.env` (via {@link snapshotFromEnv}) plus the operator/test
 * force-override (`MANDREL_AUDIT_STRATEGY`, via {@link forceStrategyFromEnv}).
 * No git, filesystem, or network I/O is performed; the same env reproduces the
 * same decision, which is what makes this surface deterministic and testable.
 *
 * Usage:
 *   node .agents/scripts/audit-strategy.js [--lens <name>] [--json]
 *
 * Flags:
 *   --lens <name>   Audit lens the decision is being resolved for (advisory
 *                   label echoed into the output; defaults to
 *                   `audit-clean-code`). Does not change the decision — every
 *                   lens shares the same capability gate today.
 *   --json          Emit the full decision envelope as JSON on stdout instead
 *                   of the human-readable one-liner.
 *
 * Environment (read from `process.env`; see ENV_KEYS in capability.js):
 *   MANDREL_AUDIT_STRATEGY        Force-override: `orchestrated` | `sequential`.
 *   CLAUDE_CODE_RUNTIME           Runtime identity (`claude-code` when present).
 *   CLAUDE_CODE_VERSION           Claude Code version string.
 *   CLAUDE_CODE_PLAN              Entitlement hint (`pro`|`max`|`team`|…).
 *   CLAUDE_CODE_DISABLE_WORKFLOWS Hard kill-switch for the orchestrated path.
 *
 * Output (non-JSON): a single line, e.g.
 *   audit-strategy: lens=audit-clean-code strategy=sequential reason=not-claude-runtime forced=false
 *
 * Exit codes:
 *   0 — A strategy was resolved and printed.
 *   1 — Invocation error (unrecognised flag value, etc.).
 */

import { fileURLToPath } from 'node:url';

import {
  forceStrategyFromEnv,
  selectAuditStrategy,
  snapshotFromEnv,
} from './lib/dynamic-workflow/capability.js';
import { Logger } from './lib/Logger.js';

/** Lens label used when `--lens` is omitted. */
export const DEFAULT_LENS = 'audit-clean-code';

/**
 * Resolve the audit-strategy decision for a lens from an environment bag.
 *
 * Pure function — no I/O. The CLI wrapper supplies `process.env`; tests inject
 * a synthetic bag so the decision is reproducible without a live runtime.
 *
 * @param {object} [input]
 * @param {Record<string,string|undefined>} [input.env]  Environment bag (defaults to `{}`).
 * @param {string} [input.lens]                           Advisory lens label.
 * @returns {{ lens: string } & import('./lib/dynamic-workflow/capability.js').StrategyDecision}
 */
export function resolveAuditStrategy({ env = {}, lens = DEFAULT_LENS } = {}) {
  const snapshot = snapshotFromEnv(env);
  const forceStrategy = forceStrategyFromEnv(env);
  const decision = selectAuditStrategy({ snapshot, forceStrategy });
  return { lens, ...decision };
}

/**
 * Format a decision as the human-readable one-line summary printed by default.
 *
 * @param {{ lens: string, strategy: string, reason: string, forced: boolean }} decision
 * @returns {string}
 */
export function formatDecisionLine(decision) {
  const { lens, strategy, reason, forced } = decision;
  return `audit-strategy: lens=${lens} strategy=${strategy} reason=${reason} forced=${forced}`;
}

/**
 * Minimal flag parser. Recognises `--lens <name>` and the boolean `--json`.
 *
 * @param {string[]} argv  Arguments after the node/script prefix.
 * @returns {{ lens: string, json: boolean }}
 */
export function parseArgs(argv) {
  const out = { lens: DEFAULT_LENS, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      out.json = true;
    } else if (arg === '--lens') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--lens requires a value');
      }
      out.lens = value;
      i += 1;
    } else {
      throw new Error(`unrecognised argument: ${arg}`);
    }
  }
  return out;
}

/**
 * CLI entry. Reads the live `process.env`, resolves the decision, and prints
 * it (JSON or one-liner). Synchronous CLI with a bespoke main-guard so the
 * decision and its print happen in a single tick.
 */
function main() {
  const { lens, json } = parseArgs(process.argv.slice(2));
  const decision = resolveAuditStrategy({ env: process.env, lens });
  // Write the decision straight to stdout (not via Logger) so the chosen
  // strategy + reason is the script's canonical stdout payload — Logger's
  // sink can be redirected to stderr, which would hide the decision from a
  // host parsing stdout.
  const payload = json
    ? `${JSON.stringify(decision, null, 2)}\n`
    : `${formatDecisionLine(decision)}\n`;
  process.stdout.write(payload);
}

// cli-opt-out: synchronous CLI with bespoke main-guard; runAsCli's async-main pattern doesn't fit.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (err) {
    Logger.error(`[audit-strategy] ${err.message}`);
    process.exit(1);
  }
}
