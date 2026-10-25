/**
 * review-providers/claim-grounding.js — checks a critical finding's
 * structured `claim` against the reviewed head before it can halt. A
 * refuted claim downgrades the finding to a suggestion; a confirmed claim,
 * a git error or no claim leaves it unchanged. Prose is never parsed.
 *
 * @typedef {import('./types.js').Finding} Finding
 * @typedef {import('./types.js').FindingClaim} FindingClaim
 */

import { gitSpawn } from '../../git-utils.js';
import { isObject } from '../../json-utils.js';

const TRUNCATED_CONTEXT = 'reviewed-with-truncated-context';
const CLAIM_KINDS = ['path-absent', 'symbol-referenced'];

/** The optional `claim` property of the Claude findings schema. */
export const CLAIM_SCHEMA = {
  type: 'object',
  properties: {
    kind: { enum: CLAIM_KINDS },
    path: { type: 'string' },
    symbol: { type: 'string' },
  },
  required: ['kind'],
};

/** Codex strict output: every property required, absence as `null`. */
export const STRICT_CLAIM_SCHEMA = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['kind', 'path', 'symbol'],
  properties: {
    kind: { type: 'string', enum: CLAIM_KINDS },
    path: { type: ['string', 'null'] },
    symbol: { type: ['string', 'null'] },
  },
};

const nonBlank = (value) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

/**
 * A claim is kept only when its `kind` is known and carries the field that
 * kind is checked by; anything else is dropped, never grounded.
 *
 * @param {unknown} raw
 * @returns {FindingClaim | null}
 */
export function buildClaim(raw) {
  if (!isObject(raw)) return null;
  const path = nonBlank(raw.path);
  const symbol = nonBlank(raw.symbol);
  if (raw.kind === 'path-absent' && path) return { kind: raw.kind, path };
  if (raw.kind !== 'symbol-referenced' || !symbol) return null;
  return path ? { kind: raw.kind, symbol, path } : { kind: raw.kind, symbol };
}

/**
 * Report lines saying why a finding did not block, or was reviewed blind.
 *
 * @param {Finding} finding
 * @returns {string[]}
 */
export function groundingNotes(finding) {
  const notes = [];
  if (finding.ungrounded) {
    notes.push(`_Not blocking: ungrounded — ${finding.ungrounded}._`);
  }
  if (finding.context) notes.push(`_Context: ${finding.context}._`);
  return notes;
}

/** @returns {string|null} evidence when the path exists at `headRef`. */
function refutePathAbsent(claim, headRef, git) {
  const result = git('cat-file', '-e', `${headRef}:${claim.path}`);
  return result?.status === 0 ? `git cat-file found ${claim.path}` : null;
}

/** File of one `git grep <ref>` hit line (`<ref>:<file>:<n>:<text>`). */
function hitFile(line, headRef) {
  const rest = line.startsWith(`${headRef}:`)
    ? line.slice(headRef.length + 1)
    : line;
  return rest.slice(0, rest.indexOf(':'));
}

/** @returns {string|null} evidence when no hit falls outside `claim.path`. */
function refuteSymbolReferenced(claim, headRef, git) {
  const result = git(
    'grep',
    '-n',
    '-w',
    '-F',
    '-e',
    claim.symbol,
    headRef,
    '--',
  );
  if (result?.status !== 0 && result?.status !== 1) return null;
  const outside = String(result.stdout ?? '')
    .split('\n')
    .filter((line) => line.length > 0)
    .some((line) => hitFile(line, headRef) !== claim.path);
  if (outside) return null;
  return claim.path
    ? `git grep found no references outside ${claim.path}`
    : 'git grep found no references';
}

const REFUTERS = {
  'path-absent': refutePathAbsent,
  'symbol-referenced': refuteSymbolReferenced,
};

/** @returns {Finding} */
function groundFinding(finding, headRef, git) {
  const refute = REFUTERS[finding?.claim?.kind];
  if (finding?.severity !== 'critical' || !refute) return finding;
  let evidence = null;
  try {
    evidence = refute(finding.claim, headRef, git);
  } catch {
    evidence = null;
  }
  if (!evidence) return finding;
  return { ...finding, severity: 'suggestion', ungrounded: evidence };
}

/** Names a degradation reason carries, split on its list punctuation. */
function reasonTokens(degradations) {
  return new Set(
    degradations.flatMap((d) => String(d.reason).split(/[\s,()]+/)),
  );
}

function annotateContext(finding, tokens) {
  const names = [finding.file, finding.claim?.path, finding.claim?.symbol];
  if (!names.some((name) => name && tokens.has(name))) return finding;
  return { ...finding, context: TRUNCATED_CONTEXT };
}

/**
 * @param {{
 *   findings: Finding[],
 *   headRef: string,
 *   degradations?: ReadonlyArray<{ reason: string }>,
 *   cwd?: string,
 *   gitSpawnFn?: typeof gitSpawn,
 * }} args
 * @returns {Finding[]}
 */
export function groundFindings({
  findings,
  headRef,
  degradations = [],
  cwd = process.cwd(),
  gitSpawnFn = gitSpawn,
}) {
  const git = (...args) => gitSpawnFn(cwd, ...args);
  const tokens = reasonTokens(degradations);
  return findings.map((finding) => {
    const grounded = groundFinding(finding, headRef, git);
    return grounded && tokens.size > 0
      ? annotateContext(grounded, tokens)
      : grounded;
  });
}
