/**
 * What differs between launch targets: how an environment entry resolves,
 * which launcher starts it, and the envelope fields its launch, stop and
 * dry-run report. `local` runs a process; `claude-cloud` fires a routine.
 *
 * @module lib/dispatch/targets
 */

import {
  CloudLaunchError,
  cloudEnvelopeFields,
  describeFireRequest,
} from './launch-cloud.js';

const CLOUD_TARGET = 'claude-cloud';

const DEFAULT_COMMAND = Object.freeze([
  'claude',
  '-p',
  '/mandrel-deliver {id}',
]);

const isCloud = (environment) => environment.target === CLOUD_TARGET;

/**
 * One configured entry with its defaults; a cloud entry is online only when
 * its token variable is set in `env`.
 *
 * @param {string} name
 * @param {object} entry
 * @param {Record<string, string|undefined>} env
 * @returns {import('./environments.js').Environment}
 */
export function resolveEntry(name, entry, env) {
  const base = {
    name,
    target: entry?.target ?? 'local',
    capacity: entry?.capacity ?? 1,
  };
  if (!isCloud(base)) {
    return {
      ...base,
      online: true,
      command: [...(entry?.command ?? DEFAULT_COMMAND)],
    };
  }
  const cloud = { ...base, routine: entry.routine, tokenEnv: entry.tokenEnv };
  return env[entry.tokenEnv]
    ? { ...cloud, online: true }
    : { ...cloud, online: false, offlineReason: 'missing-token' };
}

/** The launcher `deps` provides for the environment's target. */
export function launcherFor(environment, deps) {
  return isCloud(environment) ? deps.launchCloudImpl : deps.launchImpl;
}

/** Whether a failed launch takes back the label it applied. */
export function releasesLabel(applied, err) {
  return applied && !err?.keepLabel;
}

/**
 * Envelope fields for a cloud fire that failed; any other launch error is
 * rethrown as the command failing.
 */
export function launchFailureFields(err) {
  if (err instanceof CloudLaunchError) return cloudEnvelopeFields(err);
  throw new Error(`launch failed: ${err?.message ?? err}`);
}

/** Where a launched delivery can be followed. */
export function launchedFields(record) {
  return record.sessionUrl
    ? { sessionUrl: record.sessionUrl, commentPosted: record.commentPosted }
    : { pid: record.pid, logPath: record.logPath };
}

/** A stopped cloud Story's session is left for the operator to archive. */
export function stoppedFields(record) {
  if (!record?.sessionUrl) return {};
  return {
    sessionUrl: record.sessionUrl,
    remoteStop: 'manual',
    detail: `No API stops a fired session; archive it at ${record.sessionUrl}.`,
  };
}

/** What a dry run would start: the argv, or the redacted fire request. */
export function dryRunFields(environment, storyId, commandFor) {
  return isCloud(environment)
    ? { request: describeFireRequest(environment, storyId) }
    : { argv: commandFor(environment.command, storyId) };
}
