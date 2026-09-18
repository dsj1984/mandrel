/**
 * lib/findings/audit-ledger.js — committed cross-run memory of audit
 * findings, keyed by fingerprint and `semanticKey`. Status: `new` · `filed` ·
 * `fixed` · `accepted-risk` (closed `not_planned`; suppressed) · `regressed`.
 */

import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { fingerprintFinding, semanticKeyFor } from './route-finding.js';

export const DEFAULT_LEDGER_PATH = 'baselines/audit-ledger.json';
const LEDGER_SCHEMA_URL =
  'https://mandrel.dev/baselines/audit-ledger.schema.json';

/**
 * @param {string} [now] — ISO timestamp to stamp.
 * @returns {{ $schema: string, generatedAt: string, entries: [] }}
 */
function createEmptyLedger(now = new Date().toISOString()) {
  return { $schema: LEDGER_SCHEMA_URL, generatedAt: now, entries: [] };
}

/**
 * `toCanonical` is injected: importing the audit adapter would close a cycle.
 *
 * @param {object} finding
 * @param {(finding: object) => object} [toCanonical]
 * @returns {{ fingerprint: string, semanticKey: string }}
 */
function findingIdentity(finding, toCanonical) {
  const canonical = toCanonical ? toCanonical(finding) : finding;
  return {
    fingerprint: fingerprintFinding(canonical).full,
    semanticKey: semanticKeyFor(canonical),
  };
}

/**
 * An absent or unparseable file reads as an empty ledger, never an error.
 * @param {string} filePath
 * @param {{ fs?: typeof import('node:fs') }} [deps]
 * @returns {{ $schema?: string, generatedAt?: string, entries: object[] }}
 */
export function readLedger(filePath, { fs } = {}) {
  const fsLike = fs ?? nodeFs;
  if (!fsLike || !fsLike.existsSync(filePath)) return createEmptyLedger();
  try {
    const parsed = JSON.parse(fsLike.readFileSync(filePath, 'utf8'));
    if (!parsed || !Array.isArray(parsed.entries)) return createEmptyLedger();
    return parsed;
  } catch (_) {
    return createEmptyLedger();
  }
}

/**
 * @param {string} filePath
 * @param {object} ledger
 * @param {{ fs?: typeof import('node:fs'), path?: typeof import('node:path') }} [deps]
 */
export function writeLedger(filePath, ledger, { fs, path } = {}) {
  const fsLike = fs ?? nodeFs;
  const pathLike = path ?? nodePath;
  if (!fsLike) return;
  fsLike.mkdirSync(pathLike.dirname(filePath), { recursive: true });
  fsLike.writeFileSync(filePath, `${JSON.stringify(ledger, null, 2)}\n`);
}

/**
 * @param {{ entries?: object[] }} ledger
 */
function indexLedger(ledger) {
  const byFingerprint = new Map();
  const bySemanticKey = new Map();
  for (const entry of ledger?.entries ?? []) {
    if (entry?.fingerprint) byFingerprint.set(entry.fingerprint, entry);
    if (entry?.semanticKey) bySemanticKey.set(entry.semanticKey, entry);
  }
  return { byFingerprint, bySemanticKey };
}

/**
 * An `issueStates` override beats the recorded Issue.
 * @param {{ fingerprint: string, semanticKey: string }} id
 * @param {object|null} existing
 * @param {Record<string, { state?: string, stateReason?: string|null, number?: number }>} issueStates
 * @returns {{ state: string, stateReason: string|null, number: number|null }|null}
 */
function resolveIssueState(id, existing, issueStates) {
  const override = issueStates[id.fingerprint] ?? issueStates[id.semanticKey];
  const raw = override ?? existing?.issue ?? null;
  if (!raw) return null;
  return {
    state: (raw.state ?? '').toLowerCase(),
    stateReason: raw.stateReason ? String(raw.stateReason).toLowerCase() : null,
    number: typeof raw.number === 'number' ? raw.number : null,
  };
}

/**
 * @type {Record<string, { status: string, action: string }>}
 */
const VERDICT = Object.freeze({
  filed: Object.freeze({ status: 'filed', action: 'known' }),
  propose: Object.freeze({ status: 'new', action: 'propose' }),
  suppress: Object.freeze({ status: 'accepted-risk', action: 'suppress' }),
  regressed: Object.freeze({ status: 'regressed', action: 'regressed' }),
});

/**
 * The whole reconciliation policy.
 * @param {object|null} existing — prior ledger entry (or null when unseen).
 * @param {{ state: string, stateReason: string|null }|null} issue
 * @returns {{ status: string, action: 'propose'|'known'|'suppress'|'regressed' }}
 */
function decideStatus(existing, issue) {
  // A closed Issue outranks any recorded status.
  if (issue && issue.state === 'closed') {
    return issue.stateReason === 'not_planned'
      ? VERDICT.suppress
      : VERDICT.regressed;
  }

  // An open Issue means filed even with no prior entry.
  const unseen = issue?.state === 'open' ? VERDICT.filed : VERDICT.propose;
  if (!existing) return unseen;

  switch (existing.status) {
    case 'accepted-risk':
      return VERDICT.suppress;
    case 'filed':
      return VERDICT.filed;
    // Recorded fixed yet detected again: a regression, open Issue or not.
    case 'fixed':
      return VERDICT.regressed;
    case 'regressed':
      return VERDICT.regressed;
    default:
      return unseen;
  }
}

/**
 * Fold a scan and live Issue states onto the prior ledger; untouched entries
 * are preserved.
 *
 * @param {object} params
 * @param {{ entries?: object[] }} [params.ledger]
 * @param {Array<object>} params.findings
 * @param {Record<string, { state?: string, stateReason?: string|null, number?: number }>} [params.issueStates]
 * @param {string} [params.now]
 * @param {(finding: object) => object} [params.toCanonical]
 * @returns {{
 *   ledger: { $schema: string, generatedAt: string, entries: object[] },
 *   classifications: Array<{ fingerprint: string, semanticKey: string, status: string, action: string, issue: object|null }>,
 * }}
 */
export function reconcileLedger({
  ledger = createEmptyLedger(),
  findings,
  issueStates = {},
  now = new Date().toISOString(),
  toCanonical,
} = {}) {
  if (!Array.isArray(findings)) {
    throw new Error('reconcileLedger: findings must be an array');
  }

  const { byFingerprint, bySemanticKey } = indexLedger(ledger);
  const nextByFingerprint = new Map(byFingerprint);
  const classifications = [];

  for (const finding of findings) {
    const id = findingIdentity(finding, toCanonical);
    const existing =
      byFingerprint.get(id.fingerprint) ??
      (id.semanticKey ? bySemanticKey.get(id.semanticKey) : undefined) ??
      null;

    const issue = resolveIssueState(id, existing, issueStates);
    const { status, action } = decideStatus(existing, issue);

    const entry = {
      fingerprint: id.fingerprint,
      semanticKey: id.semanticKey,
      title: finding?.title ?? existing?.title ?? '',
      dimension: finding?.dimension ?? existing?.dimension ?? '',
      primaryFile:
        (Array.isArray(finding?.files) && finding.files[0]) ??
        existing?.primaryFile ??
        '',
      status,
      issue: issue
        ? {
            number: issue.number,
            state: issue.state,
            stateReason: issue.stateReason,
          }
        : (existing?.issue ?? null),
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
    };

    // Re-key a reworded finding matched by semanticKey.
    if (existing?.fingerprint && existing.fingerprint !== id.fingerprint) {
      nextByFingerprint.delete(existing.fingerprint);
    }
    nextByFingerprint.set(id.fingerprint, entry);

    classifications.push({
      fingerprint: id.fingerprint,
      semanticKey: id.semanticKey,
      status,
      action,
      issue: entry.issue,
    });
  }

  return {
    ledger: {
      $schema: ledger?.$schema ?? LEDGER_SCHEMA_URL,
      generatedAt: now,
      entries: [...nextByFingerprint.values()],
    },
    classifications,
  };
}

/**
 * Record identity strings (`plan-persist` has no findings) as filed. An
 * identity whose Issue is closed is skipped, so its verdict survives.
 *
 * @param {object} params
 * @param {{ entries?: object[] }} [params.ledger]
 * @param {Array<{ fingerprint: string, semanticKey?: string, title?: string, dimension?: string, primaryFile?: string }>} params.identities
 * @param {{ number: number }} params.issue
 * @param {string} [params.now]
 * @returns {{ ledger: object, recorded: number, skipped: number }}
 */
export function recordFiledIdentities({
  ledger = createEmptyLedger(),
  identities,
  issue,
  now = new Date().toISOString(),
} = {}) {
  if (!Array.isArray(identities)) {
    throw new Error('recordFiledIdentities: identities must be an array');
  }
  if (!issue || typeof issue.number !== 'number') {
    throw new Error('recordFiledIdentities: issue.number must be a number');
  }

  const { byFingerprint } = indexLedger(ledger);
  const next = new Map(byFingerprint);
  let recorded = 0;
  let skipped = 0;

  for (const identity of identities) {
    const fingerprint = identity?.fingerprint;
    if (typeof fingerprint !== 'string' || fingerprint.length === 0) continue;
    const existing = byFingerprint.get(fingerprint) ?? null;
    if (existing?.issue && existing.issue.state === 'closed') {
      skipped += 1;
      continue;
    }
    next.set(fingerprint, {
      fingerprint,
      semanticKey: identity.semanticKey ?? existing?.semanticKey ?? '',
      title: identity.title ?? existing?.title ?? '',
      dimension: identity.dimension ?? existing?.dimension ?? '',
      primaryFile: identity.primaryFile ?? existing?.primaryFile ?? '',
      status: 'filed',
      issue: { number: issue.number, state: 'open', stateReason: null },
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
    });
    recorded += 1;
  }

  return {
    ledger: {
      $schema: ledger?.$schema ?? LEDGER_SCHEMA_URL,
      generatedAt: now,
      entries: [...next.values()],
    },
    recorded,
    skipped,
  };
}
