/**
 * lib/orchestration/plan-persist/audit-provenance.js — what an audit-seeded
 * plan leaves behind for the next sweep.
 *
 * The chained `/mandrel-plan` path files Stories from an audit seed, and until
 * Story #5307 those Stories were invisible to the sweep that proposed them:
 * they carried no `audit::*` label, so they were absent from the label-listed
 * corpus dedup indexes, and nothing recorded them in the cross-run ledger. The
 * provenance footers `carryProvenanceFooters` stamps could not cover for
 * either — with an index in play the exact lookup is answered from that pool
 * and never reaches the provider.
 *
 * Both halves ride the create loop in `story-ops.js` because that is the only
 * seam on this path that cannot be forgotten: there is no second required pass
 * here the way `--wire-edges` is one for the standalone filer.
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
 * A fresh accumulator for one persist run's audit filings.
 *
 * The run collects into this and flushes once, so a plan that files N Stories
 * leaves one reviewable ledger diff rather than N.
 *
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
 * Merge the seed's `audit::*` labels into an audit-seeded Story's labels.
 *
 * Taken from the **seed union**, not from the attributed provenance source: a
 * label only scopes which issues the next sweep's corpus fetch returns, and
 * matching inside that corpus is by fingerprint and semantic key. A superset
 * corpus can therefore only ever find more, never less — so erring wide is the
 * safe direction, and it keeps lens-to-label knowledge in the audit filer that
 * owns it rather than re-deriving a dimension here (the junk-derivation trap
 * Story #4195 closed).
 *
 * A non-audit seed carries no such footer, so this is a no-op there.
 *
 * @param {Array<object>} stories — the assembled Stories.
 * @param {string} [provenanceSource] — the seed this plan was authored from.
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
 * Record one just-created Story in the cross-run audit ledger.
 *
 * The identities are read back off the body this run assembled, so what is
 * recorded is exactly what was stamped — attribution already applied. A Story
 * from a non-audit plan carries no footers and records nothing, which is why
 * a `--seed` or `--tickets` run never touches the ledger file at all.
 *
 * **The union fallback is deliberately NOT recorded.** When the seed carried
 * footers but the plan attributed none per-Story, every sibling carries every
 * fingerprint; binding a finding to one of them would be a coin flip, and a
 * wrong binding is worse than none — the finding would be suppressed against an
 * Issue that never tracked it, or resurrected when an unrelated Story closed.
 * The audit path stamps `provenance` mechanically, so this is the exception.
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
 * Persist the run's audit filings, once, after every Story exists.
 *
 * Writing per-Story would rewrite a committed baseline N times for one plan;
 * writing once keeps the diff to a single reviewable change. A run that
 * recorded nothing writes nothing.
 *
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
 * Record everything one persist run filed, once, after every Story exists.
 *
 * Driven from the persist orchestrator rather than from inside the create loop:
 * the loop's job is to create issues, and this is the only other place that
 * always runs after it. Either seam is unforgettable — there is no second
 * required pass on this path the way `--wire-edges` is one for the standalone
 * filer — and keeping the side effect at the orchestration layer leaves the
 * create loop doing one thing.
 *
 * One write per plan, not per Story: the ledger is committed state, and N
 * rewrites of it for one plan is a diff nobody can review. A run that recorded
 * nothing — a non-audit plan, or one whose identities were all union-carried —
 * writes nothing at all.
 *
 * @param {object} params
 * @param {Array<object>} params.stories — the assembled Stories.
 * @param {Array<{ slug: string, id: number }>} params.created — persist receipts.
 * @param {Array<object>} params.tickets — the raw authored tickets.
 * @param {string} [params.ledgerPath]
 * @param {{ warn: Function }} [params.logger]
 * @returns {{ recorded: number, ambiguous: number }}
 */
export function recordAuditFilings({
  stories,
  created,
  tickets,
  ledgerPath,
  logger,
}) {
  const record = newAuditLedgerRecord(ledgerPath);
  const idBySlug = new Map((created ?? []).map((c) => [c.slug, c.id]));
  // Attribution is a property of what the plan AUTHORED, so it is read off the
  // raw tickets rather than threaded through assembly: a Story that declared no
  // `provenance` inherited the seed union, where ownership is a coin flip.
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
