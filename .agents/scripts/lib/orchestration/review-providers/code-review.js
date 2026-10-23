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
 * A diff over the cap is reviewed chunk by chunk (file-aligned, sequential,
 * findings merged); what went unchecked — a truncated file, files past the
 * chunk bound, a chunk with no verdict, a capped `<callers>` block — is
 * recorded beside the findings, naming the files.
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
  FINDINGS_SCHEMA_JSON,
  readAuthStatus,
  resolveVerdict,
} from './claude-verdict.js';
import { readDiff } from './generated-diff.js';
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
/** Larger diffs are reviewed in file-aligned chunks of at most this size. */
const MAX_DIFF_CHARS = 200_000;
/** Files packed past this many chunks are not reviewed; each is degraded by name. */
const MAX_REVIEW_CHUNKS = 6;
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
  'input, command or test that exposes it). A `shortcut:` comment naming ' +
  'its ceiling and trigger is a decision, not a finding, unless this diff ' +
  'itself crosses the ceiling.\n\n' +
  'The diff below is authoritative — files on disk may not reflect it. ' +
  'Answer with a JSON object of this exact shape, no prose around it:\n\n' +
  '{"findings":[{"title":"...","body":"Why it is wrong: ... How to show it ' +
  'fails: ...","file":"...","line":1,"category":"bug"}]}\n\n' +
  'Emit {"findings":[]} if there is nothing you would block the merge for.\n\n';

/**
 * Split a diff at `diff --git` boundaries into per-file sections.
 *
 * @param {string} diff
 * @returns {{ file: string, text: string }[]}
 */
function splitSections(diff) {
  const starts = [...diff.matchAll(/^diff --git /gm)].map((m) => m.index);
  if (starts[0] !== 0) starts.unshift(0);
  return starts.map((start, i) => {
    const text = diff.slice(start, starts[i + 1] ?? diff.length);
    const name =
      text.match(/^\+\+\+ b\/(.+)$/m) ??
      text.match(/^diff --git a\/.+ b\/(.+)$/m);
    return { file: name ? name[1] : '(unnamed)', text };
  });
}

/**
 * First-fit, in diff order, into chunks of at most `budget` characters; a
 * section over the budget gets a chunk of its own (truncated when reviewed).
 *
 * @param {{ file: string, text: string }[]} sections
 * @param {number} budget
 */
function packChunks(sections, budget) {
  const chunks = [];
  for (const section of sections) {
    const size = section.text.length;
    const open = chunks.find((c) => c.size + size <= budget);
    if (open) {
      open.sections.push(section);
      open.size += size;
    } else {
      chunks.push({ sections: [section], size });
    }
  }
  return chunks;
}

/** @param {Finding[]} findings */
function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((f) => {
    const key = JSON.stringify([f.file, f.line, f.title]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * @param {ReviewInput} input
 * @param {string} diff
 * @param {string} callers - the `<callers>` section, or '' below `deep`.
 * @param {number} [cap]
 * @returns {string}
 */
function buildPrompt(input, diff, callers, cap = MAX_DIFF_CHARS) {
  const truncated = diff.length > cap;
  const body = truncated ? diff.slice(0, cap) : diff;
  const note = truncated ? `\n[diff truncated at ${cap} characters]\n` : '';
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

  /** The `<callers>` block rides every chunk, so it comes out of the budget. */
  async function reviewInChunks(input, text, callers) {
    const budget = MAX_DIFF_CHARS - callers.length;
    const chunks = packChunks(splitSections(text), budget);
    const overflow = chunks
      .splice(MAX_REVIEW_CHUNKS)
      .flatMap((c) => c.sections.map((s) => s.file));
    if (overflow.length > 0) {
      noteDegradation(
        `review bounded at ${MAX_REVIEW_CHUNKS} chunks: ${overflow.length} ` +
          `file(s) not reviewed: ${overflow.join(', ')}`,
      );
    }
    const findings = [];
    for (const chunk of chunks) {
      const files = chunk.sections.map((s) => s.file).join(', ');
      if (chunk.size > budget) {
        noteDegradation(
          `${files} truncated at ${budget} characters: ` +
            `${chunk.size - budget} characters not reviewed`,
        );
      }
      const prompt = buildPrompt(
        input,
        chunk.sections.map((s) => s.text).join(''),
        callers,
        budget,
      );
      const verdict = await reviewInTempDir(prompt, runDeps);
      if ('reason' in verdict) {
        noteDegradation(`no verdict for ${files}: ${verdict.reason}`);
      } else {
        findings.push(...verdict.findings);
      }
    }
    return dedupeFindings(findings);
  }

  return {
    async runReview(input) {
      degradations = [];
      assertInput(input);
      const diff = readDiff(gitSpawnFn, input, PROJECT_ROOT);
      if ('reason' in diff) return settle(diff);
      if (diff.text.trim().length === 0) return [];
      const callers = buildCallersSection({
        diff: diff.text,
        input,
        cwd: PROJECT_ROOT,
        gitSpawnFn,
      });
      if (callers.reason) noteDegradation(callers.reason);
      if (diff.text.length > MAX_DIFF_CHARS) {
        return reviewInChunks(input, diff.text, callers.text);
      }
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
