/**
 * Per-clone (gitignored) record of the manifest entries an install actually
 * applied — never the full manifest — which `mandrel uninstall` reads to undo
 * reversible mutations and surface irreversible ones.
 *
 * @module bootstrap/install-ledger
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * The `.gitignore` step keys off this exact POSIX path.
 *
 * @type {string}
 */
export const LEDGER_RELATIVE_PATH = '.agents/.install-manifest.json';

/**
 * Uninstall refuses a version it cannot interpret. Entries carry
 * `executedAction` so an operator-authored file the install left in place
 * (`already-present`) is never deleted.
 *
 * @type {number}
 */
export const LEDGER_SCHEMA_VERSION = 2;

/**
 * Target → the phase whose live outcome governs its reversal; only targets
 * whose reversal is destructive are mapped.
 *
 * @type {Readonly<Record<string, string>>}
 */
const TARGET_TO_PHASE = Object.freeze({
  '.agentrc.json': 'agentrc',
});

/**
 * `undefined` means no hint. Both `.agentrc.json` entries resolve to the same
 * `agentrc` outcome, which is correct: reversal dedupes them.
 *
 * @param {{ target: string }} entry
 * @param {Record<string, { action?: string }>} [report]
 * @returns {string|undefined}
 */
function resolveExecutedAction(entry, report) {
  if (!report) return undefined;
  const phaseName = TARGET_TO_PHASE[entry.target];
  if (!phaseName) return undefined;
  const action = report[phaseName]?.action;
  return typeof action === 'string' ? action : undefined;
}

/**
 * @param {string} projectRoot
 * @returns {string}
 */
export function ledgerPath(projectRoot) {
  return path.join(projectRoot, '.agents', '.install-manifest.json');
}

/**
 * @param {object} args
 * @param {import('./manifest.js').MutationManifestEntry[]} args.entries
 *   — the applied subset.
 * @param {string[]} args.approvedGroups — groups that landed. The name is a
 *   consumer contract read by `mandrel uninstall`; do not rename.
 * @param {{ owner?: string, repo?: string }} [args.answers]
 * @param {string} [args.appliedAt] — ISO-8601 (default: now).
 * @param {Record<string, { action?: string }>} [args.report] — phase → outcome.
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
 * Overwrites: the ledger always reflects the most recent install.
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
 * @param {string} projectRoot
 * @returns {ReturnType<typeof buildLedgerRecord>|null}
 */
export function readInstallLedger(projectRoot) {
  const target = ledgerPath(projectRoot);
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}
