import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { isDegraded, softFailOrThrow } from './lib/degraded-mode.js';
import { gitSpawn, gitSync } from './lib/git-utils.js';

/**
 * CLI: base-branch-enforced anti-gaming guardrail for the maintainability /
 * CRAP baselines. Runs on `pull_request` events.
 *
 * Responsibilities (see Tech Spec #598, Epic #596):
 *   1. Read the **base branch** `.agentrc.json` via `git show origin/<base>:…`
 *      and extract `newMethodCeiling`, `tolerance`, `refreshTag` from
 *      `agentSettings.quality.crap`.
 *   2. Re-run `check-crap` with those base-branch values forced via
 *      `CRAP_NEW_METHOD_CEILING` / `CRAP_TOLERANCE` / `CRAP_REFRESH_TAG`
 *      environment variables. This catches a PR that simultaneously relaxes
 *      the ceiling AND adds a method over the base-branch ceiling.
 *   3. If the PR diff modifies any canonical baseline file under
 *      `baselines/` (lint.json, crap.json, maintainability.json), require at
 *      least one commit in
 *      `git log origin/<base>..HEAD` whose subject starts with the
 *      base-branch `refreshTag` AND has a non-empty body. Fail closed with a
 *      message naming the required tag otherwise.
 *   4. If the PR diff **only** modifies baseline files, apply the
 *      `review::baseline-refresh` label to the PR. Idempotent across re-runs.
 *
 * The script exits non-zero on any guardrail failure; the caller (CI) maps
 * that to a failing check.
 *
 * Design split: pure helpers (exported) encode the decisions so tests can
 * drive them from fixtures without shelling out to git or gh. The `main()`
 * wrapper is the only I/O layer.
 */

/** Canonical baseline artifacts the guardrail watches for. Locations match
 * Epic #730 Story 5.5 (baselines unified under `/baselines/`). */
const BASELINE_FILES = Object.freeze([
  'baselines/lint.json',
  'baselines/crap.json',
  'baselines/maintainability.json',
]);

export const BASELINE_REFRESH_LABEL = 'review::baseline-refresh';
const BASELINE_REFRESH_LABEL_COLOR = 'fbca04';
const BASELINE_REFRESH_LABEL_DESCRIPTION =
  'PR refreshes a committed maintainability or CRAP baseline — requires human review.';

const DEFAULT_REFRESH_TAG = 'baseline-refresh:';
const COMMIT_DELIMITER = '----END-COMMIT----';

export function parseCliArgs(argv = process.argv.slice(2)) {
  const out = {
    baseRef: 'origin/main',
    prNumber: null,
    cwd: process.cwd(),
    skipLabel: false,
    skipCheckCrap: false,
    gateMode: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--base-ref' && next) {
      out.baseRef = next;
      i += 1;
    } else if (arg === '--pr-number' && next) {
      const parsed = Number(next);
      if (Number.isInteger(parsed) && parsed > 0) out.prNumber = parsed;
      i += 1;
    } else if (arg === '--cwd' && next) {
      out.cwd = next;
      i += 1;
    } else if (arg === '--skip-label') {
      out.skipLabel = true;
    } else if (arg === '--skip-check-crap') {
      out.skipCheckCrap = true;
    } else if (arg === '--gate-mode') {
      out.gateMode = true;
    }
  }
  return out;
}

/**
 * Pure: parse the raw `.agentrc.json` text fetched from the base branch and
 * extract the guardrail-relevant CRAP config. Missing or malformed config
 * falls back to documented defaults so the guardrail can still run in a
 * consumer repo that has only recently adopted the `crap` config block.
 *
 * @param {string} rawJson
 * @returns {{
 *   newMethodCeiling: number,
 *   tolerance: number,
 *   refreshTag: string,
 *   enabled: boolean,
 * }}
 */
export function parseBaseBranchConfig(rawJson) {
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return {
      newMethodCeiling: 30,
      tolerance: 0.05,
      refreshTag: DEFAULT_REFRESH_TAG,
      enabled: true,
    };
  }
  const crap = parsed?.agentSettings?.quality?.crap ?? {};
  return {
    newMethodCeiling: Number.isFinite(crap.newMethodCeiling)
      ? crap.newMethodCeiling
      : 30,
    tolerance: Number.isFinite(crap.tolerance) ? crap.tolerance : 0.05,
    refreshTag:
      typeof crap.refreshTag === 'string' && crap.refreshTag.length
        ? crap.refreshTag
        : DEFAULT_REFRESH_TAG,
    enabled: crap.enabled !== false,
  };
}

/**
 * Pure: classify the PR's changed files into baseline vs. non-baseline.
 *
 * @param {string[]} changedFiles repo-relative, forward-slashed paths
 * @param {readonly string[]} [baselineFiles=BASELINE_FILES]
 */
export function classifyChangedFiles(
  changedFiles,
  baselineFiles = BASELINE_FILES,
) {
  const baselineSet = new Set(baselineFiles);
  const changedBaselineFiles = [];
  const changedOther = [];
  for (const f of changedFiles ?? []) {
    if (baselineSet.has(f)) changedBaselineFiles.push(f);
    else changedOther.push(f);
  }
  return {
    changedBaselineFiles,
    changedOther,
    hasBaselineEdits: changedBaselineFiles.length > 0,
    baselineOnly: changedBaselineFiles.length > 0 && changedOther.length === 0,
  };
}

/**
 * Pure: parse `git log --format=%H%n%s%n%b<delim>` output into structured
 * commit records.
 *
 * @param {string} raw
 */
export function parseCommitLog(raw) {
  if (!raw?.trim()) return [];
  return raw
    .split(COMMIT_DELIMITER)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const sha = (lines[0] ?? '').trim();
      const subject = (lines[1] ?? '').trim();
      const body = lines.slice(2).join('\n').trim();
      return { sha, subject, body };
    })
    .filter((c) => c.sha && c.subject);
}

/**
 * Pure: among the provided commits, find those whose subject starts with
 * `refreshTag` AND whose body is non-empty. Both conditions are required by
 * Tech Spec AC26 — the tag alone without justification is not enough.
 *
 * @param {Array<{subject: string, body: string}>} commits
 * @param {string} refreshTag
 */
export function findRefreshCommits(commits, refreshTag) {
  if (!Array.isArray(commits) || !refreshTag) return [];
  return commits.filter(
    (c) => c.subject.startsWith(refreshTag) && c.body.trim().length > 0,
  );
}

/**
 * Pure decision: given the PR diff + commit log + base-branch config, decide
 * whether the guardrail passes and which side-effects should be applied.
 *
 * @param {{
 *   changedFiles: string[],
 *   commits: Array<{subject: string, body: string}>,
 *   refreshTag: string,
 *   baselineFiles?: readonly string[],
 * }} params
 * @returns {{
 *   ok: boolean,
 *   exitCode: 0|1,
 *   messages: string[],
 *   shouldApplyBaselineLabel: boolean,
 *   classification: ReturnType<typeof classifyChangedFiles>,
 *   refreshCommits: Array<{subject: string, body: string}>,
 * }}
 */
export function evaluateGuardrail({
  changedFiles,
  commits,
  refreshTag,
  baselineFiles = BASELINE_FILES,
}) {
  const classification = classifyChangedFiles(changedFiles, baselineFiles);
  const refreshCommits = findRefreshCommits(commits, refreshTag);
  const messages = [];

  if (!classification.hasBaselineEdits) {
    messages.push(
      '[guardrail] ✅ no baseline files modified — refresh-tag check skipped.',
    );
    return {
      ok: true,
      exitCode: 0,
      messages,
      shouldApplyBaselineLabel: false,
      classification,
      refreshCommits,
    };
  }

  if (refreshCommits.length === 0) {
    messages.push(
      `[guardrail] ❌ baseline file(s) modified without a \`${refreshTag}\` commit:`,
      ...classification.changedBaselineFiles.map((f) => `    - ${f}`),
      '',
      `[guardrail] Required: at least one commit whose subject starts with \`${refreshTag}\``,
      '[guardrail] AND has a non-empty body explaining why the baseline was refreshed.',
      '[guardrail] Rewrite the baseline-refresh commit to satisfy both conditions,',
      '[guardrail] or back the baseline change out of this PR.',
    );
    return {
      ok: false,
      exitCode: 1,
      messages,
      shouldApplyBaselineLabel: classification.baselineOnly,
      classification,
      refreshCommits,
    };
  }

  messages.push(
    `[guardrail] ✅ baseline refresh justified by ${refreshCommits.length} commit(s) tagged \`${refreshTag}\`.`,
  );
  return {
    ok: true,
    exitCode: 0,
    messages,
    shouldApplyBaselineLabel: classification.baselineOnly,
    classification,
    refreshCommits,
  };
}

/**
 * I/O: fetch the raw `.agentrc.json` text from `<baseRef>`.
 * Throws if the ref or file is missing so CI surfaces the setup error.
 */
function readBaseBranchConfigRaw(baseRef, cwd) {
  return gitSync(cwd, 'show', `${baseRef}:.agentrc.json`);
}

/**
 * I/O: list files changed between `<baseRef>` and HEAD as repo-relative,
 * forward-slashed paths.
 *
 * Soft-fail contract (Tech Spec #819): on a non-zero git exit, return a
 * degraded envelope so the caller can surface the explicit signal instead of
 * silently treating an empty diff as "no baseline edits". In gate-mode
 * (`--gate-mode` / `AGENT_PROTOCOLS_GATE_MODE=1`), throws instead.
 *
 * @returns {string[] | { ok: false, degraded: true, reason: string, detail: string }}
 */
export function listChangedFiles(baseRef, cwd, gateModeOpts) {
  const out = gitSpawn(cwd, 'diff', '--name-only', `${baseRef}...HEAD`);
  if (out.status !== 0) {
    return softFailOrThrow(
      'GIT_DIFF_FAILED',
      `baseline-refresh-guardrail: git diff against ${baseRef} failed: ${out.stderr?.trim() ?? 'no stderr'}`,
      gateModeOpts,
    );
  }
  return out.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/\\/g, '/'));
}

/**
 * I/O: fetch the PR commit log as structured `{sha, subject, body}` records.
 */
function listCommitsSinceBase(baseRef, cwd) {
  const format = `%H%n%s%n%b%n${COMMIT_DELIMITER}`;
  const out = gitSpawn(cwd, 'log', `${baseRef}..HEAD`, `--format=${format}`);
  if (out.status !== 0) {
    console.warn(
      `[guardrail] ⚠ git log against ${baseRef} failed: ${out.stderr?.trim() ?? 'no stderr'}`,
    );
    return [];
  }
  return parseCommitLog(out.stdout);
}

/**
 * I/O: apply the `review::baseline-refresh` label to a PR, creating the label
 * first if it doesn't already exist. Idempotent — GitHub treats
 * `gh pr edit --add-label` as a set-union on the PR's labels, so repeated
 * CI runs never duplicate. Best-effort: failures are warned but do not fail
 * the guardrail (the tag-check is the authoritative gate; the label is a
 * reviewer hint).
 */
export function applyBaselineRefreshLabel({ prNumber, cwd, runner = runGh }) {
  if (!prNumber) {
    console.warn(
      '[guardrail] ⚠ --pr-number not supplied; skipping label application.',
    );
    return { applied: false, reason: 'no-pr-number' };
  }
  // Create label if missing (gh label create --force would also work but is
  // destructive of existing description/color). Swallow existence errors.
  const createRes = runner(cwd, [
    'label',
    'create',
    BASELINE_REFRESH_LABEL,
    '--color',
    BASELINE_REFRESH_LABEL_COLOR,
    '--description',
    BASELINE_REFRESH_LABEL_DESCRIPTION,
  ]);
  if (createRes.status !== 0) {
    const stderr = createRes.stderr?.toLowerCase() ?? '';
    const benign =
      stderr.includes('already exists') ||
      stderr.includes('name-exists') ||
      stderr.includes('code:already_exists');
    if (!benign) {
      console.warn(
        `[guardrail] ⚠ gh label create failed (continuing): ${createRes.stderr?.trim()}`,
      );
    }
  }
  const editRes = runner(cwd, [
    'pr',
    'edit',
    String(prNumber),
    '--add-label',
    BASELINE_REFRESH_LABEL,
  ]);
  if (editRes.status !== 0) {
    console.warn(
      `[guardrail] ⚠ gh pr edit --add-label failed: ${editRes.stderr?.trim()}`,
    );
    return { applied: false, reason: 'gh-error' };
  }
  console.log(
    `[guardrail] 🏷  applied \`${BASELINE_REFRESH_LABEL}\` to PR #${prNumber}.`,
  );
  return { applied: true };
}

function runGh(cwd, args) {
  return spawnSync('gh', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
}

/**
 * I/O: spawn `check-crap.js` with the base-branch config forced via env vars.
 * Returns the child's exit status. A non-zero status from check-crap is the
 * guardrail's "PR is over the base-branch ceiling" signal and propagates out.
 */
export function runCheckCrapWithBaseConfig({
  cwd,
  baseConfig,
  baseRef,
  runner = spawnSyncWrapper,
}) {
  const script = path.join('.agents', 'scripts', 'check-crap.js');
  const env = {
    ...process.env,
    CRAP_NEW_METHOD_CEILING: String(baseConfig.newMethodCeiling),
    CRAP_TOLERANCE: String(baseConfig.tolerance),
    CRAP_REFRESH_TAG: baseConfig.refreshTag,
  };
  const res = runner('node', [script, '--changed-since', baseRef], {
    cwd,
    env,
    stdio: 'inherit',
  });
  return res.status ?? 1;
}

function spawnSyncWrapper(cmd, args, opts) {
  return spawnSync(cmd, args, opts);
}

/**
 * Pure: emit each verdict message via the appropriate console channel.
 * Pulled out of `main` so the orchestrator stays under the CRAP cyc cap and
 * the routing rule can be unit-tested without a console hijack inside main.
 *
 * @param {{ ok: boolean, messages: string[] }} verdict
 * @param {{ log?: (m: string) => void, error?: (m: string) => void }} [io]
 */
export function emitVerdictMessages(verdict, io = console) {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const sink = verdict.ok ? log : error;
  for (const m of verdict.messages) sink(m);
}

/**
 * Pure decision wrapper: apply the baseline-refresh label when the verdict
 * recommends it AND the operator hasn't opted out via `--skip-label`. The
 * actual labelling I/O is delegated to the injected `apply` runner so this
 * helper stays pure for tests; main() supplies `applyBaselineRefreshLabel`.
 *
 * @param {{ verdict: { shouldApplyBaselineLabel: boolean }, args: { skipLabel: boolean, prNumber: number|null, cwd: string }, apply: typeof applyBaselineRefreshLabel }} params
 * @returns {{ skipped: true, reason: string } | ReturnType<typeof applyBaselineRefreshLabel>}
 */
export function applyLabelIfNeeded({ verdict, args, apply }) {
  if (!verdict.shouldApplyBaselineLabel) {
    return { skipped: true, reason: 'verdict-says-no' };
  }
  if (args.skipLabel) return { skipped: true, reason: 'skip-label-flag' };
  return apply({ prNumber: args.prNumber, cwd: args.cwd });
}

/**
 * Run the check-crap re-execution step or honour `--skip-check-crap`. Pulled
 * out of `main` so the orchestrator stays under the CRAP cyc cap and the
 * skip-vs-run decision can be unit-tested.
 *
 * @param {{ args: { skipCheckCrap: boolean, baseRef: string, cwd: string }, baseConfig: { newMethodCeiling: number, tolerance: number, refreshTag: string }, run?: typeof runCheckCrapWithBaseConfig, log?: (m: string) => void, error?: (m: string) => void }} params
 * @returns {{ ok: boolean, exitCode: number }}
 */
export function performCrapRecheck({
  args,
  baseConfig,
  run = runCheckCrapWithBaseConfig,
  log = console.log,
  error = console.error,
}) {
  if (args.skipCheckCrap) {
    log('[guardrail] --skip-check-crap set; skipping base-enforced re-run.');
    return { ok: true, exitCode: 0 };
  }
  log(
    '[guardrail] re-running check-crap with base-branch values forced via env...',
  );
  const crapExit = run({
    cwd: args.cwd,
    baseConfig,
    baseRef: args.baseRef,
  });
  if (crapExit !== 0) {
    error(
      `[guardrail] ❌ check-crap failed under base-branch thresholds (exit ${crapExit}).`,
    );
    return { ok: false, exitCode: crapExit };
  }
  log('[guardrail] ✅ all guardrail checks passed.');
  return { ok: true, exitCode: 0 };
}

async function main() {
  const args = parseCliArgs();
  console.log(
    `[guardrail] base-ref=${args.baseRef} pr=${args.prNumber ?? '(unknown)'} cwd=${args.cwd}`,
  );

  let baseConfig;
  try {
    const raw = readBaseBranchConfigRaw(args.baseRef, args.cwd);
    baseConfig = parseBaseBranchConfig(raw);
  } catch (err) {
    console.error(
      `[guardrail] ❌ failed to read .agentrc.json from ${args.baseRef}: ${err?.message ?? err}`,
    );
    return 1;
  }
  console.log(
    `[guardrail] base config: newMethodCeiling=${baseConfig.newMethodCeiling} tolerance=${baseConfig.tolerance} refreshTag=${baseConfig.refreshTag} enabled=${baseConfig.enabled}`,
  );

  if (!baseConfig.enabled) {
    console.log(
      '[guardrail] base branch has crap.enabled=false — skipping guardrail.',
    );
    return 0;
  }

  const gateModeOpts = {
    argv: args.gateMode ? ['--gate-mode'] : [],
    env: process.env,
  };
  const changedFilesResult = listChangedFiles(
    args.baseRef,
    args.cwd,
    gateModeOpts,
  );
  if (isDegraded(changedFilesResult)) {
    process.stdout.write(`${JSON.stringify(changedFilesResult)}\n`);
    console.error(
      `[guardrail] ❌ ${changedFilesResult.reason}: ${changedFilesResult.detail}`,
    );
    return 1;
  }
  const changedFiles = changedFilesResult;
  const commits = listCommitsSinceBase(args.baseRef, args.cwd);
  console.log(
    `[guardrail] diff: ${changedFiles.length} file(s); commits: ${commits.length}`,
  );

  const verdict = evaluateGuardrail({
    changedFiles,
    commits,
    refreshTag: baseConfig.refreshTag,
  });
  emitVerdictMessages(verdict);

  applyLabelIfNeeded({ verdict, args, apply: applyBaselineRefreshLabel });

  if (!verdict.ok) return verdict.exitCode;

  return performCrapRecheck({ args, baseConfig }).exitCode;
}

// cli-opt-out: needs a Windows-aware main-guard (path.resolve + drive-letter normalisation) and a custom main.then(code => process.exit(code)) result-code path that runAsCli does not provide.
const isDirect = (() => {
  try {
    const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const self = new URL(import.meta.url).pathname;
    const normalizedSelf = /^\/[A-Za-z]:/.test(self) ? self.slice(1) : self;
    return path.resolve(normalizedSelf) === invoked;
  } catch {
    return false;
  }
})();

if (isDirect) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error(
        `[guardrail] ❌ Fatal error: ${err?.stack ?? err?.message ?? err}`,
      );
      process.exit(1);
    });
}
