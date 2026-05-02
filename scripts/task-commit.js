#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * task-commit.js — assert-branch + stage + conventional-commit + post-commit branch verify.
 *
 * The Story-execute Task loop previously composed `git add`, `git commit`, and
 * `assert-branch` as three separate inline shell calls in the workflow markdown.
 * That left every Story sub-agent re-implementing the same scope-discipline
 * + branch-guard + commit-subject template, and made it possible to drift away
 * from the canonical `<type>(<scope>): <title> (resolves #<taskId>)` shape.
 *
 * This CLI consolidates the sequence into a single non-bypassable command:
 *
 *   1. `assertBranch(\`story-<storyId>\`, { cwd: process.cwd() })` — fail loudly
 *      if the working directory's HEAD has drifted off the Story branch.
 *   2. Stage with `git add <paths>` (default `git add -u` when no paths given).
 *   3. Build the canonical subject:
 *      `<type>(<scope>): <title-lowercased> (resolves #<taskId>)`
 *      (the scope chunk is omitted when `--scope` is absent).
 *   4. `git commit -m <subject>` — hooks **must** run; we never pass
 *      `--no-verify`. The commit hooks are the same gates the close-validation
 *      chain replays at merge time, so bypassing them just defers failure.
 *   5. Re-assert the branch + capture `git rev-parse HEAD` for the new SHA.
 *   6. Print `{ sha, branch, subject }` JSON on stdout.
 *
 * Exit codes:
 *   0 — commit landed; envelope on stdout.
 *   1 — branch mismatch, staging failure, commit failure, or post-commit
 *       branch drift. Caller should treat as fatal and **not** retry blindly.
 */

import { parseArgs } from 'node:util';

import { assertBranch } from './assert-branch.js';
import { runAsCli } from './lib/cli-utils.js';
import { gitSpawn, gitSync } from './lib/git-utils.js';

const VALID_TYPES = new Set([
  'feat',
  'fix',
  'refactor',
  'docs',
  'test',
  'chore',
  'perf',
  'build',
  'ci',
  'style',
  'revert',
]);

const HELP = `Usage: node .agents/scripts/task-commit.js \\
  --story <id> --task <id> --type <type> --title "<title>" \\
  [--scope <scope>] [--paths <p1> <p2> ...]

Flags:
  --story    Story ID — used to derive the expected branch (\`story-<id>\`).
  --task     Task ID — appended to the commit trailer as (resolves #<id>).
  --type     Conventional-commit type (feat|fix|refactor|docs|test|chore|perf|
             build|ci|style|revert).
  --title    Free-text title; lower-cased to form the commit subject body.
  --scope    Optional symbolic scope (module/area). Omitted from the subject
             when blank.
  --paths    Optional explicit paths to stage. When omitted, falls back to
             \`git add -u\` (modified-tracked-files only).
  --help     Show this message.

Output: JSON { sha: <7-char>, branch, subject } on stdout.

Hooks: this script never passes \`--no-verify\`. Commit hooks are intentional
defense-in-depth and must run.
`;

/**
 * Build the conventional-commit subject. Pure helper — exported for tests.
 *
 * Lowercases the title (matching the workflow rule in
 * helpers/task-execute.md Step 5) and stitches the optional scope chunk plus
 * the mandatory `(resolves #<taskId>)` trailer.
 *
 * @param {{ type: string, scope?: string, title: string, taskId: number }} input
 * @returns {string} canonical subject line
 */
export function buildCommitSubject({ type, scope, title, taskId }) {
  if (!type || typeof type !== 'string') {
    throw new TypeError('buildCommitSubject: --type is required');
  }
  if (!VALID_TYPES.has(type)) {
    throw new RangeError(
      `buildCommitSubject: unsupported type "${type}"; expected one of: ${[...VALID_TYPES].join(', ')}`,
    );
  }
  if (!title || typeof title !== 'string' || !title.trim()) {
    throw new TypeError('buildCommitSubject: --title is required');
  }
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new TypeError(
      'buildCommitSubject: --task must be a positive integer',
    );
  }
  const scopeChunk =
    scope && String(scope).trim() ? `(${String(scope).trim()})` : '';
  const lowered = title.trim().toLowerCase();
  return `${type}${scopeChunk}: ${lowered} (resolves #${taskId})`;
}

/**
 * Stage + commit + verify. Dependency-injection-friendly so tests can swap the
 * git runner and the branch-asserter.
 *
 * @param {{
 *   storyId: number,
 *   taskId: number,
 *   type: string,
 *   title: string,
 *   scope?: string,
 *   paths?: string[],
 *   cwd?: string,
 *   gitSpawnImpl?: typeof gitSpawn,
 *   gitSyncImpl?: typeof gitSync,
 *   assertBranchImpl?: typeof assertBranch,
 * }} args
 * @returns {{ sha: string, branch: string, subject: string }}
 */
export function runTaskCommit(args) {
  const {
    storyId,
    taskId,
    type,
    title,
    scope,
    paths = [],
    cwd = process.cwd(),
    gitSpawnImpl = gitSpawn,
    gitSyncImpl = gitSync,
    assertBranchImpl = assertBranch,
  } = args ?? {};

  if (!Number.isInteger(storyId) || storyId <= 0) {
    throw new TypeError('runTaskCommit: --story must be a positive integer');
  }
  const expectedBranch = `story-${storyId}`;

  // 1. Pre-commit branch guard.
  const pre = assertBranchImpl(expectedBranch, { cwd });
  if (!pre.ok) {
    throw new Error(`[task-commit] pre-commit assert-branch: ${pre.reason}`);
  }

  // 2. Stage. Explicit paths preferred per helpers/task-execute.md Step 3;
  //    fall back to `git add -u` so we never silently sweep new untracked
  //    artifacts (lockfiles, scratch files) into the Task commit.
  const stageArgs =
    Array.isArray(paths) && paths.length ? ['add', ...paths] : ['add', '-u'];
  const stage = gitSpawnImpl(cwd, ...stageArgs);
  if (stage.status !== 0) {
    throw new Error(
      `[task-commit] git ${stageArgs.join(' ')} failed: ${stage.stderr}`,
    );
  }

  // 3. Build the subject + 4. commit (hooks run — never --no-verify).
  const subject = buildCommitSubject({ type, scope, title, taskId });
  const commit = gitSpawnImpl(cwd, 'commit', '-m', subject);
  if (commit.status !== 0) {
    throw new Error(
      `[task-commit] git commit failed: ${commit.stderr || commit.stdout}`,
    );
  }

  // 5. Re-assert + capture SHA. A mid-commit hook could in principle move HEAD
  //    via amend; defense-in-depth.
  const post = assertBranchImpl(expectedBranch, { cwd });
  if (!post.ok) {
    throw new Error(
      `[task-commit] post-commit assert-branch drifted: ${post.reason}`,
    );
  }
  const fullSha = gitSyncImpl(cwd, 'rev-parse', 'HEAD');
  const sha = String(fullSha).slice(0, 7);

  return { sha, branch: expectedBranch, subject };
}

/**
 * Parse argv into the `runTaskCommit` input shape.
 *
 * @param {string[]} argv
 * @returns {{
 *   help: boolean,
 *   storyId: number,
 *   taskId: number,
 *   type: string,
 *   title: string,
 *   scope?: string,
 *   paths: string[],
 * }}
 */
export function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      story: { type: 'string' },
      task: { type: 'string' },
      type: { type: 'string' },
      title: { type: 'string' },
      scope: { type: 'string' },
      paths: { type: 'string', multiple: true },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: false,
  });
  // node:util parseArgs only treats `--paths` flag instances as repeats; allow
  // a trailing positional list too so `--paths a b c` works as documented.
  const paths = [...(values.paths ?? []), ...(positionals ?? [])];
  return {
    help: Boolean(values.help),
    storyId: Number.parseInt(values.story ?? '', 10),
    taskId: Number.parseInt(values.task ?? '', 10),
    type: values.type,
    title: values.title,
    scope: values.scope,
    paths,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }
  const result = runTaskCommit(parsed);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

runAsCli(import.meta.url, main, { source: 'task-commit' });
