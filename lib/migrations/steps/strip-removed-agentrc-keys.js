// lib/migrations/steps/strip-removed-agentrc-keys.js
/**
 * Strip the `.agentrc` keys the config-surface cut removed (removed gates,
 * zero-reader keys, tuning keys folded into constants) from both config
 * surfaces, reporting each one's replacement — and a `behaviour change` line
 * when the consumer's value differed, so the upgrade never silently changes
 * delivery. Only `delivery`/`planning` (optional) ancestors are pruned.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

const AGENTRC_FILENAMES = Object.freeze([
  '.agentrc.json',
  '.agentrc.local.json',
]);

const PRUNABLE_ROOTS = new Set(['delivery', 'planning']);

/**
 * @param {string} dotted
 * @param {string} constant
 * @param {unknown} value
 */
const folded = (dotted, constant, value) => ({
  path: dotted.split('.'),
  constant,
  value,
});

/**
 * `alwaysChanges`: removal changes behaviour for anyone who had it on.
 *
 * @param {string} dotted
 * @param {string} reason
 * @param {{ alwaysChanges?: boolean }} [opts]
 */
const removed = (dotted, reason, { alwaysChanges = false } = {}) => ({
  path: dotted.split('.'),
  reason,
  alwaysChanges,
});

const REMOVED_AGENTRC_KEYS = Object.freeze([
  removed(
    'delivery.quality.gates.lint',
    'the lint baseline gate was removed (npm run lint still runs as a close gate)',
    { alwaysChanges: true },
  ),
  removed(
    'delivery.quality.gates.lighthouse',
    'the lighthouse baseline gate was removed',
    { alwaysChanges: true },
  ),
  removed('delivery.quality.baselineEpsilon.lint', 'its gate was removed'),
  removed(
    'delivery.quality.baselineEpsilon.lighthouse',
    'its gate was removed',
  ),
  removed('delivery.quality.gates.mutation.strykerConfigPath', 'no reader'),
  removed('delivery.auditToStories.autoComment', 'no reader'),
  removed('delivery.codeReview.providerConfig', 'no reader'),
  removed('delivery.quality.gates.crap.friction', 'no reader'),
  removed('delivery.quality.gates.crap.refreshTimeoutMs', 'no reader'),
  removed(
    'delivery.quality.gates.maintainability.refreshTimeoutMs',
    'no reader',
  ),
  removed('delivery.quality.gates.duplication.refreshTimeoutMs', 'no reader'),
  removed(
    'delivery.quality.gates.crap.incrementalCoverage.enabled',
    'deprecated alias — set skipWhenUnchanged / baselineJoin instead',
    { alwaysChanges: true },
  ),
  folded('delivery.quality.gateScoping.scope', 'GATE_SCOPING.scope', 'diff'),
  folded(
    'delivery.quality.gateScoping.diffRef',
    'GATE_SCOPING.diffRef',
    'main',
  ),
  folded(
    'delivery.quality.gates.crap.refreshTag',
    'BASELINE_REFRESH_TAG',
    'baseline-refresh:',
  ),
  folded(
    'delivery.quality.gates.maintainability.refreshTag',
    'BASELINE_REFRESH_TAG',
    'baseline-refresh:',
  ),
  folded(
    'delivery.quality.gates.coverage.timeoutMs',
    'COVERAGE_GATE_DEFAULTS.timeoutMs',
    600000,
  ),
  folded(
    'delivery.quality.formatAutofix.timeoutMs',
    'FORMAT_AUTOFIX_TIMEOUT_MS',
    60000,
  ),
  folded(
    'delivery.quality.codingGuardrails.cyclomaticFlag',
    'CODING_GUARDRAILS.cyclomaticFlag',
    8,
  ),
  folded(
    'delivery.quality.codingGuardrails.requireSiblingTest',
    'CODING_GUARDRAILS.requireSiblingTest',
    false,
  ),
  folded(
    'delivery.quality.autoRefresh.crapJumpCap',
    'AUTO_REFRESH_DEFAULTS.crapJumpCap',
    5,
  ),
  folded(
    'delivery.quality.autoRefresh.scope',
    'AUTO_REFRESH_DEFAULTS.scope',
    'diff',
  ),
  ...Object.entries({
    maintainability: 0.5,
    crap: 0.5,
    coverage: 0.1,
    mutation: 0.5,
    'bundle-size': 1024,
    duplication: 0.5,
  }).map(([kind, value]) =>
    folded(
      `delivery.quality.baselineEpsilon.${kind}`,
      `BASELINE_EPSILON.${kind}`,
      value,
    ),
  ),
  folded('delivery.codeReview.maxFixAttempts', 'none (no reader)', 3),
  folded('github.defaultTimeoutMs', 'GH_DEFAULT_TIMEOUT_MS', 60000),
  folded(
    'delivery.ci.watch.pollIntervalMs',
    'WATCH_DEFAULTS.pollIntervalMs (--poll-interval-ms)',
    10000,
  ),
  folded(
    'delivery.ci.watch.maxPolls',
    'WATCH_DEFAULTS.maxPolls (--max-polls)',
    180,
  ),
  folded(
    'delivery.ci.watch.maxResumes',
    'WATCH_DEFAULTS.maxResumes (--max-resumes)',
    3,
  ),
  folded(
    'delivery.ci.watch.attachWindowMs',
    'WATCH_DEFAULTS.attachWindowMs (--attach-window-ms)',
    1200000,
  ),
  folded(
    'delivery.execution.timeoutMs',
    'LIMITS_DEFAULTS.executionTimeoutMs',
    600000,
  ),
  folded(
    'delivery.execution.requireCreditedCapture',
    'off (coverage-capture --require-credited)',
    false,
  ),
  folded(
    'delivery.tempRetention.staleDays',
    'TEMP_RETENTION_DEFAULTS.staleDays',
    7,
  ),
  folded('delivery.mergeWatch.intervalSeconds', 'DEFAULT_INTERVAL_SECONDS', 30),
  folded('delivery.mergeWatch.updateAttempts', 'DEFAULT_UPDATE_ATTEMPTS', 3),
  folded('delivery.review.lensDiffFloor', 'DEFAULT_LENS_DIFF_FLOOR', 40),
  folded(
    'delivery.feedbackLoop.frictionWindowDays',
    'FRICTION_WINDOW_DAYS',
    30,
  ),
  folded(
    'delivery.auditToStories.severityFloor',
    'DEFAULT_SEVERITY_FLOOR (--severity)',
    'high',
  ),
  folded('planning.memoryPool.indexByteCeiling', 'INDEX_BYTE_CEILING', 24576),
]);

/**
 * @param {object | null} config
 * @param {string[]} keyPath
 * @returns {object[] | null}
 */
function containersFor(config, keyPath) {
  if (!config || typeof config !== 'object') return null;
  const chain = [config];
  for (const segment of keyPath.slice(0, -1)) {
    const next = chain[chain.length - 1][segment];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return null;
    chain.push(next);
  }
  return chain;
}

/**
 * @param {object | null} config
 * @param {string[]} keyPath
 * @returns {{ present: boolean, value?: unknown }}
 */
function lookup(config, keyPath) {
  const chain = containersFor(config, keyPath);
  const leaf = keyPath[keyPath.length - 1];
  if (!chain || !Object.hasOwn(chain[chain.length - 1], leaf)) {
    return { present: false };
  }
  return { present: true, value: chain[chain.length - 1][leaf] };
}

/**
 * @param {object} config
 * @param {string[]} keyPath
 * @returns {void}
 */
function deleteAndPrune(config, keyPath) {
  const chain = containersFor(config, keyPath);
  if (!chain) return;
  delete chain[chain.length - 1][keyPath[keyPath.length - 1]];
  if (!PRUNABLE_ROOTS.has(keyPath[0])) return;
  for (let index = chain.length - 1; index > 0; index -= 1) {
    if (Object.keys(chain[index]).length > 0) break;
    delete chain[index - 1][keyPath[index - 1]];
  }
}

/**
 * @param {object} entry
 * @param {unknown} value
 * @returns {boolean}
 */
function changesBehaviour(entry, value) {
  if ('constant' in entry) {
    return JSON.stringify(value) !== JSON.stringify(entry.value);
  }
  if (!entry.alwaysChanges) return false;
  return !(value && typeof value === 'object' && value.enabled === false);
}

/**
 * @param {string} filename
 * @param {object} entry
 * @param {unknown} value
 * @returns {string}
 */
function reportLine(filename, entry, value) {
  const dotted = entry.path.join('.');
  const replacement =
    'constant' in entry
      ? `now ${entry.constant} = ${JSON.stringify(entry.value)}`
      : entry.reason;
  const prefix = changesBehaviour(entry, value)
    ? `  behaviour change: ${filename} set ${dotted} = ${JSON.stringify(value)};`
    : `  removed ${filename} ${dotted};`;
  return `${prefix} ${replacement}`;
}

/**
 * Mutates `config`.
 *
 * @param {object} config
 * @param {string} filename
 * @returns {string[]}
 */
function stripRemovedKeys(config, filename) {
  const lines = [];
  for (const entry of REMOVED_AGENTRC_KEYS) {
    const { present, value } = lookup(config, entry.path);
    if (!present) continue;
    lines.push(reportLine(filename, entry, value));
    deleteAndPrune(config, entry.path);
  }
  return lines;
}

/**
 * @param {{ projectRoot?: string }} ctx
 * @param {string} filename
 * @param {typeof nodeFs} fsImpl
 * @returns {object | null}
 */
function readConfig(ctx, filename, fsImpl) {
  try {
    const file = path.join(ctx?.projectRoot ?? process.cwd(), filename);
    return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {object | null} config
 * @returns {boolean}
 */
function carriesRemovedKey(config) {
  return REMOVED_AGENTRC_KEYS.some(
    (entry) => lookup(config, entry.path).present,
  );
}

export const stripRemovedAgentrcKeys = {
  version: '2.61.0',
  description:
    'strip the .agentrc keys the config-surface cut removed — the lint and ' +
    'lighthouse gates, zero-reader keys, and never-set tuning keys now ' +
    'fixed as constants (Story #5382)',
  detect(ctx) {
    const fsImpl = ctx?.fs ?? nodeFs;
    return AGENTRC_FILENAMES.some((filename) =>
      carriesRemovedKey(readConfig(ctx, filename, fsImpl)),
    );
  },
  apply(ctx) {
    const fsImpl = ctx?.fs ?? nodeFs;
    const log = ctx?.log ?? console.log;
    for (const filename of AGENTRC_FILENAMES) {
      const config = readConfig(ctx, filename, fsImpl);
      if (!carriesRemovedKey(config)) continue;
      for (const line of stripRemovedKeys(config, filename)) log(line);
      fsImpl.writeFileSync(
        path.join(ctx?.projectRoot ?? process.cwd(), filename),
        `${JSON.stringify(config, null, 2)}\n`,
      );
    }
  },
};
