#!/usr/bin/env node
/**
 * CLI: ensure `coverage/coverage-final.json` is present and fresh before the
 * CRAP gate fires. Wired into close-validation (always) and pre-push (with
 * `--skip-when-no-crap-files` so untouched-source pushes stay fast).
 *
 * Behaviour:
 *   1. Resolve `delivery.quality.crap`. If `enabled === false`, exit 0.
 *   2. With `--skip-when-no-crap-files`: read `git diff --name-only <ref>...HEAD`
 *      (default ref `main`) and exit 0 if no changed file lives under
 *      `crap.targetDirs`.
 *   3. Test freshness: content digest of `crap.targetDirs` vs. the persisted
 *      capture stamp (`coverage/.capture-stamp.json`), falling back to the
 *      artifact-mtime heuristic when no stamp exists. Exit 0 when fresh.
 *   4. Otherwise spawn `npm run test:coverage`, write a fresh capture stamp
 *      on success, and propagate the exit code.
 *
 * Exit codes:
 *   0 — coverage is fresh (or capture skipped/succeeded).
 *   1 — capture run failed (broken tests or coverage-threshold breach). The
 *       caller MUST surface this — silently passing here would defeat the
 *       CRAP gate's `requireCoverage: true` policy.
 */
import path from 'node:path';
import { getChangedFiles } from './lib/changed-files.js';
import { getQuality, resolveConfig } from './lib/config-resolver.js';
import {
  anyChangedUnderTargets,
  computeContentDigest,
  isCoverageFresh,
  runCapture,
  writeCaptureStamp,
} from './lib/coverage-capture.js';

import { Logger } from './lib/Logger.js';
import { hasNpmScript, readPackageScripts } from './lib/npm-scripts.js';

function parseArgs(argv) {
  const out = {
    skipWhenNoCrapFiles: false,
    ref: 'main',
    cwd: process.cwd(),
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--skip-when-no-crap-files') out.skipWhenNoCrapFiles = true;
    else if (a === '--ref') out.ref = argv[++i] ?? out.ref;
    else if (a === '--cwd') out.cwd = argv[++i] ?? out.cwd;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const config = resolveConfig({ cwd: args.cwd });
  const { crap, coverage } = getQuality(config);

  if (crap.enabled === false) {
    Logger.info('[coverage-capture] CRAP gate disabled — skipping capture.');
    return 0;
  }

  // Story #4473 — detect the "missing npm script" misconfiguration
  // distinctly. `close-validation/gates.js` already declines to register
  // this gate when `test:coverage` is absent, so reaching here without the
  // script means a direct/pre-push invocation in a consumer that never
  // defined it. Surface a one-line, fix-naming diagnostic instead of
  // spawning `npm run test:coverage` only to propagate npm's opaque
  // "Missing script" exit code.
  if (!hasNpmScript(readPackageScripts(args.cwd), 'test:coverage')) {
    Logger.error(
      '[coverage-capture] ✖ No "test:coverage" script in package.json. ' +
        'Add one (e.g. "test:coverage": "node --test --experimental-test-coverage") ' +
        'or disable the CRAP gate via delivery.quality.gates.crap.enabled=false.',
    );
    return 1;
  }

  if (args.skipWhenNoCrapFiles) {
    let changed;
    try {
      changed = getChangedFiles({ ref: args.ref, cwd: args.cwd });
    } catch (err) {
      // A bad ref must not silently relax the gate. Fall through to the
      // freshness check so coverage still gets captured if needed.
      Logger.warn(
        `[coverage-capture] ⚠ ${err?.message ?? err} — falling back to freshness check.`,
      );
      changed = null;
    }
    if (changed && !anyChangedUnderTargets(changed, crap.targetDirs)) {
      Logger.info(
        `[coverage-capture] No changed files under [${crap.targetDirs.join(', ')}] — skipping capture.`,
      );
      return 0;
    }
  }

  const freshness = isCoverageFresh({
    coveragePath: crap.coveragePath,
    targetDirs: crap.targetDirs,
    cwd: args.cwd,
  });
  if (freshness.fresh) {
    Logger.info(
      `[coverage-capture] Coverage at ${path.resolve(args.cwd, crap.coveragePath)} is ${freshness.reason} — skipping capture.`,
    );
    return 0;
  }

  Logger.info(
    `[coverage-capture] Coverage at ${crap.coveragePath} is ${freshness.reason}; running npm run test:coverage…`,
  );
  const code = runCapture({
    cwd: args.cwd,
    timeoutMs: coverage?.timeoutMs,
    log: (m) => Logger.info(m),
  });
  if (code !== 0) {
    Logger.error(
      `[coverage-capture] ✖ npm run test:coverage exited ${code}. Fix failing tests or coverage-threshold breaches before re-running the CRAP gate.`,
    );
    return code;
  }

  // Persist the content digest next to the fresh artifact so subsequent
  // freshness checks are content-aware (mtime churn from branch switches no
  // longer invalidates). Best-effort — a missing stamp just means the next
  // check falls back to the mtime heuristic.
  const digest = computeContentDigest(args.cwd, crap.targetDirs);
  if (
    digest &&
    writeCaptureStamp({
      cwd: args.cwd,
      coveragePath: crap.coveragePath,
      digest,
    })
  ) {
    Logger.info('[coverage-capture] Wrote content-digest capture stamp.');
  }
  return code;
}

// cli-opt-out: synchronous main returns an exit code that is forwarded via process.exit(code); runAsCli's async-main signature does not preserve the result code.
try {
  process.exit(main());
} catch (err) {
  Logger.error('[coverage-capture] unexpected error:', err);
  process.exit(1);
}
