/**
 * Pin the config a delivery run was seeded from (in the init envelope) and
 * fail closed at close when the config changed underneath it — a concurrent
 * edit would otherwise base-sync the Story onto a base it was never seeded
 * from. A missing pin degrades to current config with a loud warning.
 */

import { readRunScopedPin } from './story-init-envelope.js';

/**
 * Keys whose value belongs to the seeding run. Only `baseBranch`: a wrong base
 * permanently contaminates the branch. Init and close both walk this registry.
 *
 * @type {Record<string, { read: (config: object) => unknown, label: string }>}
 */
const RUN_SCOPED_CONFIG_KEYS = {
  baseBranch: {
    read: (config) => config?.project?.baseBranch ?? 'main',
    label: 'project.baseBranch',
  },
};

/**
 * @param {object} config Resolved config.
 * @param {typeof RUN_SCOPED_CONFIG_KEYS} [keys]
 * @returns {Record<string, unknown>} the pinned values, keyed by config key.
 */
export function pinRunScopedConfig(config, keys = RUN_SCOPED_CONFIG_KEYS) {
  const pinned = {};
  for (const [key, spec] of Object.entries(keys)) {
    pinned[key] = spec.read(config);
  }
  return pinned;
}

/**
 * A row with no pinned value is `unpinned` (an older receipt), not a conflict.
 *
 * @param {{
 *   pinned: Record<string, unknown>,
 *   current: Record<string, unknown>,
 *   keys: typeof RUN_SCOPED_CONFIG_KEYS,
 * }} args
 * @returns {{
 *   values: Record<string, unknown>,
 *   conflicts: Array<{ label: string, pinned: unknown, current: unknown }>,
 *   unpinned: string[],
 * }}
 */
function comparePinToCurrent({ pinned: pin, current, keys }) {
  const values = {};
  const conflicts = [];
  const unpinned = [];
  for (const [key, spec] of Object.entries(keys)) {
    const pinned = pin?.[key];
    if (pinned === undefined || pinned === null) {
      unpinned.push(spec.label);
      values[key] = current[key];
      continue;
    }
    values[key] = pinned;
    if (pinned !== current[key]) {
      conflicts.push({ label: spec.label, pinned, current: current[key] });
    }
  }
  return { values, conflicts, unpinned };
}

/**
 * @param {{ storyId: number, conflicts: Array<{ label: string, pinned: unknown, current: unknown }> }} args
 * @returns {string}
 */
function formatRunScopedConflict({ storyId, conflicts }) {
  const rows = conflicts.map(
    ({ label, pinned, current }) =>
      `${label}: pinned at init = \`${String(pinned)}\`, currently resolves to \`${String(current)}\``,
  );
  return (
    `[single-story-close] Refusing to close Story #${storyId}: run-scoped config changed mid-run. ` +
    `${rows.join('; ')}. ` +
    'The Story branch was seeded from the pinned value, so closing against the current one would ' +
    'base-sync it onto a base it was never seeded from. No base-sync, format-autofix or gate run was ' +
    'performed. A concurrent session most likely edited `.agentrc.json` / `.agentrc.local.json` during ' +
    'the implementation window: restore the pinned value and re-run close, or re-init the Story against ' +
    'the new value deliberately.'
  );
}

/**
 * Throws on disagreement, before any gate or base-sync runs — silently
 * preferring either side would hide the config change.
 *
 * @param {{
 *   storyId: number,
 *   config: object,
 *   keys?: typeof RUN_SCOPED_CONFIG_KEYS,
 *   readPinFn?: typeof readRunScopedPin,
 *   progress?: (tag: string, msg: string) => void,
 * }} args
 * @returns {Promise<{
 *   values: Record<string, unknown>,
 *   confirmed: boolean,
 *   receiptStatus: string,
 *   warning: string|null,
 * }>} `confirmed` only when every key was pinned and agreed.
 */
export async function resolveRunScopedConfig({
  storyId,
  config,
  keys = RUN_SCOPED_CONFIG_KEYS,
  readPinFn = readRunScopedPin,
  progress,
}) {
  const current = pinRunScopedConfig(config, keys);
  const receipt = readPinFn({ storyId: Number(storyId), config });

  if (!receipt) {
    // Not an error, but never a silent fallback.
    const warning =
      `Run-scoped config could not be read from the run's init envelope ` +
      `(no runScopedConfig pin for Story #${storyId}); falling back to the ` +
      `currently-resolved config (${describeValues(current, keys)}). This close ` +
      'cannot confirm the Story was seeded from these values.';
    progress?.('PIN', `⚠️ ${warning}`);
    return {
      values: current,
      confirmed: false,
      receiptStatus: 'absent',
      warning,
    };
  }

  const { values, conflicts, unpinned } = comparePinToCurrent({
    pinned: receipt,
    current,
    keys,
  });

  if (conflicts.length > 0) {
    throw new Error(formatRunScopedConflict({ storyId, conflicts }));
  }

  if (unpinned.length > 0) {
    const warning =
      `The run's init receipt pins no value for ${unpinned.join(', ')}; ` +
      `falling back to the currently-resolved config (${describeValues(values, keys)}).`;
    progress?.('PIN', `⚠️ ${warning}`);
    return {
      values,
      confirmed: false,
      receiptStatus: 'found',
      warning,
    };
  }

  progress?.(
    'PIN',
    `📌 Run-scoped config pinned by the init envelope (${describeValues(values, keys)}).`,
  );
  return { values, confirmed: true, receiptStatus: 'found', warning: null };
}

/**
 * @param {Record<string, unknown>} values
 * @param {typeof RUN_SCOPED_CONFIG_KEYS} keys
 * @returns {string}
 */
function describeValues(values, keys) {
  return Object.entries(keys)
    .map(([key, spec]) => `${spec.label}=\`${String(values[key])}\``)
    .join(', ');
}
