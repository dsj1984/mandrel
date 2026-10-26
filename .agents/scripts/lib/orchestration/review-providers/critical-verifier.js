/**
 * review-providers/critical-verifier.js — a fresh-context, read-only
 * `claude --print` check of each CRITICAL left after claim grounding. It sees
 * one finding and the refs, nothing else, so it stays a bug check. Only a
 * strict-majority refutation downgrades; an error, a timeout, a missing CLI or
 * unproven evidence leaves the CRITICAL blocking and records a degradation.
 *
 * @typedef {import('./types.js').Finding} Finding
 * @typedef {import('./degraded-gates.js').GateDegradation} GateDegradation
 * @typedef {{ attempted: number, confirmed: number, refuted: number,
 *   uncertain: number, errored: number }} VerificationSummary
 */

import { gitSpawn } from '../../git-utils.js';
import { isObject } from '../../json-utils.js';
import { PROJECT_ROOT } from '../../project-root.js';
import { groundFindings } from './claim-grounding.js';
import { clip } from './claude-verdict.js';
import { runClaude } from './code-review.js';
import { probeClaudeCli } from './security-review.js';

const VERDICTS = ['confirmed', 'refuted', 'uncertain'];

const VERDICT_SCHEMA_JSON = JSON.stringify({
  type: 'object',
  properties: {
    verdict: { enum: VERDICTS },
    evidence: {
      type: ['object', 'null'],
      properties: {
        file: { type: 'string' },
        line: { type: 'integer' },
        excerpt: { type: 'string' },
      },
      required: ['file', 'line'],
    },
    reason: { type: 'string' },
  },
  required: ['verdict', 'reason'],
});

/** Read-only by construction: no edit tool, Bash only for three git reads. */
const VERIFIER_ARGS = Object.freeze([
  '--print',
  '--output-format',
  'json',
  '--json-schema',
  VERDICT_SCHEMA_JSON,
  '--setting-sources',
  'user',
  '--strict-mcp-config',
  '--tools',
  'Read,Grep,Glob,Bash',
  '--allowedTools',
  'Read',
  'Grep',
  'Glob',
  'Bash(git show:*)',
  'Bash(git grep:*)',
  'Bash(git log:*)',
]);

const VERIFY_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_VERIFIED_CRITICALS = 10;
const MAX_IN_FLIGHT = 3;
const DEGRADATION_BASE = Object.freeze({
  tool: 'critical-verifier',
  gate: 'codeReview',
  surface: 'critical-verification',
});

const emptyVerification = () => ({
  attempted: 0,
  confirmed: 0,
  refuted: 0,
  uncertain: 0,
  errored: 0,
});

/** An injected review provider's findings are scored as returned. */
const skipVerification = async ({ findings }) => ({
  findings,
  degradations: [],
  verification: emptyVerification(),
});

/** @param {Finding} f */
const findingName = (f) =>
  f.file
    ? `"${f.title}" (${f.file}${f.line ? `:${f.line}` : ''})`
    : `"${f.title}"`;

/**
 * @param {Finding} finding
 * @param {{ baseRef: string, headRef: string }} refs
 * @returns {string}
 */
function buildVerifierPrompt(finding, { baseRef, headRef }) {
  const subject = {
    title: finding.title,
    body: finding.body,
    file: finding.file ?? null,
    line: finding.line ?? null,
    claim: finding.claim ?? null,
  };
  return (
    `A code reviewer raised the finding below against the change \`${baseRef}...${headRef}\`. ` +
    `Decide whether it is a real bug in the code at \`${headRef}\`.\n\n` +
    `Read code only at \`${headRef}\` (\`git show ${headRef}:<path>\`, ` +
    `\`git grep <pattern> ${headRef}\`, \`git log\`): the working tree may not be at it.\n\n` +
    'Answer `confirmed` only with the file and line at that ref that show the bug, ' +
    '`refuted` when the code there shows the finding is wrong, `uncertain` otherwise. ' +
    'Give the reason in one or two sentences, as JSON: ' +
    '{"verdict":"...","evidence":{"file":"...","line":1,"excerpt":"..."},"reason":"..."}\n\n' +
    `<finding>\n${JSON.stringify(subject, null, 2)}\n</finding>\n`
  );
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** @returns {object|null} the verdict object of a successful envelope. */
function verdictPayload(result) {
  const envelope = result.status === 0 ? tryParseJson(result.stdout) : null;
  if (!isObject(envelope) || envelope.subtype !== 'success') return null;
  if (envelope.is_error === true) return null;
  const payload = isObject(envelope.structured_output)
    ? envelope.structured_output
    : tryParseJson(String(envelope.result ?? ''));
  return isObject(payload) && VERDICTS.includes(payload.verdict)
    ? payload
    : null;
}

/**
 * @param {{ status: number, stdout: string, stderr: string }} result
 * @returns {{ verdict: string, evidence: object|null, reason: string } | { error: string }}
 */
function parseVerifierResult(result) {
  const payload = verdictPayload(result);
  if (!payload) {
    return result.status === 0
      ? { error: 'verifier output did not parse as a verdict' }
      : {
          error: `claude --print exited ${result.status}: ${clip(result.stderr || result.stdout) || '<no output>'}`,
        };
  }
  return {
    verdict: payload.verdict,
    evidence: isObject(payload.evidence) ? payload.evidence : null,
    reason: clip(payload.reason) || '(no reason given)',
  };
}

/** True when `evidence` names a file and an in-range line at `headRef`. */
function evidenceExists(evidence, { headRef, cwd, gitSpawnFn }) {
  if (typeof evidence?.file !== 'string' || !Number.isInteger(evidence.line)) {
    return false;
  }
  try {
    const shown = gitSpawnFn(cwd, 'show', `${headRef}:${evidence.file}`);
    if (shown?.status !== 0) return false;
    const lines = String(shown.stdout ?? '')
      .replace(/\n$/, '')
      .split('\n');
    return evidence.line >= 1 && evidence.line <= lines.length;
  } catch {
    return false;
  }
}

/**
 * One verifier call, settled to an outcome; never throws.
 *
 * @returns {Promise<{ outcome: 'confirmed'|'refuted'|'uncertain'|'errored', reason: string }>}
 */
async function runVoter(finding, ctx) {
  if (!ctx.cliPresent)
    return { outcome: 'errored', reason: 'claude CLI not found on PATH' };
  let parsed;
  try {
    parsed = parseVerifierResult(
      await runClaude(VERIFIER_ARGS, {
        cwd: ctx.cwd,
        input: buildVerifierPrompt(finding, ctx),
        timeout: VERIFY_TIMEOUT_MS,
        run: ctx.spawnFn,
        platform: ctx.platform,
      }),
    );
  } catch (err) {
    parsed = { error: clip(err?.message ?? err) };
  }
  if ('error' in parsed) return { outcome: 'errored', reason: parsed.error };
  if (parsed.verdict === 'confirmed' && !evidenceExists(parsed.evidence, ctx)) {
    return {
      outcome: 'uncertain',
      reason: 'confirmation evidence not found at head',
      unproven: true,
    };
  }
  return { outcome: parsed.verdict, reason: parsed.reason };
}

/** Run `tasks` (thunks) with at most `limit` in flight; results keep order. */
async function runPooled(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker),
  );
  return results;
}

/** Downgrade on a strict majority of refutations; otherwise unchanged. */
function settleFinding(finding, votes) {
  const refutations = votes.filter((v) => v.outcome === 'refuted');
  if (refutations.length * 2 <= votes.length) return finding;
  return {
    ...finding,
    severity: 'suggestion',
    unverified: refutations[0].reason,
  };
}

function voteDegradations(finding, votes) {
  return votes
    .filter((v) => v.outcome === 'errored' || v.unproven)
    .map((v) => ({
      ...DEGRADATION_BASE,
      reason: `${findingName(finding)} stays blocking: ${v.reason}`,
    }));
}

function boundDegradation(skipped) {
  if (skipped.length === 0) return [];
  return [
    {
      ...DEGRADATION_BASE,
      reason:
        `verification bounded at ${MAX_VERIFIED_CRITICALS} criticals: ` +
        `${skipped.length} stand unverified: ${skipped.map(findingName).join(', ')}`,
    },
  ];
}

/**
 * Verify every `critical` finding; findings below critical are never sent.
 * One verifier at `light`/`standard`, three at `deep`.
 *
 * @param {{
 *   findings: Finding[], baseRef: string, headRef: string,
 *   depth?: 'light'|'standard'|'deep', cwd?: string,
 *   spawnFn?: Function, probeFn?: () => boolean,
 *   gitSpawnFn?: typeof gitSpawn, platform?: string,
 *   logger?: { info?: Function },
 * }} args
 * @returns {Promise<{ findings: Finding[], degradations: GateDegradation[],
 *   verification: VerificationSummary }>}
 */
async function verifyCriticals(args) {
  const verification = emptyVerification();
  const criticals = args.findings.filter((f) => f?.severity === 'critical');
  if (criticals.length === 0) {
    return { findings: args.findings, degradations: [], verification };
  }
  const checked = criticals.slice(0, MAX_VERIFIED_CRITICALS);
  const voters = args.depth === 'deep' ? 3 : 1;
  const ctx = {
    baseRef: args.baseRef,
    headRef: args.headRef,
    cwd: args.cwd ?? PROJECT_ROOT,
    spawnFn: args.spawnFn,
    platform: args.platform ?? process.platform,
    gitSpawnFn: args.gitSpawnFn ?? gitSpawn,
    cliPresent: (args.probeFn ?? probeClaudeCli)(),
  };
  args.logger?.info?.(
    `[code-review] Verifying ${checked.length} critical(s) with ${voters} verifier(s) each...`,
  );
  const tasks = checked.flatMap((f) =>
    Array.from({ length: voters }, () => () => runVoter(f, ctx)),
  );
  const outcomes = await runPooled(tasks, MAX_IN_FLIGHT);
  const settled = new Map();
  const degradations = [];
  checked.forEach((finding, i) => {
    const votes = outcomes.slice(i * voters, (i + 1) * voters);
    for (const v of votes) verification[v.outcome] += 1;
    settled.set(finding, settleFinding(finding, votes));
    degradations.push(...voteDegradations(finding, votes));
  });
  verification.attempted = tasks.length;
  degradations.push(
    ...boundDegradation(criticals.slice(MAX_VERIFIED_CRITICALS)),
  );
  return {
    findings: args.findings.map((f) => settled.get(f) ?? f),
    degradations,
    verification,
  };
}

/**
 * The pipeline step: ground every finding, then verify the CRITICALs left.
 * An injected review provider gets no verifier unless `opts.verifier` (the
 * spawn/probe/git seams) is given too.
 *
 * @param {{ findings: Finding[], reviewInput: { baseRef: string,
 *   headRef: string, depth?: string }, opts: object,
 *   degradations: GateDegradation[] }} args
 */
export async function vetFindings({
  findings,
  reviewInput,
  opts,
  degradations,
}) {
  const { baseRef, headRef, depth } = reviewInput;
  const grounded = groundFindings({
    findings,
    headRef,
    baseRef,
    cwd: opts.cwd,
    degradations,
    gitSpawnFn: opts.gitSpawnFn,
  });
  const verify =
    opts.verifier || !opts.reviewProvider ? verifyCriticals : skipVerification;
  const verified = await verify({
    findings: grounded.findings,
    baseRef,
    headRef,
    depth,
    cwd: opts.cwd,
    gitSpawnFn: opts.gitSpawnFn,
    logger: opts.logger,
    ...opts.verifier,
  });
  return {
    findings: verified.findings,
    degradations: [...grounded.degradations, ...verified.degradations],
    verification: verified.verification,
  };
}
