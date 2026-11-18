/**
 * The one verdict function for `mandrel dispatch`: what an action on a Story
 * in an environment would do. The command, `--dry-run` and the `--status`
 * read model all call it, so a refusal never differs between them. Pure.
 *
 * @module lib/dispatch/verdict
 */

import { AGENT_LABELS, TYPE_LABELS } from '../label-constants.js';
import {
  agentStateOf,
  environmentOf,
  holdsEnvironment,
} from './environments.js';

/**
 * @typedef {{ ok: true, action: string, environment: string, applyLabel: boolean }
 *   | { ok: false, action: string, reason: string, detail: string }} Verdict
 */

const refuse = (action, reason, detail) => ({
  ok: false,
  action,
  reason,
  detail,
});

const ids = (list) => list.map((id) => `#${id}`).join(', ');

/** Any assignee other than the operator; with no operator, any assignee. */
function foreignOwner(assignees, operator) {
  const owner = assignees?.[0] ?? null;
  if (owner === null) return null;
  if (operator && owner.toLowerCase() === operator.toLowerCase()) return null;
  return owner;
}

/**
 * Refusals every action shares once its environment is chosen.
 *
 * @returns {Verdict|null}
 */
function sharedRefusal({ action, story, envName, environments, operator }) {
  if (!environments.some((e) => e.name === envName)) {
    const known = environments.map((e) => e.name).join(', ');
    return refuse(
      action,
      'unknown-environment',
      `No environment named "${envName ?? ''}"; configured: ${known}.`,
    );
  }
  const owner = foreignOwner(story.assignees, operator);
  if (owner) {
    return refuse(
      action,
      'foreign-lease',
      `#${story.id} is leased to @${owner}.`,
    );
  }
  return null;
}

function atCapacity({ action, envName, environments, loads }) {
  const env = environments.find((e) => e.name === envName);
  const load = loads?.[envName] ?? 0;
  if (load < env.capacity) return null;
  return refuse(
    action,
    'at-capacity',
    `Environment "${envName}" holds ${load} of ${env.capacity}.`,
  );
}

function decideDispatch(input) {
  const { story, envName } = input;
  const state = agentStateOf(story.labels);
  if (holdsEnvironment(story)) {
    return refuse(
      'dispatch',
      'already-dispatched',
      `#${story.id} is already held by environment "${environmentOf(story.labels)}".`,
    );
  }
  if (state !== AGENT_LABELS.READY) {
    return refuse(
      'dispatch',
      'not-ready',
      `#${story.id} is ${state ?? 'unlabelled'}, not ${AGENT_LABELS.READY}.`,
    );
  }
  const shared = sharedRefusal({ ...input, action: 'dispatch' });
  if (shared) return shared;
  if (input.unmetDependencies?.length > 0) {
    return refuse(
      'dispatch',
      'unmet-dependency',
      `#${story.id} is blocked by open ${ids(input.unmetDependencies)}.`,
    );
  }
  const full = atCapacity({ ...input, action: 'dispatch' });
  if (full) return full;
  return {
    ok: true,
    action: 'dispatch',
    environment: envName,
    applyLabel: true,
  };
}

function decideResume(input) {
  const { story, envName } = input;
  const state = agentStateOf(story.labels);
  if (state !== AGENT_LABELS.BLOCKED) {
    return refuse(
      'resume',
      'not-blocked',
      `#${story.id} is ${state ?? 'unlabelled'}, not ${AGENT_LABELS.BLOCKED}.`,
    );
  }
  const holder = environmentOf(story.labels);
  if (envName && holder && envName !== holder) {
    return refuse(
      'resume',
      'wrong-environment',
      `#${story.id} is held by "${holder}", not "${envName}".`,
    );
  }
  const target = holder ?? envName;
  const shared = sharedRefusal({ ...input, envName: target, action: 'resume' });
  if (shared) return shared;
  if (!holder) {
    const full = atCapacity({ ...input, envName: target, action: 'resume' });
    if (full) return full;
  }
  return {
    ok: true,
    action: 'resume',
    environment: target,
    applyLabel: !holder,
  };
}

function decideStop(input) {
  const { story, envName } = input;
  if (agentStateOf(story.labels) === AGENT_LABELS.CLOSING) {
    return refuse(
      'stop',
      'closing',
      `#${story.id} is ${AGENT_LABELS.CLOSING}; let close land or recover it.`,
    );
  }
  const holder = environmentOf(story.labels);
  if (!holder || (envName && envName !== holder)) {
    return refuse(
      'stop',
      'wrong-environment',
      holder
        ? `#${story.id} is held by "${holder}", not "${envName}".`
        : `#${story.id} is not held by any environment.`,
    );
  }
  const shared = sharedRefusal({ ...input, envName: holder, action: 'stop' });
  if (shared) return shared;
  return { ok: true, action: 'stop', environment: holder, applyLabel: false };
}

const DECIDERS = {
  dispatch: decideDispatch,
  resume: decideResume,
  stop: decideStop,
};

/**
 * @param {{
 *   action: 'dispatch'|'resume'|'stop',
 *   story: { id: number, labels: string[], assignees?: string[] },
 *   envName?: string|null,
 *   environments: import('./environments.js').Environment[],
 *   loads?: Record<string, number>,
 *   unmetDependencies?: number[],
 *   children?: number[],
 *   operator?: string|null,
 * }} input
 * @returns {Verdict}
 */
export function decide(input) {
  const { action, story } = input;
  if ((story.labels ?? []).includes(TYPE_LABELS.EPIC)) {
    return refuse(
      action,
      'epic',
      `#${story.id} is an Epic; dispatch its children: ${ids(input.children ?? []) || 'none'}.`,
    );
  }
  return DECIDERS[action](input);
}
