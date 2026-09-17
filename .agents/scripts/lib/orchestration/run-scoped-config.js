/**
 * run-scoped-config.js — pin the config values a delivery run was seeded
 * from, and fail closed when the file they came from changed underneath it.
 *
 * The problem this exists for: `single-story-init.js` resolves config and
 * seeds `story-<id>` from `project.baseBranch`; `single-story-close` used to
 * re-resolve the SAME key and run close-validation, format-autofix, the gate
 * baseline and base-sync against its own second answer. Nothing pinned the
 * first value and nothing checked the two agreed — and the window between
 * them is however long implementation takes. A concurrent session editing
 * `.agentrc.json` / `.agentrc.local.json` mid-run therefore base-synced a
 * Story against a base it was never seeded from, which surfaced only as an
 * ordinary content conflict with nothing pointing at config.
 *
 * The base a Story was seeded from is a property of **that run**, not of
 * whatever the config file says later. So init pins it and close reads the
 * pin back.
 *
 * ## Where the pin lives
 *
 * The init envelope on disk — `<tempRoot>/orchestration/story-init-result-<id>.log`,
 * written by `single-story-init.js` via `emitTerseResult`. Story #5343 retired
 * the `story-init` ticket comment (the delivery-comment diet), so the envelope
 * is the pin's home; it is written before init returns and read at close, well
 * before the post-land tail purges the temp tree.
 *
 * That is a hard cutover, not a dual read. The envelope is written by the same
 * process, in the same run, that seeds the branch — so if it is gone, the temp
 * tree was reaped and this is a much later close, exactly the case a stale
 * `story-init` comment would have answered with equal uncertainty. A missing
 * pin is never a refusal: it degrades to the currently-resolved config with a
 * loud, announced warning, and close simply cannot confirm the base.
 *
 * ## Adding another run-scoped key
 *
 * Add one row to `RUN_SCOPED_CONFIG_KEYS`. Both halves — the pin init writes
 * and the comparison close makes — enumerate that registry, so a new key
 * needs no second mechanism, no reader change and no writer change. Only
 * `baseBranch` is enforced today because only its corruption is destructive
 * (a wrong base merged into the Story branch permanently contaminates the
 * branch and its PR diff); ceremony profile, quality floors and the
 * concurrency cap are deliberately NOT pinned here.
 */

import { readRunScopedPin } from './story-init-envelope.js';

/**
 * The run-scoped config registry. One row per key whose value belongs to the
 * run that seeded the Story rather than to the current contents of the config
 * file. `read` resolves the key from a resolved config (including its
 * default); `label` is the dotted config path the operator has to go fix.
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
 * Snapshot the run-scoped config values from a resolved config. This is the
 * write half of the pin: `single-story-init.js` records the returned object
 * on its init envelope so close can compare against it later.
 *
 * @param {object} config Resolved config (`resolveConfig` output).
 * @param {typeof RUN_SCOPED_CONFIG_KEYS} [keys] Registry override — the
 *   default is the module registry; supplying one is how a caller (or a test)
 *   exercises the registry-driven property without a second mechanism.
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
 * Compare the receipt's pinned values against the currently-resolved ones,
 * one registry row at a time. Split out of `resolveRunScopedConfig` so the
 * row walk and the three outcomes it feeds (confirmed / conflict / unpinned)
 * read separately.
 *
 * A row the receipt pins nothing for is `unpinned`, not a conflict: an older
 * receipt simply predates that registry row, and falling back to current
 * config for it is correct as long as the fallback is announced.
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
 * Build the refusal message for a mid-run config change. Names BOTH values
 * for every conflicting key — the pinned one and the one config resolves to
 * now — because "which base was this branch actually seeded from" is the
 * question the operator could not previously answer.
 *
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
 * Resolve the run-scoped config for a close, preferring the run's pin over a
 * fresh resolution of the config file.
 *
 * Throws on disagreement — fail closed, before any gate, format-autofix or
 * base-sync has run, with both values named. Never silently prefers either
 * side: preferring the pin would base-sync correctly but hide a config change
 * the operator needs to know about, and preferring current config is the bug
 * this module exists to close.
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
 * }>} `confirmed` is true only when every key came from the receipt and
 *   agreed with current config — i.e. when downstream remediation may safely
 *   assume the pinned value is the one in play.
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
    // A missing pin is a real state, not an error — but the fallback is
    // announced, because a silent one reintroduces exactly the bug above.
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
 * Render `label=value` pairs for the operator-facing lines above.
 *
 * @param {Record<string, unknown>} values
 * @param {typeof RUN_SCOPED_CONFIG_KEYS} keys
 * @returns {string}
 */
function describeValues(values, keys) {
  return Object.entries(keys)
    .map(([key, spec]) => `${spec.label}=\`${String(values[key])}\``)
    .join(', ');
}
