/**
 * lib/orchestration/lint-baseline-service.js
 *
 * Captures the Epic lint baseline (see `lint-baseline.js capture`). Extracted
 * from the inline implementation that used to live in `dispatch-engine.js`
 * so the coordinator no longer reaches into `node:child_process` or
 * `node:fs` directly. Tests can exercise the service with a stubbed exec
 * adapter and no filesystem interaction.
 */

import defaultFs from 'node:fs';
import path from 'node:path';
import { getBaselines, getPaths, PROJECT_ROOT } from '../config-resolver.js';

/**
 * Shape of the exec adapter passed into {@link LintBaselineService}.
 *
 * Implementations may be sync (e.g. `execFileSync`) or async; the service
 * always `await`s the return value so either works.
 *
 * @typedef {(file: string, args: string[], options?: object) => (void | Promise<void>)} LintBaselineExec
 */

/**
 * Minimal logger shape consumed by {@link LintBaselineService}. Matches the
 * surviving `lib/Logger.js` surface (single-argument message form).
 *
 * @typedef {object} LintBaselineLogger
 * @property {(msg: string) => void} info
 * @property {(msg: string) => void} warn
 */

/**
 * Outcome of {@link LintBaselineService#capture}.
 *
 * @typedef {object} LintBaselineCaptureResult
 * @property {boolean} skipped                   True when the baseline file already existed on disk.
 * @property {boolean} [captured]                True when the exec adapter ran and succeeded.
 * @property {string} [error]                    Error message when the exec adapter threw (still non-fatal).
 */

export class LintBaselineService {
  /**
   * @param {object} deps
   * @param {LintBaselineExec} deps.exec           Injected exec adapter — invoked with `(file, args, options)`.
   * @param {LintBaselineLogger} deps.logger       Logger for skip / capture / failure messages.
   * @param {object} deps.settings                 `.agentrc.json` `settings` block.
   *   The baseline artifact path is resolved via
   *   `getBaselines(settings).lint.path` (default
   *   `baselines/lint.json`); operators override under
   *   `delivery.quality.gates.lint.baselinePath`.
   *   `scriptsRoot` is resolved via `getPaths(settings)`
   *   (lives at `project.paths.scriptsRoot` post-Epic #773 Story 9).
   * @param {typeof import('node:fs')} [deps.fs]   Optional `fs` module (defaults to `node:fs`). Kept injectable so unit tests can assert no real-disk access.
   */
  constructor({ exec, logger, settings, fs = defaultFs }) {
    this.exec = exec;
    this.logger = logger;
    this.settings = settings;
    this.fs = fs;
  }

  /**
   * Capture (or skip) the lint baseline for the given Epic branch.
   *
   * Behaviour:
   * - If the baseline artifact already exists, log a skip and return
   *   `{ skipped: true }` — **no exec call is made**.
   * - Otherwise invoke the injected exec adapter to run
   *   `node <scriptsRoot>/lint-baseline.js capture`.
   * - Exec failures are logged at `warn` and swallowed — baseline capture
   *   is advisory and must never break the dispatch cycle.
   *
   * @param {string} epicBranch  Epic branch name (used for logging only).
   * @returns {Promise<LintBaselineCaptureResult>}  Resolution of the capture attempt.
   */
  async capture(epicBranch) {
    const { settings, logger, exec, fs } = this;
    // `settings` is the legacy-shim view (`{ paths, quality, ... }`). The
    // post-reshape accessors read `project.paths` and `delivery.quality`;
    // the shim's pointers are reference-equal to the canonical blocks, so
    // re-wrap here.
    const canonical = {
      project: { paths: settings?.paths },
      delivery: { quality: settings?.quality },
    };
    const lintBaselinePath = getBaselines(canonical).lint.path;
    const absPath = path.resolve(PROJECT_ROOT, lintBaselinePath);

    if (fs.existsSync(absPath)) {
      logger.info('Lint baseline already exists, skipping capture.');
      return { skipped: true };
    }

    logger.info(`Capturing lint baseline on ${epicBranch}...`);
    const scriptsRoot = getPaths(canonical).scriptsRoot;
    try {
      await exec(
        'node',
        [path.join(PROJECT_ROOT, scriptsRoot, 'lint-baseline.js'), 'capture'],
        {
          cwd: PROJECT_ROOT,
          encoding: 'utf8',
          stdio: 'inherit',
          shell: false,
        },
      );
      return { skipped: false, captured: true };
    } catch (err) {
      logger.warn(`Lint baseline capture failed (non-fatal): ${err.message}`);
      return { skipped: false, captured: false, error: err.message };
    }
  }
}
