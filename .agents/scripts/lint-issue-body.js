#!/usr/bin/env node
// .agents/scripts/lint-issue-body.js
/**
 * Drift guard between the generated Issue Forms and the Story-body parser:
 * a human-filed Story whose body does not round-trip gets an informational
 * marker comment (never a CI failure).
 *
 * @module lint-issue-body
 */

import { spawnSync } from 'node:child_process';
import { runAsCli } from './lib/cli-utils.js';
import { parse, StoryBodyParseError } from './lib/story-body/story-body.js';

export const LINT_COMMENT_MARKER = '<!-- mandrel:issue-body-conformance -->';

/** `changes` and `references` are advisory, so not required. */
const REQUIRED_SECTIONS = [
  { field: 'goal', label: 'Goal' },
  { field: 'acceptance', label: 'Acceptance' },
  { field: 'verify', label: 'Verify' },
];

/**
 * Issue Forms render a skipped field as `_No response_`; treat it as absent.
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
 * @property {boolean}  conformant
 * @property {string[]} problems
 * @property {string[]} warnings
 * @property {boolean}  parseFailed
 */

/**
 * Pure. Parse errors become a non-conformant verdict, never a throw: the
 * caller's job is to comment, not crash CI.
 * @param {string} body
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

  if (result.info.isUnstructuredBody) {
    problems.push(
      'The body has no recognised `## Goal` / `## Acceptance` / `## Verify` sections. ' +
        'File via the Story issue form so it round-trips through the parser.',
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
 * @param {ConformanceVerdict} verdict
 * @returns {string}
 */
export function renderConformanceComment(verdict) {
  const lines = [
    LINT_COMMENT_MARKER,
    '### ⚠️ Ticket body does not round-trip through the Mandrel parser',
    '',
    'Agents build ticket bodies from a canonical schema that this body does ' +
      'not match, so the supported human entry points (e.g. `/mandrel-plan` from an ' +
      'existing Epic ID) will reject it. Please fix the following:',
    '',
    ...verdict.problems.map((p) => `- ${p}`),
    '',
    'The quickest fix is to refile using the **Story** issue form ' +
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
 * @param {string[]} labelNames
 * @returns {boolean}
 */
export function isStoryTicket(labelNames) {
  return Array.isArray(labelNames) && labelNames.includes('type::story');
}

/**
 * @param {{
 *   issue: string|number,
 *   repo?: string,
 *   dryRun?: boolean,
 *   ghFn?: (args: string[]) => string,
 *   write?: (s: string) => void,
 * }} opts
 * @returns {{ skipped?: string, conformant?: boolean, problems?: string[] }}
 */
export function runLintIssueBody({
  issue,
  repo,
  dryRun = false,
  ghFn = gh,
  write = (s) => {
    process.stdout.write(s);
  },
}) {
  const repoArgs = repo ? ['--repo', repo] : [];
  const raw = ghFn([
    'issue',
    'view',
    String(issue),
    ...repoArgs,
    '--json',
    'body,labels',
  ]);
  const { body, labels } = JSON.parse(raw);
  const labelNames = (labels ?? []).map((l) => l.name);
  if (!isStoryTicket(labelNames)) {
    const envelope = { issue: Number(issue), skipped: 'not-a-ticket' };
    write(`${JSON.stringify(envelope)}\n`);
    return envelope;
  }

  const verdict = evaluateIssueBody(body ?? '');
  write(
    `${JSON.stringify({
      issue: Number(issue),
      conformant: verdict.conformant,
      problems: verdict.problems,
    })}\n`,
  );

  if (verdict.conformant || dryRun) {
    return {
      conformant: verdict.conformant,
      problems: verdict.problems,
    };
  }

  const comment = renderConformanceComment(verdict);
  ghFn(['issue', 'comment', String(issue), ...repoArgs, '--body', comment]);
  return { conformant: false, problems: verdict.problems };
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const issue = get('--issue') ?? process.env.ISSUE_NUMBER;
  if (!issue) {
    throw new Error('lint-issue-body: --issue <n> or ISSUE_NUMBER is required');
  }
  runLintIssueBody({
    issue,
    repo: get('--repo') ?? process.env.GITHUB_REPOSITORY,
    dryRun: args.includes('--dry-run'),
  });
}

runAsCli(import.meta.url, main, { source: 'lint-issue-body' });
