/**
 * bootstrap/install-ledger — durable record of what an install applied, for
 * a future `mandrel uninstall` to consume (Story #3524, Feature #3515,
 * Epic #3438).
 *
 * A successful bootstrap run writes a ledger to
 * `<projectRoot>/.agents/.install-manifest.json` enumerating exactly the
 * mutation-manifest entries that were APPROVED and applied (the approved
 * subset of `buildMutationManifest`, never the full manifest). The ledger is
 * the single artifact `mandrel uninstall` will later read to know which
 * reversible mutations to undo and which irreversible (GitHub-admin) ones to
 * surface for manual rollback.
 *
 * The ledger is gitignored (`.agents/.install-manifest.json` is added to the
 * consumer `.gitignore` by the bootstrap) because it is a per-clone install
 * record, not a checked-in source artifact.
 *
 * This module performs filesystem writes but no network I/O.
 *
 * @module bootstrap/install-ledger
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Path of the install ledger, relative to the project root. The bootstrap's
 * `.gitignore` step keys its ignore entry off this exact POSIX path.
 *
 * @type {string}
 */
export const LEDGER_RELATIVE_PATH = '.agents/.install-manifest.json';

/**
 * Current ledger schema version. A future `mandrel uninstall` reads this to
 * detect a ledger it cannot interpret (hard-cutover contract — no read-side
 * tolerance branch, just a clean refusal).
 *
 * v2 (Story #3895): each entry now carries `executedAction` — the *live*
 * outcome of the bootstrap phase that produced it (e.g. `seeded` vs
 * `already-present` for `.agentrc.json`). Uninstall keys destructive reversal
 * off this so a pre-existing, operator-authored file the install merely left
 * in place (`already-present`) is never deleted.
 *
 * @type {number}
 */
export const LEDGER_SCHEMA_VERSION = 2;

/**
 * Map a mutation-manifest `target` (POSIX-relative path) to the bootstrap
 * **phase name** whose execution outcome describes that target. Only targets
 * whose reversal is destructive enough to need the live outcome are mapped;
 * everything else is reversed content-aware and needs no execution hint.
 *
 * The `.agentrc.json` `create` entry is produced by the `agentrc` phase
 * (`ensureAgentrc`), which returns `{ action: 'seeded' }` when it wrote the
 * file from the starter and `{ action: 'already-present' }` when an
 * operator-authored file was left untouched. Recording that distinction lets
 * uninstall skip deleting a file the install did not create (Story #3895).
 *
 * @type {Readonly<Record<string, string>>}
 */
const TARGET_TO_PHASE = Object.freeze({
  '.agentrc.json': 'agentrc',
});

/**
 * Resolve the live executed action for a manifest entry from the bootstrap
 * report, when one is available. Pure — derives entirely from the entry +
 * report. Returns `undefined` when the target has no mapped phase, the report
 * is absent, or the phase produced no `action` (so older callers/tests that
 * omit the report degrade to "no hint" rather than throwing).
 *
 * The `.agentrc.json` quality-gates `merge` entry shares the same target as
 * the repo-config `create` entry but is keyed by phase, not target — both
 * manifest entries resolve to the same `agentrc` outcome, which is correct:
 * reversal dedupes them to a single `revertAgentrc` call anyway.
 *
 * @param {{ target: string }} entry
 * @param {Record<string, { action?: string }>} [report]
 * @returns {string|undefined}
 */
export function resolveExecutedAction(entry, report) {
  if (!report) return undefined;
  const phaseName = TARGET_TO_PHASE[entry.target];
  if (!phaseName) return undefined;
  const action = report[phaseName]?.action;
  return typeof action === 'string' ? action : undefined;
}

/**
 * Resolve the absolute ledger path for a project root.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
export function ledgerPath(projectRoot) {
  return path.join(projectRoot, '.agents', '.install-manifest.json');
}

/**
 * Build the ledger record from the approved manifest entries. Pure helper —
 * no I/O — so the shape is unit-testable in isolation. The `appliedAt`
 * timestamp is injectable for deterministic tests.
 *
 * @param {object} args
 * @param {import('./manifest.js').MutationManifestEntry[]} args.entries
 *   — the APPROVED subset of the mutation manifest that was applied.
 * @param {string[]} args.approvedGroups — the phase groups the operator
 *   approved (sorted for stable output).
 * @param {{ owner?: string, repo?: string }} [args.answers]
 * @param {string} [args.appliedAt] — ISO-8601 timestamp (default: now).
 * @param {Record<string, { action?: string }>} [args.report] — the live
 *   bootstrap execution report (phase name → outcome). When present, each
 *   entry whose target maps to a phase records that phase's `action` as
 *   `executedAction` so uninstall can distinguish `seeded` from
 *   `already-present` (Story #3895).
 * @returns {{ schemaVersion: number, appliedAt: string,
 *   repo: string|null, approvedGroups: string[],
 *   entries: Array<import('./manifest.js').MutationManifestEntry
 *     & { executedAction?: string }> }}
 */
export function buildLedgerRecord(args) {
  const { entries, approvedGroups, answers, appliedAt, report } = args;
  const repo =
    answers?.owner && answers?.repo ? `${answers.owner}/${answers.repo}` : null;
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    appliedAt: appliedAt ?? new Date().toISOString(),
    repo,
    approvedGroups: [...approvedGroups].sort(),
    entries: entries.map((e) => {
      const executedAction = resolveExecutedAction(e, report);
      return {
        phaseGroup: e.phaseGroup,
        target: e.target,
        action: e.action,
        reversible: e.reversible,
        ...(executedAction !== undefined ? { executedAction } : {}),
      };
    }),
  };
}

/**
 * Write the install ledger to `<projectRoot>/.agents/.install-manifest.json`,
 * creating the `.agents/` directory if needed. The file is overwritten on
 * each successful install so the ledger always reflects the most recent run
 * (a re-install with a different approval set replaces, never appends).
 *
 * @param {string} projectRoot
 * @param {ReturnType<typeof buildLedgerRecord>} record
 * @returns {{ path: string, written: boolean, entryCount: number }}
 */
export function writeInstallLedger(projectRoot, record) {
  const target = ledgerPath(projectRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { path: target, written: true, entryCount: record.entries.length };
}

/**
 * Read and parse the install ledger. Returns `null` when no ledger exists
 * (never installed, or the ledger was removed). A future `mandrel uninstall`
 * is the primary consumer.
 *
 * @param {string} projectRoot
 * @returns {ReturnType<typeof buildLedgerRecord>|null}
 */
export function readInstallLedger(projectRoot) {
  const target = ledgerPath(projectRoot);
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}
