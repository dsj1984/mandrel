/**
 * source-classifier.js — tag a friction signal `"framework"` or `"consumer"`.
 * Defaults to consumer: under-tagging beats mis-routing. Pure.
 */

/** @type {readonly string[]} */
const FRAMEWORK_PREFIXES = Object.freeze([
  '.agents/',
  '.agentrc.json',
  '.claude/',
  'node .agents/scripts/',
]);

/**
 * Top-level `.agents/scripts/` CLIs, so a bare basename classifies like its
 * path. Static (classification is I/O-free); a sync test pins it to the
 * directory. `lib/` basenames are too generic to include.
 *
 * @type {readonly string[]}
 */
const FRAMEWORK_SCRIPT_BASENAMES = Object.freeze([
  'acceptance-eval.js',
  'agents-bootstrap-github.js',
  'apply-quality-bootstrap.js',
  'audit-baselines.js',
  'audit-labels-bootstrap.js',
  'audit-to-stories.js',
  'boot-sweep.js',
  'bootstrap.js',
  'check-arch-cycles.js',
  'check-baselines.js',
  'check-context-budget.js',
  'check-cyclomatic.js',
  'check-dead-exports.js',
  'check-doc-links.js',
  'check-gherkin-corpus.js',
  'check-test-temp-hygiene.js',
  'check-windows-git-perf.js',
  'ceremony-derive.js',
  'clean-temp.js',
  'clean-worktrees.js',
  'cleanup-repo-test-temp.js',
  'coverage-capture.js',
  'deliver-light.js',
  'deliver-recover.js',
  'deliver-run.js',
  'diagnose-friction.js',
  'diagnose.js',
  'drain-pending-cleanup.js',
  'evidence-gate.js',
  'file-ci-gap.js',
  'generate-config-docs.js',
  'generate-lens-checklists.js',
  'generate-skills-index.js',
  'generate-workflows-doc.js',
  'clean-git.js',
  'lint-issue-body.js',
  'mandrel-update-preflight.js',
  'merge-baseline.js',
  'nav-registry-diff.js',
  'notify.js',
  'plan-context.js',
  'plan-critics.js',
  'plan-persist.js',
  'plan-run-epilogue.js',
  'pr-watch-with-update.js',
  'prune-plan-run-labels.js',
  'quality-preview.js',
  'quality-watch.js',
  'resolve-doc-tiers.js',
  'resolve-stories.js',
  'resync-status-column.js',
  'run-tests.js',
  'single-story-close.js',
  'single-story-confirm-merge.js',
  'single-story-init.js',
  'stories-wave-tick.js',
  'story-review-compute.js',
  'sync-agentrc.js',
  'sync-claude-agents.js',
  'sync-claude-commands.js',
  'test-wrapper.js',
  'update-coverage-baseline.js',
  'update-crap-baseline.js',
  'update-duplication-baseline.js',
  'update-maintainability-baseline.js',
  'update-ticket-state.js',
  'validate-skills.js',
]);

/** @type {ReadonlySet<string>} */
const FRAMEWORK_SCRIPT_BASENAME_SET = new Set(FRAMEWORK_SCRIPT_BASENAMES);

/** @type {RegExp} */
const TOKEN_TRIM = /^[\s'"`(,;:]+|[\s'"`),;:]+$/g;

/**
 * @param {unknown} value
 * @returns {string}
 */
function toScanString(value) {
  if (typeof value !== 'string') return '';
  return value;
}

/**
 * Substring match: prefixes appear mid-command and under absolute paths.
 *
 * @param {string} haystack
 * @returns {boolean}
 */
function containsFrameworkPrefix(haystack) {
  if (haystack.length === 0) return false;
  for (const prefix of FRAMEWORK_PREFIXES) {
    if (haystack.includes(prefix)) return true;
  }
  return false;
}

/**
 * Exact token match only: `./tools/notify.js` is the consumer's own script.
 *
 * @param {string} haystack
 * @returns {boolean}
 */
function containsFrameworkScriptBasename(haystack) {
  if (haystack.length === 0) return false;
  for (const rawToken of haystack.split(/\s+/)) {
    const token = rawToken.replace(TOKEN_TRIM, '');
    if (FRAMEWORK_SCRIPT_BASENAME_SET.has(token)) return true;
  }
  return false;
}

/**
 * @param {string} haystack
 * @returns {boolean}
 */
function namesFrameworkSurface(haystack) {
  if (containsFrameworkPrefix(haystack)) return true;
  return containsFrameworkScriptBasename(haystack);
}

/**
 * Framework wins if either input names it.
 *
 * @param {unknown} failingPath
 * @param {unknown} command
 * @returns {"framework"|"consumer"}
 */
export function classifyPathSource(failingPath, command) {
  const path = toScanString(failingPath);
  const cmd = toScanString(command);
  if (namesFrameworkSurface(path)) return 'framework';
  if (namesFrameworkSurface(cmd)) return 'framework';
  return 'consumer';
}

/**
 * Literal copy of `RUNTIME_FRICTION_CATEGORIES.TOOL_DEGRADED` (importing it
 * would close a cycle); a test pins them together.
 *
 * @type {string}
 */
const TOOL_DEGRADED_CATEGORY = 'tool-degraded';

/** @type {readonly string[]} */
const DETAIL_SCAN_KEYS = Object.freeze(['reason', 'surface', 'phase']);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isSupplied(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * @param {unknown} details
 * @returns {string}
 */
function detailsScanText(details) {
  if (details === null || typeof details !== 'object') return '';
  const record = /** @type {Record<string, unknown>} */ (details);
  const parts = [];
  for (const key of DETAIL_SCAN_KEYS) {
    const value = record[key];
    if (typeof value === 'string') parts.push(value);
  }
  return parts.join('\n');
}

/**
 * First match wins: a supplied path/command → {@link classifyPathSource};
 * `details` text naming a framework prefix; `tool-degraded`; else consumer.
 * "Runtime-emitted means framework" is wrong — `close-failed` often blames
 * consumer code.
 *
 * @param {unknown} record
 * @returns {"framework"|"consumer"}
 */
export function classifySignalSource(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return 'consumer';
  }
  const signal = /** @type {Record<string, unknown>} */ (record);
  const emitter =
    signal.emitter !== null && typeof signal.emitter === 'object'
      ? /** @type {Record<string, unknown>} */ (signal.emitter)
      : null;
  const failingPath = signal.failingPath ?? signal.path;
  const command = signal.command ?? emitter?.command;

  if (isSupplied(failingPath) || isSupplied(command)) {
    return classifyPathSource(failingPath, command);
  }
  if (containsFrameworkPrefix(detailsScanText(signal.details))) {
    return 'framework';
  }
  if (
    typeof signal.category === 'string' &&
    signal.category.trim() === TOOL_DEGRADED_CATEGORY
  ) {
    return 'framework';
  }
  return 'consumer';
}

export const __testing = Object.freeze({
  FRAMEWORK_PREFIXES,
  FRAMEWORK_SCRIPT_BASENAMES,
  TOOL_DEGRADED_CATEGORY,
});
