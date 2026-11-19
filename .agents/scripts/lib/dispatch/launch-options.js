/**
 * The model and effort a dispatched delivery runs with. For each, a
 * `model::<m>` / `effort::<e>` override label beats the environment's
 * configured default, which beats nothing (Claude Code's own default).
 * Labels can be set outside the board, so every launch re-validates them
 * here and fails closed. Pure; no I/O.
 *
 * @module lib/dispatch/launch-options
 */

import { AGENT_MODEL_PATTERN } from '../config/agent-models.js';

/** The `--effort` levels Claude Code accepts. */
export const EFFORT_LEVELS = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const BUILT_IN_MODELS = Object.freeze(['opus', 'sonnet', 'haiku']);

const MODEL_LABEL_PREFIX = 'model::';
const EFFORT_LABEL_PREFIX = 'effort::';

/** Each override label kind: its prefix and the colour it is minted with. */
const LABEL_KINDS = Object.freeze({
  model: { prefix: MODEL_LABEL_PREFIX, color: '#1D76DB' },
  effort: { prefix: EFFORT_LABEL_PREFIX, color: '#FBCA04' },
});

const MODEL_RE = new RegExp(AGENT_MODEL_PATTERN);

const isModel = (value) => typeof value === 'string' && MODEL_RE.test(value);

/**
 * The models an override may pick: the built-ins, `delivery.dispatchModels`,
 * then every environment's configured `model`, deduplicated in that order.
 *
 * @param {object} [config]
 * @returns {string[]}
 */
export function modelChoices(config) {
  const extra = config?.delivery?.dispatchModels;
  const environments = Object.values(config?.delivery?.environments ?? {});
  return [
    ...new Set([
      ...BUILT_IN_MODELS,
      ...(Array.isArray(extra) ? extra : []),
      ...environments.map((e) => e?.model),
    ]),
  ].filter(isModel);
}

/** The status read model's `launchChoices`. */
export function launchChoices(config) {
  return { models: modelChoices(config), efforts: [...EFFORT_LEVELS] };
}

/**
 * A resolved environment with its entry's configured `model` / `effort`
 * (`null` when unset); a cloud routine has neither.
 */
export function withLaunchDefaults(environment, entry) {
  const local = environment.target !== 'claude-cloud';
  return {
    ...environment,
    model: (local && entry?.model) || null,
    effort: (local && entry?.effort) || null,
  };
}

/** Each element with its placeholder filled, or `null` to drop it. */
function fillPart(part, values) {
  let out = part;
  for (const [placeholder, value] of values) {
    if (!out.includes(placeholder)) continue;
    if (value === null) return null;
    out = out.replaceAll(placeholder, value);
  }
  return out;
}

/**
 * `{model}` and `{effort}` replaced in every argv element; an element whose
 * placeholder has no resolved value is dropped.
 *
 * @param {string[]} argv
 * @param {{ model?: string|null, effort?: string|null }} options Values
 *   already resolved against the allowlist.
 * @returns {string[]}
 */
function fillLaunchOptions(argv, { model = null, effort = null } = {}) {
  const values = [
    ['{model}', model],
    ['{effort}', effort],
  ];
  return argv.map((part) => fillPart(part, values)).filter((p) => p !== null);
}

/** A local environment's command with the resolved options filled in. */
function withLaunchOptions(environment, { model, effort }) {
  if (!environment.command) return environment;
  const values = { model: model.value, effort: effort.value };
  return {
    ...environment,
    command: fillLaunchOptions(environment.command, values),
  };
}

const valuesOf = (labels, prefix) =>
  (labels ?? [])
    .filter((l) => l.startsWith(prefix))
    .map((l) => l.slice(prefix.length));

/**
 * The raw override values a Story's labels carry, `null` where none.
 *
 * @param {string[]} [labels]
 * @returns {{ model: string|null, effort: string|null }}
 */
export function overridesOf(labels) {
  return {
    model: valuesOf(labels, MODEL_LABEL_PREFIX)[0] ?? null,
    effort: valuesOf(labels, EFFORT_LABEL_PREFIX)[0] ?? null,
  };
}

/** Whether `label` is a `model::` or `effort::` override label. */
function isLaunchLabel(label) {
  return Object.values(LABEL_KINDS).some(({ prefix }) =>
    label.startsWith(prefix),
  );
}

/**
 * The label that sets `kind` to `value`, as `provider.ensureLabels` takes it.
 *
 * @param {'model'|'effort'} kind
 * @param {string} value
 */
function launchLabel(kind, value) {
  const { prefix, color } = LABEL_KINDS[kind];
  return {
    name: `${prefix}${value}`,
    color,
    description: `Dispatch override: run the delivery with ${kind} ${value}.`,
  };
}

/**
 * The label write that sets a Story's overrides to `choice` (`null` clears
 * one): the labels to mint and add, and every other override label to remove.
 *
 * @param {string[]} labels The Story's current labels.
 * @param {{ model: string|null, effort: string|null }} choice
 * @returns {{ add: Array<{ name: string, color: string, description: string }>,
 *   remove: string[] }}
 */
export function launchLabelChange(labels, choice) {
  const add = ['model', 'effort']
    .filter((kind) => choice[kind] !== null)
    .map((kind) => launchLabel(kind, choice[kind]));
  const keep = new Set(add.map((l) => l.name));
  const remove = (labels ?? []).filter((l) => isLaunchLabel(l) && !keep.has(l));
  return { add, remove };
}

function labelProblem(models, efforts, choices) {
  if (models.length > 1) return `more than one model:: label (${models})`;
  if (efforts.length > 1) return `more than one effort:: label (${efforts})`;
  if (models.length && !choices.includes(models[0])) {
    return `model::${models[0]} is not an allowed model (${choices.join(', ')})`;
  }
  if (efforts.length && !EFFORT_LEVELS.includes(efforts[0])) {
    return `effort::${efforts[0]} is not an effort level (${EFFORT_LEVELS.join(', ')})`;
  }
  return null;
}

/** Override, then the environment's value; `environment` when none is chosen yet. */
function pick(override, environment, key) {
  if (override) return { value: override, source: 'override' };
  if (!environment) return { value: null, source: 'environment' };
  const configured = environment[key] ?? null;
  return configured
    ? { value: configured, source: 'environment' }
    : { value: null, source: 'claude-default' };
}

/**
 * Resolve a Story's launch options in `environment` (`null` before one is
 * chosen). A cloud routine runs its own model: its overrides are ignored.
 *
 * @param {{ target?: string, model?: string|null, effort?: string|null }|null} environment
 * @param {string[]} labels
 * @param {string[]} choices {@link modelChoices}
 * @returns {{ ok: true, model: { value: string|null, source: string },
 *   effort: { value: string|null, source: string }, ignoredOverrides?: string[] }
 *   | { ok: false, reason: 'invalid-launch-option', detail: string }}
 */
export function resolveLaunchOptions(environment, labels, choices) {
  const models = valuesOf(labels, MODEL_LABEL_PREFIX);
  const efforts = valuesOf(labels, EFFORT_LABEL_PREFIX);
  const detail = labelProblem(models, efforts, choices);
  if (detail) return { ok: false, reason: 'invalid-launch-option', detail };
  if (environment?.target === 'claude-cloud') {
    const routine = { value: null, source: 'routine' };
    const ignored = (labels ?? []).filter(isLaunchLabel);
    return {
      ok: true,
      model: routine,
      effort: { ...routine },
      ...(ignored.length > 0 ? { ignoredOverrides: ignored } : {}),
    };
  }
  return {
    ok: true,
    model: pick(models[0], environment, 'model'),
    effort: pick(efforts[0], environment, 'effort'),
  };
}

/**
 * A dispatch or resume verdict with `launch`: the Story's launch options in
 * its environment and the environment a launch starts (its command filled).
 * An invalid override label turns it into an `invalid-launch-option`
 * refusal before anything is written; any other verdict passes through.
 *
 * @param {{ ok: boolean, action: string, environment?: string }} verdict
 * @param {object[]} environments The resolved environments.
 * @param {{ labels: string[] }} story
 * @param {object} [config]
 * @returns {object} The verdict, a refusal, or the verdict with `launch`.
 */
export function gateLaunch(verdict, environments, { labels }, config) {
  if (!verdict.ok || verdict.action === 'stop') return verdict;
  const environment = environments.find((e) => e.name === verdict.environment);
  const { ok, ...resolved } = resolveLaunchOptions(
    environment,
    labels,
    modelChoices(config),
  );
  if (!ok) return { ok, action: verdict.action, ...resolved };
  const launch = {
    launchOptions: resolved,
    environment: withLaunchOptions(environment, resolved),
  };
  return { ...verdict, launch };
}
