/**
 * review-providers/code-review.js — a low-effort model bug review of the
 * Story diff through `claude --print --effort low`. It asks only for
 * merge-blocking problems, so every parsed finding is `critical` and halts
 * close before auto-merge. The reviewer is handed the diff range, the Story
 * id and the diff text — never `acceptance[]` or the self-eval verdict: this
 * is a bug review, not a second acceptance scoring.
 *
 * Cost is bounded by stripping context, not by pinning a model: an empty
 * OS temp cwd (no CLAUDE.md discovery), user-only settings, no MCP, no tools.
 *
 * A missing CLI throws at construction (the chain entry is optional). A
 * review with no verdict records one degraded gate via `getDegradations()`
 * and returns no findings, so "never ran" cannot read as "found nothing".
 * A review that reached a verdict still records what it did not check — a
 * truncated diff, a capped `<callers>` block (depth `deep` only) — beside
 * its findings.
 *
 * @typedef {import('./types.js').Finding}        Finding
 * @typedef {import('./types.js').ReviewInput}    ReviewInput
 * @typedef {import('./types.js').ReviewProvider} ReviewProvider
 * @typedef {import('./degraded-gates.js').GateDegradation} GateDegradation
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnCaptureAsync } from '../../child-exec.js';
import { gitSpawn } from '../../git-utils.js';
import { PROJECT_ROOT } from '../../project-root.js';
import { buildCallersSection } from './callers-context.js';
import {
  clip,
  FINDINGS_SCHEMA_JSON,
  readAuthStatus,
  resolveVerdict,
} from './claude-verdict.js';
import { renderDepthDirective } from './review-depth.js';
import { probeClaudeCli } from './security-review.js';

const CLAUDE_ARGS = Object.freeze([
  '--print',
  '--effort',
  'low',
  '--output-format',
  'json',
  '--json-schema',
  FINDINGS_SCHEMA_JSON,
  '--setting-sources',
  'user',
  '--strict-mcp-config',
  '--tools',
  '',
]);
const AUTH_ARGS = Object.freeze(['auth', 'status', '--json']);
const INVOKE_TIMEOUT_MS = 10 * 60 * 1000;
const AUTH_TIMEOUT_MS = 15 * 1000;
/** Larger diffs are truncated; the reviewer is told so and a degradation is recorded. */
const MAX_DIFF_CHARS = 200_000;
const DEGRADATION_BASE = Object.freeze({
  tool: 'code-review',
  gate: 'codeReview',
  surface: 'model-bug-review',
});

const PROMPT_HEAD =
  'You are reviewing the diff `{baseRef}...{headRef}` for Story #{ticketId} ' +
  'before it merges. {depthDirective}\n\n' +
  'Report ONLY problems you would block this merge for: a bug that makes ' +
  'the change behave incorrectly, crash, lose data, or break an existing ' +
  'caller. Do not report style, naming, refactoring ideas, missing tests or ' +
  'anything you would merge anyway. For each problem give the file, the ' +
  'line in the new version, why it is wrong, and how to show it fails (an ' +
  'input, command or test that exposes it).\n\n' +
  'The diff below is authoritative — files on disk may not reflect it. ' +
  'Answer with a JSON object of this exact shape, no prose around it:\n\n' +
  '{"findings":[{"title":"...","body":"Why it is wrong: ... How to show it ' +
  'fails: ...","file":"...","line":1,"category":"bug"}]}\n\n' +
  'Emit {"findings":[]} if there is nothing you would block the merge for.\n\n';

/**
 * The truncation degradation reason, or null when the diff fits: the
 * unreviewed character count and the files whose first header is past the cut.
 *
 * @param {string} diff
 * @returns {string|null}
 */
function truncationReason(diff) {
  if (diff.length <= MAX_DIFF_CHARS) return null;
  const firstHeader = new Map();
  for (const match of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    if (!firstHeader.has(match[1])) firstHeader.set(match[1], match.index);
  }
  const unreviewedFiles = [...firstHeader.values()].filter(
    (index) => index >= MAX_DIFF_CHARS,
  ).length;
  return (
    `diff truncated at ${MAX_DIFF_CHARS} characters: ` +
    `${diff.length - MAX_DIFF_CHARS} characters and ${unreviewedFiles} ` +
    'file(s) not reviewed'
  );
}

/**
 * @param {ReviewInput} input
 * @param {string} diff
 * @param {string} callers - the `<callers>` section, or '' below `deep`.
 * @returns {string}
 */
function buildPrompt(input, diff, callers) {
  const truncated = diff.length > MAX_DIFF_CHARS;
  const body = truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff;
  const note = truncated
    ? `\n[diff truncated at ${MAX_DIFF_CHARS} characters]\n`
    : '';
  const head = PROMPT_HEAD.replace('{baseRef}', input.baseRef)
    .replace('{headRef}', input.headRef)
    .replace('{ticketId}', String(input.ticketId))
    .replace('{depthDirective}', renderDepthDirective(input.depth));
  return `${head}<diff>\n${body}${note}\n</diff>\n${callers}`;
}

/**
 * A Windows shell joins argv unquoted, which would drop `--tools ""` and
 * split the schema; quote each arg for the MSVCRT argv parser.
 *
 * @param {string} arg
 * @returns {string}
 */
function quoteWindowsArg(arg) {
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * Async, so close's concurrent gate children keep draining.
 *
 * @param {ReadonlyArray<string>} args
 * @param {{ cwd: string, input?: string, timeout: number, run?: Function, platform: string }} opts
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
function runClaude(args, { cwd, input, timeout, run, platform }) {
  const shell = platform === 'win32';
  return spawnCaptureAsync(
    'claude',
    shell ? args.map(quoteWindowsArg) : [...args],
    {
      cwd,
      input: input ?? '',
      shell,
      timeout,
      ...(run ? { run } : {}),
    },
  );
}

/**
 * @param {ReviewInput} input
 */
function assertInput(input) {
  const { baseRef, headRef, ticketId } = input ?? {};
  if (!baseRef || !headRef) {
    throw new TypeError(
      '[code-review] runReview requires baseRef and headRef.',
    );
  }
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    throw new TypeError(
      '[code-review] runReview requires a positive integer ticketId.',
    );
  }
}

function runAuthStatus(runDir, deps) {
  return runClaude(AUTH_ARGS, {
    cwd: runDir,
    timeout: AUTH_TIMEOUT_MS,
    run: deps.authSpawnFn,
    platform: deps.platform,
  });
}

function runReviewer(runDir, prompt, deps) {
  return runClaude(CLAUDE_ARGS, {
    cwd: runDir,
    input: prompt,
    timeout: INVOKE_TIMEOUT_MS,
    run: deps.spawnFn,
    platform: deps.platform,
  });
}

/**
 * Preflight, then the review, both from a fresh OS temp dir removed after.
 *
 * @returns {Promise<{ findings: Finding[] } | { reason: string }>}
 */
async function reviewInTempDir(prompt, deps) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandrel-code-review-'));
  try {
    const auth = readAuthStatus(await runAuthStatus(runDir, deps));
    if (!auth.ok) return auth;
    deps.logger?.info?.(
      `[code-review] Invoking claude --print --effort low (${auth.detail})...`,
    );
    return resolveVerdict(await runReviewer(runDir, prompt, deps));
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

/**
 * @returns {{ reason: string } | { text: string }}
 */
function readDiff(gitSpawnFn, { baseRef, headRef }) {
  const range = `${baseRef}...${headRef}`;
  const diff = gitSpawnFn(PROJECT_ROOT, 'diff', '--no-color', range);
  if (diff.status === 0) return { text: diff.stdout };
  return {
    reason: `git diff ${range} failed: ${clip(diff.stderr) || '<no output>'}`,
  };
}

function assertCliPresent(probeFn) {
  if (probeFn()) return;
  throw new Error(
    '[ReviewProviderFactory] codeReview provider "code-review" requires ' +
      'the `claude` CLI on PATH but it was not detected. Install the ' +
      'Claude Code CLI, or keep the entry `optional: true` so hosts ' +
      'without it skip the model bug review.',
  );
}

/**
 * @param {{
 *   probeFn?: () => boolean,
 *   gitSpawnFn?: typeof gitSpawn,
 *   spawnFn?: Function,
 *   authSpawnFn?: Function,
 *   platform?: string,
 *   logger?: { info?: Function, warn?: Function },
 * }} [deps] - `spawnFn` / `authSpawnFn` replace the async runner for the
 *   review and the `claude auth status` preflight.
 * @returns {ReviewProvider & { getDegradations: () => GateDegradation[] }}
 */
export function createCodeReviewProviderForRegistry(deps = {}) {
  assertCliPresent(deps.probeFn ?? probeClaudeCli);
  const gitSpawnFn = deps.gitSpawnFn ?? gitSpawn;
  const runDeps = { ...deps, platform: deps.platform ?? process.platform };
  /** @type {GateDegradation[]} */
  let degradations = [];

  /** Record a not-checked slice without replacing the findings. */
  function noteDegradation(reason) {
    degradations.push({ ...DEGRADATION_BASE, reason });
    deps.logger?.warn?.(`[code-review] Not checked: ${reason}.`);
  }

  function settle(verdict) {
    if (!('reason' in verdict)) return verdict.findings;
    degradations.push({ ...DEGRADATION_BASE, reason: verdict.reason });
    deps.logger?.warn?.(`[code-review] No verdict: ${verdict.reason}.`);
    return [];
  }

  return {
    async runReview(input) {
      degradations = [];
      assertInput(input);
      const diff = readDiff(gitSpawnFn, input);
      if ('reason' in diff) return settle(diff);
      if (diff.text.trim().length === 0) return [];
      const truncation = truncationReason(diff.text);
      if (truncation) noteDegradation(truncation);
      const callers = buildCallersSection({
        diff: diff.text,
        input,
        cwd: PROJECT_ROOT,
        gitSpawnFn,
      });
      if (callers.reason) noteDegradation(callers.reason);
      return settle(
        await reviewInTempDir(
          buildPrompt(input, diff.text, callers.text),
          runDeps,
        ),
      );
    },
    getDegradations() {
      return degradations.map((d) => ({ ...d }));
    },
  };
}
