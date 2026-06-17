#!/usr/bin/env node
// .agents/scripts/lint-issue-body.js
/**
 * Issue-body conformance lint (Story #4227).
 *
 * Runs the canonical `story-body.parse()` against a human-opened
 * `type::story` / `type::epic` issue body and reports whether the body
 * round-trips. This is the drift guard between the generated GitHub Issue
 * Forms (`lib/bootstrap/issue-forms-template.js`) and the parser: if a
 * human files a ticket whose body `parse()` rejects (or which lacks the
 * binding `goal` / `acceptance` / `verify` sections), the lint surfaces a
 * **comment** on the issue rather than failing silently — the supported
 * human entry points (`/plan` from an existing Epic ID, the qa-assist →
 * `/plan` handoff) depend on a parseable body.
 *
 * ## Design
 *
 * - `evaluateIssueBody(body)` is **pure** (no I/O): it parses the body and
 *   returns a structured conformance verdict. This is the unit-tested core.
 * - The CLI wrapper reads the issue body + labels (via `gh` or env), runs
 *   the evaluator, and posts/updates a single marker comment when the body
 *   is non-conformant. Network-touching, exercised in CI.
 *
 * GitHub Issue Forms render a skipped optional field as the literal
 * `_No response_`; the evaluator strips that sentinel so an empty optional
 * section does not masquerade as content.
 *
 * @module lint-issue-body
 */

import { spawnSync } from 'node:child_process';
import { runAsCli } from './lib/cli-utils.js';
import { parse, StoryBodyParseError } from './lib/story-body/story-body.js';

/**
 * Marker that identifies the lint's own comment so re-runs update rather
 * than duplicate it.
 */
export const LINT_COMMENT_MARKER = '<!-- mandrel:issue-body-conformance -->';

/**
 * The binding sections every conformant ticket body MUST carry. `changes`
 * and `references` are advisory (per the Engineer persona's implementation
 * latitude), so they are not required here.
 */
const REQUIRED_SECTIONS = [
  { field: 'goal', label: 'Goal' },
  { field: 'acceptance', label: 'Acceptance' },
  { field: 'verify', label: 'Verify' },
];

/**
 * Strip the GitHub Issue Form empty-field sentinel so a skipped optional
 * field is treated as absent rather than literal content.
 *
 * @param {string} body
 * @returns {string}
 */
function stripNoResponseSentinel(body) {
  return body
    .split('\n')
    .filter((line) => line.trim() !== '_No response_')
    .join('\n');
}

/**
 * @typedef {object} ConformanceVerdict
 * @property {boolean}  conformant   - True when the body parses AND carries
 *   every required section with non-empty content.
 * @property {string[]} problems     - Human-readable problem statements
 *   (empty when conformant).
 * @property {string[]} warnings     - Non-fatal parser warnings surfaced for
 *   transparency (e.g. legacy-path-entry).
 * @property {boolean}  parseFailed  - True when `parse()` threw (fail-closed).
 */

/**
 * Evaluate an issue body for conformance with the canonical Story-body
 * schema. Pure — no I/O. Fail-closed parse errors are caught and reported
 * as a non-conformant verdict (never thrown), because the caller's job is
 * to *comment*, not to crash CI.
 *
 * @param {string} body - Raw issue-body markdown.
 * @returns {ConformanceVerdict}
 */
export function evaluateIssueBody(body) {
  if (typeof body !== 'string' || body.trim().length === 0) {
    return {
      conformant: false,
      problems: ['The issue body is empty.'],
      warnings: [],
      parseFailed: true,
    };
  }

  const cleaned = stripNoResponseSentinel(body);

  let result;
  try {
    result = parse(cleaned);
  } catch (err) {
    if (err instanceof StoryBodyParseError) {
      return {
        conformant: false,
        problems: [
          `The body could not be parsed into the canonical schema: ${err.message}`,
        ],
        warnings: [],
        parseFailed: true,
      };
    }
    throw err;
  }

  const problems = [];

  // A legacy string body parses but carries no structured sections — that
  // is exactly the human-filed shape this lint exists to catch.
  if (result.info.isLegacyStringBody) {
    problems.push(
      'The body has no recognised `## Goal` / `## Acceptance` / `## Verify` sections. ' +
        'File via the Story/Epic issue form so it round-trips through the parser.',
    );
  }

  for (const { field, label } of REQUIRED_SECTIONS) {
    const value = result.body[field];
    const empty =
      value == null ||
      (typeof value === 'string' && value.trim().length === 0) ||
      (Array.isArray(value) && value.length === 0);
    if (empty) {
      problems.push(
        `The required \`## ${label}\` section is missing or empty.`,
      );
    }
  }

  return {
    conformant: problems.length === 0,
    problems,
    warnings: result.warnings,
    parseFailed: false,
  };
}

/**
 * Render the markdown comment body the lint posts on a non-conformant
 * issue. Carries {@link LINT_COMMENT_MARKER} so re-runs update in place.
 *
 * @param {ConformanceVerdict} verdict
 * @returns {string}
 */
export function renderConformanceComment(verdict) {
  const lines = [
    LINT_COMMENT_MARKER,
    '### ⚠️ Ticket body does not round-trip through the Mandrel parser',
    '',
    'Agents build ticket bodies from a canonical schema that this body does ' +
      'not match, so the supported human entry points (e.g. `/plan` from an ' +
      'existing Epic ID) will reject it. Please fix the following:',
    '',
    ...verdict.problems.map((p) => `- ${p}`),
    '',
    'The quickest fix is to refile using the **Story** or **Epic** issue form ' +
      '(New issue → pick the template), which lays out the required sections.',
  ];
  if (verdict.warnings.length > 0) {
    lines.push(
      '',
      '<details><summary>Parser warnings (non-blocking)</summary>',
      '',
      ...verdict.warnings.map((w) => `- ${w}`),
      '',
      '</details>',
    );
  }
  return lines.join('\n');
}

/**
 * Thin `gh` wrapper. Returns the trimmed stdout, throwing on a non-zero
 * exit so the CLI surfaces the failure (orchestration-error-handling rule).
 *
 * @param {string[]} args
 * @returns {string}
 */
function gh(args) {
  const res = spawnSync('gh', args, { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(
      `gh ${args.join(' ')} failed (exit ${res.status}): ${res.stderr?.trim() ?? ''}`,
    );
  }
  return (res.stdout ?? '').trim();
}

/**
 * CLI entry. Reads the target issue (number from `--issue` or the
 * `ISSUE_NUMBER` env), fetches its body + labels, and — when the body is
 * non-conformant — upserts a single marker comment. Always exits 0 (the
 * lint *informs*, it does not block), unless an unexpected I/O error occurs.
 *
 * Flags:
 *   --issue <n>   Issue number (defaults to env ISSUE_NUMBER).
 *   --repo <o/r>  owner/repo (defaults to env GITHUB_REPOSITORY).
 *   --dry-run     Evaluate + print the verdict, never touch GitHub.
 */
async function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dryRun = args.includes('--dry-run');
  const issue = get('--issue') ?? process.env.ISSUE_NUMBER;
  const repo = get('--repo') ?? process.env.GITHUB_REPOSITORY;

  if (!issue) {
    throw new Error('lint-issue-body: --issue <n> or ISSUE_NUMBER is required');
  }

  const repoArgs = repo ? ['--repo', repo] : [];
  const raw = gh([
    'issue',
    'view',
    String(issue),
    ...repoArgs,
    '--json',
    'body,labels',
  ]);
  const { body, labels } = JSON.parse(raw);
  const labelNames = (labels ?? []).map((l) => l.name);
  const isTicket =
    labelNames.includes('type::story') || labelNames.includes('type::epic');

  if (!isTicket) {
    // Machine-parsable JSON envelope → process.stdout.write (not console.log),
    // per the .agents/scripts logging contract (tests/enforcement/no-console).
    process.stdout.write(
      `${JSON.stringify({ issue: Number(issue), skipped: 'not-a-ticket' })}\n`,
    );
    return;
  }

  const verdict = evaluateIssueBody(body ?? '');
  process.stdout.write(
    `${JSON.stringify({
      issue: Number(issue),
      conformant: verdict.conformant,
      problems: verdict.problems,
    })}\n`,
  );

  if (verdict.conformant || dryRun) return;

  const comment = renderConformanceComment(verdict);
  gh(['issue', 'comment', String(issue), ...repoArgs, '--body', comment]);
}

runAsCli(import.meta.url, main, { source: 'lint-issue-body' });
