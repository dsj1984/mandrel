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
import {
  getCiDelivery,
  getQuality,
  resolveConfig,
} from './lib/config-resolver.js';
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
  [--scope <scope>] [--paths <p1> <p2> ...] [--require-sibling-test]

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
  --require-sibling-test
             Refuse to commit when a staged-add source file under \`src/\` lacks
             a sibling \`<basename>.test.<ext>\` in the same commit. Default
             sourced from \`delivery.quality.codingGuardrails.requireSiblingTest\`.
             Story #1399 (Epic #1386).
  --skip-ci / --no-skip-ci
             Force / suppress the trailing \`[skip ci]\` marker on the commit
             subject. Default sourced from \`delivery.ci.skipForStoryPushes\`
             (which defaults to true). Story #2899 (Epic #2880, F13).
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
 * Story #2899 (Epic #2880, F13): when `skipCi: true`, appends a ` [skip ci]`
 * trailer to the subject so per-Task Story-branch commits do not stampede the
 * CI fleet. The Epic-branch merge commit produced by `story-close.js`'s
 * merge runner never carries the marker — that path is built by a separate
 * `buildMergeMessage` helper that does not call this function.
 *
 * @param {{ type: string, scope?: string, title: string, taskId: number, skipCi?: boolean }} input
 * @returns {string} canonical subject line
 */
export function buildCommitSubject({ type, scope, title, taskId, skipCi }) {
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
  const trailer = skipCi === true ? ' [skip ci]' : '';
  return `${type}${scopeChunk}: ${lowered} (resolves #${taskId})${trailer}`;
}

// File extensions the sibling-test guard treats as "source" — only modules
// that escomplex / CRAP would key on get the structural rule.
const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
]);

// Story #1399 (Epic #1386) — stripping the source extension off a basename so
// `<basename>.test.<ext>` can be matched without re-encoding the extension
// table. Returns null when the file is not a recognised source extension.
function basenameWithoutSourceExt(file) {
  const slashIdx = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  const base = slashIdx === -1 ? file : file.slice(slashIdx + 1);
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx <= 0) return null;
  const ext = base.slice(dotIdx);
  if (!SOURCE_EXTENSIONS.has(ext)) return null;
  return base.slice(0, dotIdx);
}

/**
 * Story #1399 (Epic #1386) — partition the `git diff --cached --name-status`
 * output into "new source files needing a sibling test" and "test files added
 * in the same commit". A staged add (`A` status) under `src/` whose extension
 * is recognised source AND whose basename does not already end in `.test`
 * counts as the source side; any staged add (or modify, `M`) whose basename
 * ends in `<sourceBase>.test.<ext>` counts as a sibling test for that
 * sourceBase. The check intentionally only looks at `src/` so production code
 * is the sole target — `.agents/scripts/` and `tests/` themselves are
 * exempt.
 *
 * Exported for unit tests so the policy is exercised without a real git
 * staging area.
 *
 * @param {string} stagedNameStatusStdout - raw stdout from `git diff --cached --name-status`
 * @returns {{ missing: string[], present: string[] }}
 */
export function partitionStagedForSiblingTest(stagedNameStatusStdout) {
  const lines = String(stagedNameStatusStdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const newSourceBases = []; // [{ file, base }]
  const stagedTestBases = new Set();

  for (const line of lines) {
    // `git diff --cached --name-status` emits `<status>\t<path>` (and
    // `<status>\t<old>\t<new>` for renames). We treat the rename target as
    // the staged path.
    const parts = line.split(/\t/);
    const status = parts[0];
    const file = parts[parts.length - 1];
    if (!file) continue;
    // Normalise to forward slashes so cross-platform paths compare cleanly.
    const norm = file.replace(/\\/g, '/');
    const base = basenameWithoutSourceExt(norm);
    if (!base) continue;
    // Sibling test detection — any staged file whose basename ends `.test`
    // (e.g. `foo.test.js`) is a sibling for `foo`.
    if (base.endsWith('.test')) {
      stagedTestBases.add(base.slice(0, -'.test'.length));
      continue;
    }
    // Only newly-added (`A`) production source under `src/` triggers the
    // requirement. Modifies / deletes are ignored — the rule is structural,
    // about brand-new modules, not every churned file.
    if (status === 'A' && norm.startsWith('src/')) {
      newSourceBases.push({ file: norm, base });
    }
  }

  const missing = [];
  const present = [];
  for (const { file, base } of newSourceBases) {
    if (stagedTestBases.has(base)) present.push(file);
    else missing.push(file);
  }
  return { missing, present };
}

/**
 * Story #1399 (Epic #1386) — resolve the effective `requireSiblingTest`
 * setting. Priority order: explicit boolean from the CLI flag (`true` /
 * `false`) wins; otherwise load `.agentrc.json` from `cwd` and read
 * `delivery.quality.codingGuardrails.requireSiblingTest` (which itself
 * defaults to `false` in the resolver). Exported for tests; tests pass a
 * `resolveConfigImpl` that returns a synthetic config wrapper so the gate
 * decision is exercised without touching disk.
 *
 * @param {{
 *   cliFlag?: boolean,
 *   cwd?: string,
 *   resolveConfigImpl?: typeof resolveConfig,
 *   getQualityImpl?: typeof getQuality,
 * }} args
 * @returns {boolean}
 */
export function resolveSiblingTestFlag(args = {}) {
  const {
    cliFlag,
    cwd,
    resolveConfigImpl = resolveConfig,
    getQualityImpl = getQuality,
  } = args;
  if (typeof cliFlag === 'boolean') return cliFlag;
  try {
    const config = resolveConfigImpl({ cwd });
    const quality = getQualityImpl(config);
    return Boolean(quality?.codingGuardrails?.requireSiblingTest);
  } catch {
    // If config resolution fails (no .agentrc.json, missing fields), fall
    // back to the framework default — the rule is opt-in and we never want
    // a config hiccup to start failing commits silently.
    return false;
  }
}

/**
 * Story #2899 (Epic #2880, F13) — resolve `delivery.ci.skipForStoryPushes`.
 * When `true`, `runTaskCommit` instructs `buildCommitSubject` to append a
 * `[skip ci]` trailer to the per-Task Story-branch commit subject so the
 * push-per-Task pattern does not stampede the CI fleet. The Epic-branch
 * merge commit (built separately in `story-close.js`) never carries the
 * marker.
 *
 * Priority order: explicit boolean from the CLI override wins; otherwise
 * load `.agentrc.json` from `cwd` and read `delivery.ci.skipForStoryPushes`
 * (default `true` via `getCiDelivery`).
 *
 * @param {{
 *   cliFlag?: boolean,
 *   cwd?: string,
 *   resolveConfigImpl?: typeof resolveConfig,
 *   getCiDeliveryImpl?: typeof getCiDelivery,
 * }} args
 * @returns {boolean}
 */
export function resolveSkipCiFlag(args = {}) {
  const {
    cliFlag,
    cwd,
    resolveConfigImpl = resolveConfig,
    getCiDeliveryImpl = getCiDelivery,
  } = args;
  if (typeof cliFlag === 'boolean') return cliFlag;
  try {
    const config = resolveConfigImpl({ cwd });
    const ci = getCiDeliveryImpl(config);
    return Boolean(ci?.skipForStoryPushes);
  } catch {
    // Match the conservative fallback shape from resolveSiblingTestFlag:
    // when `.agentrc.json` cannot be read, do NOT append the marker. The
    // worst case is one extra CI run, not a corrupted commit subject.
    return false;
  }
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
 *   requireSiblingTest?: boolean,
 *   skipCi?: boolean,
 *   gitSpawnImpl?: typeof gitSpawn,
 *   gitSyncImpl?: typeof gitSync,
 *   assertBranchImpl?: typeof assertBranch,
 *   getQualityImpl?: typeof getQuality,
 *   getCiDeliveryImpl?: typeof getCiDelivery,
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
    requireSiblingTest,
    skipCi,
    gitSpawnImpl = gitSpawn,
    gitSyncImpl = gitSync,
    assertBranchImpl = assertBranch,
    resolveConfigImpl = resolveConfig,
    getQualityImpl = getQuality,
    getCiDeliveryImpl = getCiDelivery,
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

  // 2.5. Sibling-test guard (Story #1399). When the flag is on (CLI override
  //      or `delivery.quality.codingGuardrails.requireSiblingTest`), any
  //      newly-added `src/**/*.<source-ext>` must come with a same-commit
  //      sibling `<basename>.test.<ext>`. The check fires after staging so
  //      the user-supplied --paths set has already taken effect.
  const siblingFlagOn = resolveSiblingTestFlag({
    cliFlag: requireSiblingTest,
    cwd,
    resolveConfigImpl,
    getQualityImpl,
  });
  if (siblingFlagOn) {
    const staged = gitSpawnImpl(cwd, 'diff', '--cached', '--name-status');
    if (staged.status !== 0) {
      throw new Error(
        `[task-commit] git diff --cached --name-status failed: ${staged.stderr}`,
      );
    }
    const { missing } = partitionStagedForSiblingTest(staged.stdout);
    if (missing.length) {
      throw new Error(
        `[task-commit] requireSiblingTest: new source file(s) lack a sibling test in this commit:\n  ${missing.join(
          '\n  ',
        )}\nAdd a sibling \`<basename>.test.<ext>\` next to the source file (or pass --no-require-sibling-test to opt out — but see helpers/code-quality-guardrails.md).`,
      );
    }
  }

  // 3. Build the subject + 4. commit (hooks run — never --no-verify).
  //    Story #2899 (Epic #2880, F13): when delivery.ci.skipForStoryPushes
  //    is on (default true), the subject carries a `[skip ci]` trailer so
  //    per-Task pushes do not stampede the CI fleet. The Epic-branch merge
  //    commit produced by story-close.js's merge runner uses a separate
  //    buildMergeMessage helper that never adds the marker.
  const skipCiFlag = resolveSkipCiFlag({
    cliFlag: skipCi,
    cwd,
    resolveConfigImpl,
    getCiDeliveryImpl,
  });
  const subject = buildCommitSubject({
    type,
    scope,
    title,
    taskId,
    skipCi: skipCiFlag,
  });
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
export function parseArgv(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      story: { type: 'string' },
      task: { type: 'string' },
      type: { type: 'string' },
      title: { type: 'string' },
      scope: { type: 'string' },
      paths: { type: 'string', multiple: true },
      'require-sibling-test': { type: 'boolean' },
      'no-require-sibling-test': { type: 'boolean' },
      'skip-ci': { type: 'boolean' },
      'no-skip-ci': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: false,
  });
  // node:util parseArgs only treats `--paths` flag instances as repeats; allow
  // a trailing positional list too so `--paths a b c` works as documented.
  const paths = [...(values.paths ?? []), ...(positionals ?? [])];
  // Story #1399 — explicit overrides win over config; passing neither leaves
  // the resolver to consult `quality.codingGuardrails.requireSiblingTest`.
  let requireSiblingTest;
  if (values['no-require-sibling-test']) requireSiblingTest = false;
  else if (values['require-sibling-test']) requireSiblingTest = true;
  // Story #2899 (Epic #2880, F13) — same override semantics for the
  // skip-ci trailer: explicit booleans win over `.agentrc.json`.
  let skipCi;
  if (values['no-skip-ci']) skipCi = false;
  else if (values['skip-ci']) skipCi = true;
  return {
    help: Boolean(values.help),
    storyId: Number.parseInt(values.story ?? '', 10),
    taskId: Number.parseInt(values.task ?? '', 10),
    type: values.type,
    title: values.title,
    scope: values.scope,
    skipCi,
    paths,
    requireSiblingTest,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgv(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }
  const result = runTaskCommit(parsed);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

runAsCli(import.meta.url, main, { source: 'task-commit' });
