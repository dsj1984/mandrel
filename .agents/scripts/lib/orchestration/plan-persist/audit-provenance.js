/**
 * What an audit-seeded plan leaves for the next sweep: `audit::*` labels (the
 * dedup corpus is label-listed, so footers alone are invisible to an indexed
 * sweep) and cross-run ledger entries.
 */

import {
  DEFAULT_LEDGER_PATH,
  readLedger,
  recordFiledIdentities,
  writeLedger,
} from '../../findings/audit-ledger.js';
import {
  parseAuditLabelFooter,
  parseFingerprintFooter,
  parseSemanticKeyFooter,
} from '../../findings/route-finding.js';
import { Logger } from '../../Logger.js';

/**
 * @param {string} [ledgerPath]
 * @returns {{ path: string, ledger: object|null, recorded: number, ambiguous: number }}
 */
function newAuditLedgerRecord(ledgerPath) {
  return {
    path: ledgerPath ?? DEFAULT_LEDGER_PATH,
    ledger: null,
    recorded: 0,
    ambiguous: 0,
  };
}

/**
 * Labels come from the seed union, not per-Story attribution: a label only
 * widens the next sweep's corpus (matching is by fingerprint), so erring
 * wide is safe.
 *
 * @param {Array<object>} stories
 * @param {string} [provenanceSource]
 * @returns {Array<object>}
 */
export function withAuditLabels(stories, provenanceSource) {
  const fromSeed = parseAuditLabelFooter(provenanceSource ?? '');
  if (fromSeed.length === 0) return stories;
  return stories.map((story) => ({
    ...story,
    labels: [...new Set([...story.labels, ...fromSeed])],
  }));
}

/**
 * Identities are read off the stamped body. Union-carried (unattributed)
 * footers are never recorded: every sibling carries them, and a wrong
 * binding is worse than none.
 *
 * @param {{ story: object, id: number, ledgerRecord: object, attributed: boolean }} args
 */
function recordAuditFiling({ story, id, ledgerRecord, attributed }) {
  const fingerprints = parseFingerprintFooter(story.body);
  if (fingerprints.length === 0) return;
  if (!attributed) {
    ledgerRecord.ambiguous += fingerprints.length;
    return;
  }
  const semanticKeys = parseSemanticKeyFooter(story.body);
  const identities = fingerprints.map((fingerprint, i) => ({
    fingerprint,
    semanticKey: semanticKeys[i] ?? '',
    title: story.title,
  }));
  const { ledger, recorded } = recordFiledIdentities({
    ledger: ledgerRecord.ledger ?? readLedger(ledgerRecord.path),
    identities,
    issue: { number: id },
  });
  ledgerRecord.ledger = ledger;
  ledgerRecord.recorded += recorded;
}

/**
 * @param {object} ledgerRecord
 * @param {{ warn: Function }} logger
 */
function flushAuditLedger(ledgerRecord, logger) {
  if (ledgerRecord.ambiguous > 0) {
    logger.warn(
      `[plan-persist] audit ledger: ${ledgerRecord.ambiguous} identity(ies) not recorded — ` +
        'the seed carried provenance footers but no Story attributed them, so ownership is ' +
        'ambiguous. Author per-Story `provenance` to record them.',
    );
  }
  if (!ledgerRecord.ledger || ledgerRecord.recorded === 0) return;
  writeLedger(ledgerRecord.path, ledgerRecord.ledger);
  logger.warn(
    `[plan-persist] audit ledger: recorded ${ledgerRecord.recorded} filed finding(s) ` +
      `to ${ledgerRecord.path}.`,
  );
}

/**
 * One ledger write per plan, not per Story — the ledger is committed state.
 * A run that recorded nothing writes nothing.
 *
 * @param {object} params
 * @param {Array<object>} params.stories
 * @param {Array<{ slug: string, id: number }>} params.created
 * @param {Array<object>} params.tickets
 * @param {string} [params.ledgerPath]
 * @param {{ warn: Function }} [params.logger]
 * @param {boolean} [params.dryRun]
 * @returns {{ recorded: number, ambiguous: number }}
 */
export function recordAuditFilings({
  stories,
  created,
  tickets,
  ledgerPath,
  logger,
  dryRun = false,
}) {
  if (dryRun) return { recorded: 0, ambiguous: 0 };
  const record = newAuditLedgerRecord(ledgerPath);
  const idBySlug = new Map((created ?? []).map((c) => [c.slug, c.id]));
  // Attribution is what the plan authored, so read it off the raw tickets.
  const attributedSlugs = new Set(
    (tickets ?? [])
      .filter((t) => t?.provenance !== undefined && t?.provenance !== null)
      .map((t) => t?.slug),
  );
  for (const story of stories ?? []) {
    const id = idBySlug.get(story.slug);
    if (typeof id !== 'number') continue;
    recordAuditFiling({
      story,
      id,
      ledgerRecord: record,
      attributed: attributedSlugs.has(story.slug),
    });
  }
  flushAuditLedger(record, logger ?? Logger);
  return { recorded: record.recorded, ambiguous: record.ambiguous };
}
