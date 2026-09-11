/**
 * lib/audit-to-stories/ledger-record.js — record what a run actually filed.
 *
 * The cross-run ledger can only suppress an already-filed finding if something
 * tells it the finding was filed. Until Story #5305 nothing did: the reconcile
 * ran *during* the scan, before any Issue existed, and its `issueStates` were
 * derived from `matchedIssues` — the Issues dedup FOUND. A group classified
 * `create` has none, so a freshly opened Issue contributed nothing and its
 * entry persisted as `status: "new", issue: null` forever. On a host where
 * GitHub-search dedup works that is invisible; on one where it cannot run,
 * nothing suppresses anything and every sweep re-files everything.
 *
 * The missing input is the `groupKey → issueNumber` map, which exists only
 * after the Issues are opened. `--wire-edges` already takes exactly that map
 * and is already a required pass, which is why the record rides along with it
 * rather than arriving as a second command an operator must remember.
 *
 * Nothing here reaches the network: the caller hands over the map it already
 * holds, and the only I/O is the ledger read/write this module delegates to
 * `ledger.js`. That is what lets the record run BEFORE the provider is loaded,
 * so a host whose provider cannot be constructed still records what it filed.
 */

import { fingerprintAuditFinding } from './finding-adapter.js';
import {
  DEFAULT_LEDGER_PATH,
  readLedger,
  reconcileLedger,
  writeLedger,
} from './ledger.js';

/**
 * Project the opened-issue map onto the `{ fingerprint → issueState }` shape
 * `reconcileLedger` reads, and collect the findings those groups carry.
 *
 * Only groups present in the map contribute. A group the map does not mention
 * was not opened — deduped, ledger-suppressed, or simply skipped — and
 * inventing an Issue state for it is how a finding gets suppressed against an
 * Issue that does not exist.
 *
 * Every recorded state is `open`: the map names Issues this run just created,
 * and a just-created Issue is open. A later close is learned from the live
 * lookup on the next run, where it outranks this record (`decideStatus` reads
 * the closed-Issue branch first).
 *
 * @param {object} params
 * @param {Array<object>} params.groups — the `create`-eligible groups.
 * @param {Record<string, number>} params.issueByGroupKey — group key → issue number.
 * @returns {{ findings: Array<object>, issueStates: Record<string, { state: string, number: number }>, groupsRecorded: number }}
 */
export function issueStatesFromIssueMap({ groups, issueByGroupKey }) {
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
 * Fold the just-opened Issues onto the committed ledger.
 *
 * Only the mapped groups' findings are passed to `reconcileLedger`, so every
 * other entry survives untouched — `reconcileLedger` copies the prior index
 * forward and rewrites only what this scan hands it.
 *
 * @param {object} params
 * @param {string} [params.ledgerPath]
 * @param {Array<object>} params.groups — the `create`-eligible groups.
 * @param {Record<string, number>} params.issueByGroupKey
 * @param {boolean} [params.write=true] — `false` computes the record without
 *   persisting it, which is what `--dry-run` needs.
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
  });
  if (write) writeLedgerImpl(path, next);

  return {
    path,
    written: Boolean(write),
    groupsRecorded,
    findingsRecorded: findings.length,
    filed: classifications.filter((c) => c.status === 'filed').length,
  };
}
