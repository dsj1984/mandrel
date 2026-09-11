/**
 * source-classifier.js — pure classifier that tags a friction signal
 * record as either `"framework"` (the Mandrel framework itself) or
 * `"consumer"` (the host project that consumes the framework via the
 * materialized `.agents/` directory).
 *
 * Used by `signals-writer.js#appendSignal` so every
 * record in `temp/run-<id>/stories/story-<sid>/signals.ndjson` carries an
 * authoritative `source` field, allowing downstream retro consumers to
 * route framework signals back to mandrel and keep consumer signals in
 * the host project (Epic #2547 / Story #2553).
 *
 * Heuristic (Tech Spec #2550):
 *   - A signal is `"framework"` when its `failingPath` or `command`
 *     mentions any path under the framework's own surface area:
 *       - `.agents/`
 *       - `.agentrc.json`
 *       - `.claude/`
 *       - `node .agents/scripts/`
 *     …or (Story #4916) names one of the CLI entry points shipped at the
 *     top level of `.agents/scripts/` by **bare basename**, so recognition
 *     does not depend on how the caller spelled the reference.
 *   - Anything else (or empty input) defaults to `"consumer"`. The default
 *     is intentional — most friction comes from consumer code touching
 *     framework tooling, and we'd rather under-tag than mis-route a
 *     consumer signal into the framework retro stream.
 *
 * Story #4824 adds {@link classifySignalSource} alongside it — the
 * record-level entry point the writer now calls, which resolves a
 * runtime-emitted record (no `failingPath`, no `command`) instead of letting
 * the `consumer` default win unconditionally. `classifyPathSource` keeps its
 * two-argument signature and behaviour verbatim.
 *
 * The classifier is pure: no I/O, no logging, no throws on weird input.
 * Callers (the writer) are responsible for swallowing classifier-level
 * faults — but the only way this function can throw is via a programmer
 * error in this file, which would surface during unit testing.
 */

/**
 * Framework prefixes, in declaration order. Order is significant only
 * for documentation purposes — any one match returns `"framework"`.
 *
 * @type {readonly string[]}
 */
const FRAMEWORK_PREFIXES = Object.freeze([
  '.agents/',
  '.agentrc.json',
  '.claude/',
  'node .agents/scripts/',
]);

/**
 * Basenames of the CLI entry points shipped at the top level of
 * `.agents/scripts/` (Story #4916).
 *
 * The prefix scan above recognises a framework script only when the caller
 * spelled a path — `node .agents/scripts/acceptance-eval.js` classifies
 * `framework`, while the same script named bare (`acceptance-eval.js --story
 * 4901`) matched no prefix and fell through to `consumer`, so a real framework
 * defect was routed as consumer-actionable and discarded. Recognition must not
 * depend on how the caller spelled the reference.
 *
 * Kept as **static data**, not a directory read: `classifySignalSource` is
 * called once per signal and MUST stay pure — no filesystem I/O at classify
 * time. The sync test in
 * `tests/lib/observability/source-classifier.test.js` reads the real directory
 * and fails when a script is added, renamed, or removed without this list
 * being updated, so the set cannot go stale and silently restore the blind
 * spot.
 *
 * Scoped to the top level deliberately: those are the entry points a command
 * line names. Library modules under `.agents/scripts/lib/` carry generic
 * basenames (`index.js`, `config.js`) that a consumer command could plausibly
 * name, and widening to them would trade one mis-route for another.
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
  'check-action-pinning.js',
  'check-arch-cycles.js',
  'check-audit-attribution.js',
  'check-baseline-drift.js',
  'check-baseline-scope.js',
  'check-baselines.js',
  'check-context-budget.js',
  'check-cyclomatic.js',
  'check-dead-exports.js',
  'check-doc-links.js',
  'check-generated-validator.js',
  'check-gherkin-corpus.js',
  'check-knip-entries.js',
  'check-lifecycle-lint.js',
  'check-pinned-override-notes.js',
  'check-schema-references.js',
  'check-test-portability.js',
  'check-test-temp-hygiene.js',
  'check-windows-git-perf.js',
  'check-workflow-citations.js',
  'check-workflow-cli-lint.js',
  'check-workflow-timeouts.js',
  'cleanup-repo-test-temp.js',
  'coverage-capture.js',
  'deliver-light.js',
  'deliver-recover.js',
  'diagnose-friction.js',
  'diagnose.js',
  'drain-pending-cleanup.js',
  'evidence-gate.js',
  'file-ci-gap.js',
  'generate-config-docs.js',
  'generate-lens-checklists.js',
  'generate-skills-index.js',
  'generate-workflows-doc.js',
  'git-cleanup.js',
  'install-matrix-assert.js',
  'lint-issue-body.js',
  'lint-label-vocabulary.js',
  'mandrel-update-preflight.js',
  'merge-baseline.js',
  'nav-registry-diff.js',
  'notify.js',
  'plan-context.js',
  'plan-critics.js',
  'plan-persist.js',
  'plan-run-epilogue.js',
  'post-structured-comment.js',
  'pr-watch-with-update.js',
  'provision-git-hooks.js',
  'prune-baseline-orphans.js',
  'prune-plan-run-labels.js',
  'quality-preview.js',
  'quality-watch.js',
  'resolve-doc-tiers.js',
  'resolve-stories.js',
  'resync-status-column.js',
  'run-coverage.js',
  'run-lint.js',
  'run-test-profile.js',
  'run-tests.js',
  'run-verify.js',
  'single-story-close.js',
  'single-story-confirm-merge.js',
  'single-story-init.js',
  'stories-wave-tick.js',
  'sync-agentrc.js',
  'sync-claude-agents.js',
  'sync-claude-commands.js',
  'test-isolate.js',
  'test-wrapper.js',
  'update-coverage-baseline.js',
  'update-crap-baseline.js',
  'update-dead-exports-baseline.js',
  'update-duplication-baseline.js',
  'update-maintainability-baseline.js',
  'update-ticket-state.js',
  'validate-skills.js',
]);

/**
 * Membership index over {@link FRAMEWORK_SCRIPT_BASENAMES}, built once at
 * module load so the per-signal scan is a hash lookup.
 *
 * @type {ReadonlySet<string>}
 */
const FRAMEWORK_SCRIPT_BASENAME_SET = new Set(FRAMEWORK_SCRIPT_BASENAMES);

/**
 * Characters a shell-ish command line can wrap a token in. Stripped from both
 * ends before the membership test so `"acceptance-eval.js",` still resolves.
 *
 * @type {RegExp}
 */
const TOKEN_TRIM = /^[\s'"`(,;:]+|[\s'"`),;:]+$/g;

/**
 * Normalise a value to a string for prefix scanning. Anything that is not
 * a string (undefined, null, numbers, objects) becomes the empty string,
 * which scans clean against every framework prefix.
 *
 * @param {unknown} value
 * @returns {string}
 */
function toScanString(value) {
  if (typeof value !== 'string') return '';
  return value;
}

/**
 * Return true when `haystack` contains any framework prefix as a
 * substring. We use `includes` (not `startsWith`) because a command line
 * like `node .agents/scripts/single-story-init.js` carries the prefix in the
 * middle, and a failing-path like `repo/.agents/foo.js` may carry an
 * absolute prefix.
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
 * Return true when `haystack` names a top-level framework script by **bare
 * basename** — no path segment at all (Story #4916).
 *
 * Whitespace-tokenised and matched whole: only a token that *equals* a known
 * basename counts. A token carrying any path segment is deliberately left to
 * {@link containsFrameworkPrefix} — `./tools/notify.js` is the consumer's own
 * script and must stay `consumer`, while `.agents/scripts/notify.js` already
 * matches a prefix. Likewise `my-notify.js` is not `notify.js`.
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
 * True when `haystack` names the framework's own surface, by either
 * recognition route: a path prefix, or a bare framework-script basename.
 *
 * Purely additive over {@link containsFrameworkPrefix} — every string that
 * matched a prefix still matches here, so widening can only ever move a
 * classification from `consumer` to `framework`, never the reverse.
 *
 * @param {string} haystack
 * @returns {boolean}
 */
function namesFrameworkSurface(haystack) {
  if (containsFrameworkPrefix(haystack)) return true;
  return containsFrameworkScriptBasename(haystack);
}

/**
 * Classify a friction signal as `"framework"` or `"consumer"`.
 *
 * Both arguments are best-effort: pass whatever the detector already has
 * (the failing file path, the failing command line, or both). When both
 * are empty / non-string, returns `"consumer"` — the safe default for
 * routing.
 *
 * Framework-wins: if either input matches a framework prefix, the result
 * is `"framework"` even when the other input looks consumer-shaped. This
 * matters for mixed cases like a consumer test invoking
 * `node .agents/scripts/single-story-init.js` — that's framework friction even
 * though the failing test path lives under the consumer.
 *
 * Either input matches on a framework path prefix **or** on a bare framework
 * script basename (Story #4916), so `single-story-close.js --story 4906` is
 * recognised exactly like its fully-pathed spelling.
 *
 * @param {unknown} failingPath  The path of the file or directory the
 *                               signal blames (e.g. `"tests/foo.test.js"`).
 * @param {unknown} command       The command line the signal blames
 *                                (e.g. `"node .agents/scripts/single-story-init.js"`).
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
 * The one friction category that is definitionally a framework-surface
 * failure (Story #4824).
 *
 * Kept as a local literal rather than imported from
 * `RUNTIME_FRICTION_CATEGORIES.TOOL_DEGRADED` because `runtime-friction.js`
 * imports `signals-writer.js`, which imports this module — the import would
 * close a cycle for a single string. The unit test asserts the two spellings
 * agree, so the duplication cannot drift silently.
 *
 * @type {string}
 */
const TOOL_DEGRADED_CATEGORY = 'tool-degraded';

/**
 * Detail keys whose free text names the surface a runtime record blames.
 * Scanned (step 2 below) because a runtime emitter puts the framework path
 * it was executing here, not in `failingPath` / `command`.
 *
 * @type {readonly string[]}
 */
const DETAIL_SCAN_KEYS = Object.freeze(['reason', 'surface', 'phase']);

/**
 * True when `value` is a non-empty string — the test for "the operator (or a
 * detector) actually supplied this field", as opposed to a runtime emitter
 * that leaves it absent.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isSupplied(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Concatenate the scannable free text out of a record's `details` payload.
 *
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
 * Classify a whole signal record as `"framework"` or `"consumer"`
 * (Story #4824).
 *
 * `classifyPathSource` above requires **positive evidence** of a framework
 * prefix in an operator-supplied `failingPath` / `command`. Every
 * runtime-emitted friction record (`runtime-friction.js`) populates neither
 * field, so the `consumer` default always won and the framework limb of the
 * feedback loop was unreachable — 78% of real records mis-tagged.
 *
 * The naive repair — "runtime-emitted means framework" — is measurably
 * **wrong**. `close-failed` records from `single-story-close` carry
 * consumer-owned failures (a base-sync conflict in the consumer's own source
 * tree, a consumer `npm run test:coverage` exiting non-zero); tagging those
 * `framework` would flood the framework repo with consumer test failures,
 * which is worse than the current silence.
 *
 * So the discriminator is resolved in four steps, first match wins:
 *
 * 1. An operator-supplied `failingPath` / `path` / `command` /
 *    `emitter.command` → the existing {@link classifyPathSource} prefix scan,
 *    **unchanged**. A consumer command invoked through `diagnose-friction.js`
 *    stays `consumer`.
 * 2. Else the `details` payload's free text (`reason`, `surface`, `phase`)
 *    naming a framework prefix → `framework`. A runtime emitter blames its
 *    surface here, not in a `command` field.
 * 3. Else `category === "tool-degraded"` → `framework`.
 *    `RUNTIME_FRICTION_CATEGORIES.TOOL_DEGRADED` is defined as a tool that
 *    failed to *execute* — an operational degradation, not a code finding.
 *    The framework's own tooling could not run, which says nothing about
 *    consumer code.
 * 4. Else `consumer` — the existing safe default, unchanged.
 *
 * Steps 1, 2 and 4 leave every currently-exercised input byte-identical;
 * step 3 is the limb that was unreachable. There is deliberately no emitter
 * allowlist: nothing to maintain, nothing to rot.
 *
 * Pure, and never throws — the writer's `tagSignalSource` still guards it.
 *
 * @param {unknown} record One signal record (the `appendSignal` payload).
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
