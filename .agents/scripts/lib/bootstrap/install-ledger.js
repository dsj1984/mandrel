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
 * @type {number}
 */
export const LEDGER_SCHEMA_VERSION = 1;

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
 * @returns {{ schemaVersion: number, appliedAt: string,
 *   repo: string|null, approvedGroups: string[],
 *   entries: import('./manifest.js').MutationManifestEntry[] }}
 */
export function buildLedgerRecord(args) {
  const { entries, approvedGroups, answers, appliedAt } = args;
  const repo =
    answers?.owner && answers?.repo ? `${answers.owner}/${answers.repo}` : null;
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    appliedAt: appliedAt ?? new Date().toISOString(),
    repo,
    approvedGroups: [...approvedGroups].sort(),
    entries: entries.map((e) => ({
      phaseGroup: e.phaseGroup,
      target: e.target,
      action: e.action,
      reversible: e.reversible,
    })),
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
