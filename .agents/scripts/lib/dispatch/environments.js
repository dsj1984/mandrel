/**
 * The delivery-environment registry behind `mandrel dispatch`: the resolved
 * `delivery.environments` map, the `env::<name>` label that records which
 * environment holds a Story, and an environment's load. No I/O: a cloud
 * entry is online when its token variable is set in the env map passed in.
 *
 * @module lib/dispatch/environments
 */

import { AGENT_LABELS } from '../label-constants.js';
import { withLaunchDefaults } from './launch-options.js';
import { resolveEntry } from './targets.js';

/**
 * `env::<name>` records which environment holds a Story; minted on demand.
 * On a closed Story it is history only.
 */
const ENV_LABEL_PREFIX = 'env::';

const SESSION_PLACEHOLDER = '{sessionId}';

/** The colour an `env::` label is created with. */
export const ENV_LABEL_COLOR = '#5319E7';

/** States in which a labelled open Story counts against its environment. */
const LOAD_STATES = new Set([
  AGENT_LABELS.READY,
  AGENT_LABELS.EXECUTING,
  AGENT_LABELS.CLOSING,
  AGENT_LABELS.BLOCKED,
]);

/**
 * @typedef {{ name: string, target: string, capacity: number, online: boolean,
 *   model: string|null, effort: string|null, offlineReason?: string,
 *   command?: string[], routine?: string, tokenEnv?: string }} Environment
 */

/**
 * Every configured environment with its defaults applied; one implicit
 * `local` environment (capacity 1) when none is configured.
 *
 * @param {object} [config]
 * @param {Record<string, string|undefined>} [env] Where a cloud token is looked up.
 * @returns {Environment[]}
 */
export function resolveEnvironments(config, env = process.env) {
  const map = config?.delivery?.environments;
  const entries =
    map && typeof map === 'object' && Object.keys(map).length > 0
      ? Object.entries(map)
      : [['local', { target: 'local' }]];
  return entries.map(([name, entry]) =>
    withLaunchDefaults(resolveEntry(name, entry, env), entry),
  );
}

/**
 * @param {string} name
 * @returns {string}
 */
export function envLabel(name) {
  return `${ENV_LABEL_PREFIX}${name}`;
}

/**
 * The environment a Story's labels name, or `null`.
 *
 * @param {string[]} [labels]
 * @returns {string|null}
 */
export function environmentOf(labels) {
  const label = (labels ?? []).find((l) => l.startsWith(ENV_LABEL_PREFIX));
  return label ? label.slice(ENV_LABEL_PREFIX.length) : null;
}

/**
 * The Story's `agent::*` state label, or `null`.
 *
 * @param {string[]} [labels]
 * @returns {string|null}
 */
export function agentStateOf(labels) {
  const states = Object.values(AGENT_LABELS);
  return (labels ?? []).find((l) => states.includes(l)) ?? null;
}

/**
 * Whether a ticket holds an environment slot: open, labelled, and in a
 * dispatched-or-delivering state. A label on a closed Story is history.
 *
 * @param {{ state?: string, labels?: string[] }} ticket
 * @returns {boolean}
 */
export function holdsEnvironment(ticket) {
  if (String(ticket?.state ?? '').toLowerCase() !== 'open') return false;
  if (environmentOf(ticket.labels) === null) return false;
  return LOAD_STATES.has(agentStateOf(ticket.labels));
}

/**
 * Load per environment name over a ticket list.
 *
 * @param {Environment[]} environments
 * @param {Array<{ state?: string, labels?: string[] }>} tickets
 * @returns {Record<string, number>}
 */
export function computeLoads(environments, tickets) {
  const loads = Object.fromEntries(environments.map((e) => [e.name, 0]));
  for (const ticket of tickets ?? []) {
    if (!holdsEnvironment(ticket)) continue;
    const name = environmentOf(ticket.labels);
    if (name in loads) loads[name] += 1;
  }
  return loads;
}

/**
 * The argv for one Story: `{id}` and `{sessionId}` replaced in every
 * element; a dry run keeps the session placeholder.
 *
 * @param {string[]} command
 * @param {number} storyId A validated positive integer.
 * @param {string} [sessionId]
 * @returns {string[]}
 */
export function commandFor(command, storyId, sessionId = SESSION_PLACEHOLDER) {
  return command.map((part) =>
    part
      .replaceAll('{id}', String(storyId))
      .replaceAll(SESSION_PLACEHOLDER, sessionId),
  );
}

/** Whether a command asks for a session id. */
export function wantsSessionId(command) {
  return command.some((part) => part.includes(SESSION_PLACEHOLDER));
}
