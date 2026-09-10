/**
 * review-providers/scoped-lint.js — the scoped-lint surface of the native
 * review provider (extracted from `native.js` by Story #4839).
 *
 * ## Why this module exists
 *
 * The scoped-lint gate reported `executionFailed` — and therefore emitted zero
 * findings while the review reported clean — on 18 of 23 Beestera/swarm-os
 * Stories carrying friction (78%) and on 5 mandrel Stories. Measured
 * 2026-07-29, the cause was **not** environmental and **not** a parse failure.
 * Three defects in how the runners were invoked and reconciled produced the
 * same symptom:
 *
 * 1. **The markdown runner was never resolvable.** The provider spawned
 *    `npx --no markdownlint`, but the binary this project (and the consumer)
 *    installs is `markdownlint-cli2` — `markdownlint-cli2` is the package and
 *    the bin name; a bare `markdownlint` bin does not exist. `npx --no` with an
 *    unresolvable bin exits 1 printing `could not determine executable to run`
 *    and nothing else, so the summary parsed nothing and the gate degraded.
 *    The parser was already written for **cli2's** `Summary: N error(s)` line,
 *    so the invocation and the parser had never agreed. The `--ignore
 *    node_modules` flag was likewise `markdownlint-cli` (v1) syntax, which
 *    cli2 does not accept. Fix: resolve the runner from what is actually
 *    installed and pass each candidate its own argument shape.
 *
 * 2. **One runner's failure poisoned the other's verdict.** The two runs were
 *    folded into a *single* `parseLintOutput` call over concatenated output and
 *    the maximum exit status. So the unresolvable markdown runner's exit 1
 *    became the verdict for biome too: any change set containing at least one
 *    `.md` file degraded the whole gate whenever biome itself had nothing to
 *    report — i.e. exactly the clean case the gate exists to confirm. Fix:
 *    classify each surface independently and merge structurally.
 *
 * 3. **Biome's "nothing in scope" exit was read as a failure.** `biome lint`
 *    exits 1 with `No files were processed in the specified paths.` when every
 *    supplied path is excluded by `biome.json` (`temp/`, `dist/`,
 *    `.worktrees/`, anything in the VCS ignore file). That is an empty scope,
 *    not a runner that could not execute. Fix: recognise the sentinel.
 *
 * ## What a degraded surface now produces
 *
 * `runScopedLint` still reports `executionFailed` — the friction-telemetry
 * emission in `native.js` is deliberately unchanged (Story #4699 routed an
 * unexecutable tool to telemetry so severity tiers reflect code findings only,
 * and that intent stands). It additionally reports a `degradations[]` array
 * naming **which** surface could not run and **why**, so the review outcome can
 * say "this gate did not run" instead of silently reading clean.
 *
 * ## The code surface never got the same treatment (Story #5193)
 *
 * Story #4839 gave the *markdown* surface a disk probe and left the code
 * surface spawning `npx --no biome` and classifying the exit code. On npm 11.x
 * that spawn exits **0 with empty output** when biome is absent, so
 * `parseLintOutput` saw no failure, produced no degradation, and the surface
 * contributed `errors: 0, warnings: 0` — a *silent false clean*, which is
 * strictly worse than a degradation: a degraded surface announces itself, a
 * falsely-clean one is trusted. Since nothing in the framework requires either
 * runner, "absent" is the default state of a consumer checkout.
 *
 * Fix: runner resolution is a **precondition** for every surface, not an
 * outcome inferred from an exit code. Both surfaces now resolve through
 * {@link resolveRunner}, and an unresolved runner is never spawned.
 *
 * The same measurement invalidated the `NPX_UNRESOLVABLE` sentinel: current npm
 * answers an unresolvable bin with `npm error code E404`, not `could not
 * determine executable to run`, so every genuinely-unresolvable runner was
 * being labelled `unparseable-output`. The sentinel now recognises both shapes.
 * It still earns its keep after the disk probe: the probe only sees
 * `node_modules/.bin`, so a runner resolvable some other way can still fail.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Paths these extensions land on the biome (code) runner. */
const CODE_EXTENSIONS = /\.(js|mjs|cjs|jsx|ts|tsx|json|jsonc)$/i;

/**
 * npx's output when the requested bin cannot be resolved. Two shapes: the
 * legacy message, and the `E404` current npm answers with instead (measured
 * 2026-09-07 on npm 11.13.0). Matching the E404 *code* rather than any
 * `npm error` line keeps a genuine runner error out of this classification.
 */
const NPX_UNRESOLVABLE =
  /could not determine executable to run|npm (?:error|ERR!)\s+code\s+E404/i;

/** Biome's exit-1 message when every supplied path is config-excluded. */
const BIOME_EMPTY_SCOPE = /No files were processed in the specified paths/i;

/**
 * Markdown runners in preference order, each with the argument shape *it*
 * accepts. `markdownlint-cli2` takes bare paths/globs and rejects `--ignore`;
 * `markdownlint` (cli v1) takes `--ignore`. Explicit changed-file paths are
 * passed either way, so the v1 ignore flag is belt-and-braces only.
 */
const MARKDOWN_RUNNERS = Object.freeze([
  Object.freeze({ bin: 'markdownlint-cli2', extraArgs: Object.freeze([]) }),
  Object.freeze({
    bin: 'markdownlint',
    extraArgs: Object.freeze(['--ignore', 'node_modules']),
  }),
]);

/**
 * Code runners in preference order. `@biomejs/biome` installs a bare `biome`
 * bin, which is also the canonical name this surface reports itself under when
 * nothing resolves.
 */
const CODE_RUNNERS = Object.freeze([
  Object.freeze({ bin: 'biome', extraArgs: Object.freeze([]) }),
]);

/** Reason codes carried on a degradation record. */
const DEGRADATION_REASONS = Object.freeze({
  RUNNER_NOT_INSTALLED: 'runner-not-installed',
  RUNNER_NOT_RESOLVABLE: 'runner-not-resolvable',
  UNPARSEABLE_OUTPUT: 'unparseable-output',
});

/**
 * Spawn one lint runner through `npx --no` (never install on the fly).
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function spawnLintRunner(bin, args, cwd) {
  const result = spawnSync('npx', ['--no', bin, ...args], {
    cwd,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Pure-ish: pick the first candidate whose bin is actually installed under
 * `<cwd>/node_modules/.bin`. Returns `null` when none is — an honest "this
 * surface has no runner" that the caller reports rather than silently folding
 * into a generic parse failure.
 *
 * The disk probe (rather than "spawn and see") is what makes the failure
 * *nameable*, and — since Story #5193 — what makes it *visible at all* on the
 * code surface: `npx --no <missing-bin>` answers with a generic npm error at
 * best and an empty exit 0 at worst, which is precisely how both defects hid.
 *
 * Probing `node_modules/.bin` only is a deliberate bound: a globally-installed
 * runner reads as absent here, which degrades the gate honestly rather than
 * trusting a spawn nobody resolved.
 *
 * Not exported: it is reachable — and asserted — through {@link runScopedLint},
 * whose `existsFn` seam drives every resolution branch.
 *
 * @param {ReadonlyArray<{ bin: string, extraArgs: ReadonlyArray<string> }>} candidates
 * @param {string} cwd
 * @param {(p: string) => boolean} existsFn  Injected for testing.
 * @returns {{ bin: string, extraArgs: ReadonlyArray<string> }|null}
 */
function resolveRunner(candidates, cwd, existsFn) {
  for (const candidate of candidates) {
    const base = path.join(cwd, 'node_modules', '.bin', candidate.bin);
    if (existsFn(base)) return candidate;
    if (
      process.platform === 'win32' &&
      (existsFn(`${base}.cmd`) || existsFn(`${base}.ps1`))
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Pure: the summary a surface reports when it has no runner to spawn. Counts
 * are zero *and* `executionFailed` is true, so the row can never be read as a
 * clean result — the invariant Story #5193 restored.
 *
 * @returns {ReturnType<typeof parseLintOutput>}
 */
function unresolvedRunnerSummary() {
  return {
    errors: 0,
    warnings: 0,
    parsed: false,
    executionFailed: true,
    emptyScope: false,
    reason: DEGRADATION_REASONS.RUNNER_NOT_INSTALLED,
  };
}

/**
 * Resolve one surface's runner and, only if it resolved, spawn and classify it.
 * Shared by both surfaces so neither can drift back into spawn-and-see.
 *
 * @param {{
 *   label: string,
 *   candidates: ReadonlyArray<{ bin: string, extraArgs: ReadonlyArray<string> }>,
 *   buildArgs: (runner: { bin: string, extraArgs: ReadonlyArray<string> }) => string[],
 *   cwd: string,
 *   runnerFn: typeof spawnLintRunner,
 *   existsFn: (p: string) => boolean,
 * }} args
 * @returns {{ surface: string, summary: ReturnType<typeof parseLintOutput> }}
 */
function runSurface({ label, candidates, buildArgs, cwd, runnerFn, existsFn }) {
  const runner = resolveRunner(candidates, cwd, existsFn);
  if (runner === null) {
    return { surface: label, summary: unresolvedRunnerSummary() };
  }
  return {
    surface: runner.bin,
    summary: parseLintOutput(runnerFn(runner.bin, buildArgs(runner), cwd)),
  };
}

/**
 * Pure: split changed paths into the file lists each lint runner consumes.
 *
 * @param {string[]} changedFiles
 * @returns {{ code: string[], md: string[] }}
 */
export function partitionFilesForLint(changedFiles) {
  const code = [];
  const md = [];
  for (const f of changedFiles) {
    if (CODE_EXTENSIONS.test(f)) code.push(f);
    else if (/\.md$/i.test(f)) md.push(f);
  }
  return { code, md };
}

/**
 * Pure: classify **one** runner's result into a summary.
 *
 * Handles the reporter formats composing `npm run lint` here:
 *   - Biome: `Found N error(s).` / `Found N warning(s).`
 *   - markdownlint-cli2: a trailing `Summary: N error(s)` line.
 *
 * A non-zero exit whose output matches no known reporter format is "could not
 * classify" → `executionFailed: true`, with `reason` naming what was actually
 * observed. Biome's empty-scope exit is recognised separately as
 * `emptyScope` — nothing to lint is not a broken runner.
 *
 * @param {{ status?: number, stdout?: string, stderr?: string }} result
 * @returns {{ errors: number, warnings: number, parsed: boolean, executionFailed: boolean, emptyScope: boolean, reason: string|null }}
 */
export function parseLintOutput(result) {
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  let errors = 0;
  let warnings = 0;
  let parsed = false;

  for (const m of combined.matchAll(/Found\s+(\d+)\s+error/gi)) {
    errors += Number(m[1]);
    parsed = true;
  }
  for (const m of combined.matchAll(/Found\s+(\d+)\s+warning/gi)) {
    warnings += Number(m[1]);
    parsed = true;
  }
  const mdSummary = combined.match(/Summary:\s+(\d+)\s+error/i);
  if (mdSummary) {
    errors += Number(mdSummary[1]);
    parsed = true;
  }

  const failedExit = !parsed && (result.status ?? 0) !== 0;
  const emptyScope = failedExit && BIOME_EMPTY_SCOPE.test(combined);
  const executionFailed = failedExit && !emptyScope;
  const reason = executionFailed
    ? NPX_UNRESOLVABLE.test(combined)
      ? DEGRADATION_REASONS.RUNNER_NOT_RESOLVABLE
      : DEGRADATION_REASONS.UNPARSEABLE_OUTPUT
    : null;

  return { errors, warnings, parsed, executionFailed, emptyScope, reason };
}

/**
 * Pure: merge per-surface summaries into the gate's single summary. Counts add;
 * `executionFailed` is the OR across surfaces; each failed surface contributes
 * one degradation record naming itself. Merging *summaries* rather than raw
 * output is what stops one runner's failure from becoming the other's verdict.
 *
 * The OR is deliberately lossy — it answers "did any surface fail?", which is
 * the only question the degradation channel asks. Story #5282 added the
 * `surfaces[]` rows so a consumer can ask the *other* questions the OR cannot
 * answer: which surface the merged counts came from, and — via each row's
 * `parsed` and `executionFailed` — whether an absent biome or a biome run that
 * simply reported nothing is behind a zero. Consumers that read the flat
 * counts are unaffected; the rows are additive.
 *
 * @param {Array<{ surface: string, summary: ReturnType<typeof parseLintOutput> }>} surfaces
 */
function mergeSurfaceSummaries(surfaces) {
  const rows = surfaces.map(({ surface, summary }) => ({
    surface,
    parsed: summary.parsed,
    errors: summary.errors,
    warnings: summary.warnings,
    executionFailed: summary.executionFailed,
    reason: summary.reason ?? DEGRADATION_REASONS.UNPARSEABLE_OUTPUT,
  }));
  const total = (field) => rows.reduce((sum, row) => sum + row[field], 0);

  return {
    errors: total('errors'),
    warnings: total('warnings'),
    parsed: rows.some((row) => row.parsed),
    executionFailed: rows.some((row) => row.executionFailed),
    skipped: false,
    mode: 'changed-only',
    degradations: rows
      .filter((row) => row.executionFailed)
      .map(({ surface, reason }) => ({ surface, reason })),
    surfaces: rows.map(({ reason, ...row }) => row),
  };
}

/**
 * Run lint scoped to the changed surface only.
 *
 * @param {string[]} changedFiles
 * @param {string} cwd
 * @param {typeof spawnLintRunner} [runnerFn]
 * @param {{ existsFn?: (p: string) => boolean }} [deps]  Test seam for runner resolution.
 * @returns {{ errors: number, warnings: number, parsed: boolean, skipped: boolean, mode: 'changed-only'|'off', executionFailed: boolean, degradations: Array<{ surface: string, reason: string }>, surfaces: Array<{ surface: string, parsed: boolean, errors: number, warnings: number, executionFailed: boolean }> }}
 */
export function runScopedLint(
  changedFiles,
  cwd,
  runnerFn = spawnLintRunner,
  deps = {},
) {
  const { existsFn = existsSync } = deps;
  const { code, md } = partitionFilesForLint(changedFiles);
  if (code.length === 0 && md.length === 0) {
    return {
      errors: 0,
      warnings: 0,
      parsed: false,
      skipped: true,
      mode: 'changed-only',
      executionFailed: false,
      degradations: [],
      surfaces: [],
    };
  }

  const surfaces = [];
  if (code.length > 0) {
    surfaces.push(
      runSurface({
        label: 'biome',
        candidates: CODE_RUNNERS,
        buildArgs: (runner) => ['lint', ...code, ...runner.extraArgs],
        cwd,
        runnerFn,
        existsFn,
      }),
    );
  }
  if (md.length > 0) {
    surfaces.push(
      runSurface({
        label: 'markdownlint',
        candidates: MARKDOWN_RUNNERS,
        buildArgs: (runner) => [...md, ...runner.extraArgs],
        cwd,
        runnerFn,
        existsFn,
      }),
    );
  }

  return mergeSurfaceSummaries(surfaces);
}
