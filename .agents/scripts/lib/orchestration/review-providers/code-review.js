/**
 * review-providers/code-review.js — a low-effort model bug review of the
 * Story diff through `claude --print --effort low`. It asks only for
 * merge-blocking problems, so every parsed finding is `critical` and halts
 * close before auto-merge. The reviewer is handed the diff range, the Story
 * id and the diff text — never `acceptance[]` or the self-eval verdict: this
 * is a bug review, not a second acceptance scoring.
 *
 * A missing CLI throws at construction (the default chain entry is
 * `optional: true`, so hosts without it skip). A review that cannot run or
 * whose output does not parse degrades to one non-halting `suggestion`.
 *
 * @typedef {import('./types.js').Finding}        Finding
 * @typedef {import('./types.js').ReviewInput}    ReviewInput
 * @typedef {import('./types.js').ReviewProvider} ReviewProvider
 */

import { spawnCapture } from '../../child-exec.js';
import { gitSpawn } from '../../git-utils.js';
import { PROJECT_ROOT } from '../../project-root.js';
import { parseProviderFindings } from './parse-findings.js';
import { renderDepthDirective } from './review-depth.js';
import { probeClaudeCli } from './security-review.js';

const CLAUDE_ARGS = Object.freeze(['--print', '--effort', 'low']);
const INVOKE_TIMEOUT_MS = 10 * 60 * 1000;
/** Larger diffs are truncated; the reviewer is told so. */
const MAX_DIFF_CHARS = 200_000;

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
  'Emit ONLY a JSON array on stdout with this exact shape, no prose around ' +
  'it:\n\n' +
  '[{"title":"...","body":"Why it is wrong: ... How to show it fails: ...",' +
  '"file":"...","line":1,"category":"bug"}]\n\n' +
  'Emit [] if there is nothing you would block the merge for.\n\n';

/**
 * @param {ReviewInput} input
 * @param {string} diff
 * @returns {string}
 */
function buildPrompt(input, diff) {
  const truncated = diff.length > MAX_DIFF_CHARS;
  const body = truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff;
  const note = truncated
    ? `\n[diff truncated at ${MAX_DIFF_CHARS} characters]\n`
    : '';
  const head = PROMPT_HEAD.replace('{baseRef}', input.baseRef)
    .replace('{headRef}', input.headRef)
    .replace('{ticketId}', String(input.ticketId))
    .replace('{depthDirective}', renderDepthDirective(input.depth));
  return `${head}<diff>\n${body}${note}\n</diff>\n`;
}

/**
 * The prompt rides stdin so no shell ever quotes it.
 *
 * @param {string} prompt
 * @param {Function} [run] - `spawnSync`-shaped seam for tests.
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function invokeClaude(prompt, run) {
  return spawnCapture('claude', [...CLAUDE_ARGS], {
    cwd: PROJECT_ROOT,
    input: prompt,
    shell: process.platform === 'win32',
    timeout: INVOKE_TIMEOUT_MS,
    ...(run ? { run } : {}),
  });
}

/** A model often fences its JSON; strip one surrounding fence. */
function stripFence(text) {
  const match = /^\s*```[a-z]*\s*\n([\s\S]*?)\n\s*```\s*$/i.exec(text ?? '');
  return match ? match[1] : (text ?? '');
}

/**
 * @param {string} title
 * @param {string} detail
 * @returns {Finding}
 */
function advisory(title, detail) {
  return {
    severity: 'suggestion',
    title,
    body:
      `${detail} The model bug review did not produce a verdict — inspect ` +
      'the diff manually before merging. Advisory only; the chain did not halt.',
    category: 'bug',
  };
}

/**
 * @param {string} stdout
 * @returns {Finding[]}
 */
function parseFindings(stdout) {
  try {
    return parseProviderFindings(stripFence(stdout), {
      errorPrefix: '[code-review] Failed to parse reviewer stdout as JSON',
      mapSeverity: () => 'critical',
      defaultCategory: 'bug',
    });
  } catch (err) {
    return [
      advisory(
        'Code review output not parseable as JSON',
        `The reviewer returned text that did not parse as a JSON findings array (${err.message}).`,
      ),
    ];
  }
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

/**
 * @param {{
 *   probeFn?: () => boolean,
 *   gitSpawnFn?: typeof gitSpawn,
 *   spawnFn?: Function,
 *   logger?: { info?: Function, warn?: Function },
 * }} [deps] - `spawnFn` replaces `spawnSync` for the `claude` call.
 * @returns {ReviewProvider}
 */
export function createCodeReviewProviderForRegistry(deps = {}) {
  const probeFn = deps.probeFn ?? probeClaudeCli;
  if (!probeFn()) {
    throw new Error(
      '[ReviewProviderFactory] codeReview provider "code-review" requires ' +
        'the `claude` CLI on PATH but it was not detected. Install the ' +
        'Claude Code CLI, or keep the entry `optional: true` so hosts ' +
        'without it skip the model bug review.',
    );
  }
  const gitSpawnFn = deps.gitSpawnFn ?? gitSpawn;
  const { spawnFn, logger } = deps;

  return {
    async runReview(input) {
      assertInput(input);
      const { baseRef, headRef, ticketId } = input;
      const diff = gitSpawnFn(
        PROJECT_ROOT,
        'diff',
        '--no-color',
        `${baseRef}...${headRef}`,
      );
      if (diff.status !== 0) {
        return [
          advisory(
            'Code review could not read the diff',
            `\`git diff ${baseRef}...${headRef}\` failed: ${diff.stderr || '<no output>'}.`,
          ),
        ];
      }
      if (diff.stdout.trim().length === 0) return [];

      logger?.info?.(
        `[code-review] Invoking claude --print --effort low for Story #${ticketId} (${baseRef}...${headRef})...`,
      );
      const result = invokeClaude(buildPrompt(input, diff.stdout), spawnFn);
      if (result.status !== 0) {
        logger?.warn?.(
          `[code-review] claude exited ${result.status}; emitting advisory.`,
        );
        return [
          advisory(
            'Code review did not complete',
            `\`claude --print\` exited with status ${result.status}: ${
              result.stderr || result.stdout || '<no output>'
            }.`,
          ),
        ];
      }
      return parseFindings(result.stdout);
    },
  };
}
