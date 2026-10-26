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

/** `{ file, text }` of one `git grep <ref>` hit (`<ref>:<file>:<n>:<text>`). */
function parseHit(line, headRef) {
  const rest = line.startsWith(`${headRef}:`)
    ? line.slice(headRef.length + 1)
    : line;
  const match = /^(.*?):\d+:(.*)$/.exec(rest);
  return match ? { file: match[1], text: match[2] } : { file: rest, text: '' };
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Only the symbol's own declaration line in `claim.path` is discounted; any
 * other hit there (a stale caller) still counts, so the check fails safe.
 */
function isDeclaration(hit, claim) {
  if (!claim.path || hit.file !== claim.path) return false;
  const declares = new RegExp(
    `\\b(?:function\\*?|class|const|let|var|def|type|interface|enum)\\s+${escapeRegExp(claim.symbol)}\\b`,
  );
  return declares.test(hit.text);
}

/** @returns {string|null} evidence when every hit is the declaration. */
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
  const referenced = String(result.stdout ?? '')
    .split('\n')
    .filter((line) => line.length > 0)
    .some((line) => !isDeclaration(parseHit(line, headRef), claim));
  if (referenced) return null;
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
  if (!isGroundable(finding)) return finding;
  const refute = REFUTERS[finding.claim.kind];
  let evidence = null;
  try {
    evidence = refute(finding.claim, headRef, git);
  } catch {
    evidence = null;
  }
  if (!evidence) return finding;
  return { ...finding, severity: 'suggestion', ungrounded: evidence };
}

const isGroundable = (finding) =>
  finding?.severity === 'critical' && Boolean(REFUTERS[finding?.claim?.kind]);

function headResolves(git, headRef) {
  try {
    return (
      git('rev-parse', '--verify', '--quiet', `${headRef}^{commit}`)?.status ===
      0
    );
  } catch {
    return false;
  }
}

/**
 * `cat-file` exits 128 for a missing path and an unknown ref alike, so the
 * head is checked on its own: an unresolvable head means every claim stays
 * unrefuted for want of a repository, and that is reported, not silent.
 * Probes only when some finding is groundable.
 *
 * @returns {import('./degraded-gates.js').GateDegradation[]}
 */
function headDegradations({ findings, headRef, cwd, git }) {
  if (!findings.some(isGroundable) || headResolves(git, headRef)) return [];
  return [
    {
      tool: 'claim-grounding',
      gate: 'claim-grounding',
      surface: 'head-ref',
      reason: `head ${headRef} not resolvable in ${cwd}`,
    },
  ];
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

function groundEach(findings, headRef, git, tokens) {
  return findings.map((finding) => {
    const grounded = groundFinding(finding, headRef, git);
    return grounded && tokens.size > 0
      ? annotateContext(grounded, tokens)
      : grounded;
  });
}

/**
 * Ground every finding in `cwd`, the reviewed repository. `degradations`
 * comes back with the head check's record appended when the head does not
 * resolve there.
 *
 * @param {{
 *   findings: Finding[],
 *   headRef: string,
 *   degradations?: ReadonlyArray<{ reason: string }>,
 *   cwd?: string,
 *   gitSpawnFn?: typeof gitSpawn,
 * }} args
 * @returns {{ findings: Finding[], degradations: Array<{ reason: string }> }}
 */
export function groundFindings({
  findings,
  headRef,
  degradations = [],
  cwd = process.cwd(),
  gitSpawnFn = gitSpawn,
}) {
  const git = (...args) => gitSpawnFn(cwd, ...args);
  const all = [
    ...degradations,
    ...headDegradations({ findings, headRef, cwd, git }),
  ];
  return {
    findings: groundEach(findings, headRef, git, reasonTokens(all)),
    degradations: all,
  };
}
