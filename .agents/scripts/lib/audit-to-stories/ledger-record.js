/**
 * Record what a run filed onto the ledger so the next run suppresses it even
 * without search dedup. No network: runs before the provider loads.
 */

import {
  DEFAULT_LEDGER_PATH,
  readLedger,
  reconcileLedger,
  writeLedger,
} from '../findings/audit-ledger.js';
import {
  fingerprintAuditFinding,
  toCanonicalFinding,
} from './finding-adapter.js';

/**
 * Only mapped groups contribute; inventing a state for an unopened group would
 * suppress a finding against an Issue that does not exist. Every state is
 * `open` — a later close is learned live next run and outranks this record.
 *
 * @param {object} params
 * @param {Array<object>} params.groups — the `create`-eligible groups.
 * @param {Record<string, number>} params.issueByGroupKey — group key → issue number.
 * @returns {{ findings: Array<object>, issueStates: Record<string, { state: string, number: number }>, groupsRecorded: number }}
 */
function issueStatesFromIssueMap({ groups, issueByGroupKey }) {
  const findings = [];
  const issueStates = {};
  let groupsRecorded = 0;

  for (const group of groups ?? []) {
    const number = issueByGroupKey?.[group?.groupKey];
    if (typeof number !== 'number') continue;
    groupsRecorded += 1;
    for (const finding of group.findings ?? []) {
      findings.push(finding);
      issueStates[fingerprintAuditFinding(finding).full] = {
        state: 'open',
        number,
      };
    }
  }

  return { findings, issueStates, groupsRecorded };
}

/**
 * Other ledger entries survive untouched: `reconcileLedger` rewrites only the
 * findings it is handed.
 *
 * @param {object} params
 * @param {string} [params.ledgerPath]
 * @param {Array<object>} params.groups — the `create`-eligible groups.
 * @param {Record<string, number>} params.issueByGroupKey
 * @param {boolean} [params.write=true] — `false` for `--dry-run`.
 * @param {{ readLedgerImpl?: Function, writeLedgerImpl?: Function }} [seams]
 * @returns {{ path: string, written: boolean, groupsRecorded: number, findingsRecorded: number, filed: number }}
 */
export function recordFiledIssues(
  { ledgerPath, groups, issueByGroupKey, write = true },
  { readLedgerImpl = readLedger, writeLedgerImpl = writeLedger } = {},
) {
  const path = ledgerPath ?? DEFAULT_LEDGER_PATH;
  const { findings, issueStates, groupsRecorded } = issueStatesFromIssueMap({
    groups,
    issueByGroupKey,
  });

  const { ledger: next, classifications } = reconcileLedger({
    ledger: readLedgerImpl(path),
    findings,
    issueStates,
    toCanonical: toCanonicalFinding,
  });
  // No findings → no write: a fresh `generatedAt` alone would make
  // `--ledger-commit` open an empty PR.
  const wrote = Boolean(write) && findings.length > 0;
  if (wrote) writeLedgerImpl(path, next);

  return {
    path,
    written: wrote,
    groupsRecorded,
    findingsRecorded: findings.length,
    filed: classifications.filter((c) => c.status === 'filed').length,
  };
}
