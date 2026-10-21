#!/usr/bin/env node
// .agents/scripts/lint-issue-body.js
/**
 * Drift guard between the generated Issue Forms and the Story-body parser:
 * a human-filed Story whose body does not round-trip gets an informational
 * marker comment (never a CI failure).
 *
 * @module lint-issue-body
 */

import { runAsCli } from './lib/cli-utils.js';
import { runGh } from './lib/gh-exec.js';
import { parse, StoryBodyParseError } from './lib/story-body/story-body.js';

export const LINT_COMMENT_MARKER = '<!-- mandrel:issue-body-conformance -->';

/** `changes` and `references` are advisory, so not required. */
const REQUIRED_SECTIONS = [
  { field: 'goal', label: 'Goal' },
  { field: 'acceptance', label: 'Acceptance' },
  { field: 'verify', label: 'Verify' },
];

/** The closed set of section names a comment may print. */
const SECTION_LABELS = new Map([
  ['goal', 'Goal'],
  ['acceptance', 'Acceptance'],
  ['verify', 'Verify'],
  ['changes', 'Changes'],
  ['references', 'References'],
  ['spec', 'Spec'],
  ['context', 'Context'],
  ['slicing', 'Slicing'],
  ['non_goals', 'Non-Goals'],
]);

/**
 * Fixed-vocabulary problem line for a parse failure. `err.message` and
 * `err.raw` echo issue text, so they go to the run log, never the comment.
 */
function parseFailureProblem(err) {
  const label = SECTION_LABELS.get(err.field);
  return label
    ? `The \`## ${label}\` section could not be parsed into the canonical schema.`
    : 'An unrecognised section could not be parsed into the canonical schema.';
}

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
 * @property {string|null} parseError - Full parser message; run log only.
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
      parseError: null,
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
        problems: [parseFailureProblem(err)],
        warnings: [],
        parseFailed: true,
        parseError: err.message,
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
    parseError: null,
  };
}

/**
 * Built only from fixed strings and the fixed-vocabulary `problems`; warning
 * text echoes issue content, so only the count is shown.
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
      `The parser also raised ${verdict.warnings.length} non-blocking ` +
        'warning(s); see the workflow run log for the details.',
    );
  }
  return lines.join('\n');
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function gh(args) {
  const res = runGh(args, { encoding: 'utf8' });
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
 * The bot-authored marker comment to update, or `null`. A human-authored
 * marker is ignored so an issue author cannot hijack or suppress the lint.
 */
function findMarkerCommentId(ghFn, repoPath, issue) {
  const out = ghFn([
    'api',
    `repos/${repoPath}/issues/${issue}/comments`,
    '--paginate',
    '--jq',
    '.[] | {id, login: .user.login, body}',
  ]);
  const comments = out.split('\n').filter((line) => line.trim() !== '');
  return comments.map((line) => JSON.parse(line)).find(isBotMarker)?.id ?? null;
}

const isBotMarker = (c) =>
  c.body?.startsWith(LINT_COMMENT_MARKER) && c.login?.endsWith('[bot]');

function upsertArgs(id, issue, repo, comment) {
  if (id === null) {
    const repoArgs = repo ? ['--repo', repo] : [];
    return ['issue', 'comment', String(issue), ...repoArgs, '--body', comment];
  }
  const path = `repos/${repo ?? '{owner}/{repo}'}/issues/comments/${id}`;
  return ['api', '-X', 'PATCH', path, '-f', `body=${comment}`];
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
      warnings: verdict.warnings,
      parseError: verdict.parseError,
    })}\n`,
  );

  if (verdict.conformant || dryRun) {
    return {
      conformant: verdict.conformant,
      problems: verdict.problems,
    };
  }

  const id = findMarkerCommentId(ghFn, repo ?? '{owner}/{repo}', issue);
  ghFn(upsertArgs(id, issue, repo, renderConformanceComment(verdict)));
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
