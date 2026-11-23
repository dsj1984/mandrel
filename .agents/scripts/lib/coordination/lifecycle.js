/**
 * Lifecycle glue for the coordination channel: each delivery surface gains
 * one call. Advisory and fail-open: nothing here throws, and no caller's exit
 * code, status or gate outcome depends on what it returns. The channel is
 * loaded on first use, so a surface whose channel is off imports none of it.
 */

import { getCoordination } from '../config/github.js';
import { redactErrorMessage } from '../error-redactor.js';
import { parseApiJson } from '../gh-pr-rest.js';
import { AGENT_LABELS } from '../label-constants.js';
import { renderEvents } from './event.js';

const READ_MODES = Object.freeze({
  default: {},
  throttle: { throttle: true },
  'since-start': { sinceStart: true },
});

const FILES_PAGE = 100;

/** Why the channel could not be reached at all, as one redacted line. */
function unavailable(err) {
  const [line] = String(err?.message ?? err).split('\n');
  return `unavailable: ${redactErrorMessage(line).slice(0, 300)}`;
}

/** A surface hands over its provider, or the factory that builds it. */
function resolveProvider(provider) {
  const resolved = typeof provider === 'function' ? provider() : provider;
  if (!resolved) throw new Error('no ticketing provider');
  return resolved;
}

/** A URL under the configured repository, or null when none is set. */
function repoUrl(config, suffix) {
  const { owner, repo } = config?.github ?? {};
  return owner && repo ? `https://github.com/${owner}/${repo}/${suffix}` : null;
}

/**
 * Read a Story's inbox at a lifecycle surface: print the rendered block when
 * an event is pertinent, and answer the surface's `coordination` field.
 *
 * @param {{ storyId: number, config: object, provider: object|(() => object),
 *   mode?: 'default'|'throttle'|'since-start', cwd?: string,
 *   write?: (block: string) => void }} opts The rest reaches `readInbox`.
 * @returns {Promise<{ events: object[], disabled?: true, skipped?: string, degraded?: string }>}
 */
export async function surfaceInbox({
  provider,
  mode = 'default',
  env = process.env,
  write = (block) => process.stderr.write(`${block}\n`),
  ...read
}) {
  if (!getCoordination(read.config, env).enabled) {
    return { events: [], disabled: true };
  }
  try {
    const { readInbox } = await import('./inbox.js');
    const result = await readInbox({
      ...read,
      ...READ_MODES[mode],
      env,
      provider: resolveProvider(provider),
    });
    const events = result.events ?? [];
    if (events.length > 0) write(renderEvents(events));
    const { skipped, degraded } = result;
    return {
      events,
      ...(skipped && { skipped }),
      ...(degraded && { degraded }),
    };
  } catch (err) {
    return { events: [], degraded: unavailable(err) };
  }
}

/**
 * Publish the one `landed` event of a confirmed merge on its Story, scoped to
 * the files the merged PR changed. Once-only, so a re-run posts nothing.
 *
 * @param {{ storyId: number, prNumber: number, prUrl?: string, config: object,
 *   provider: object, gh: { api: Function } }} opts The rest reaches
 *   `publishEvent`.
 * @returns {Promise<object>} Its result, or `{ skipped }` or `{ degraded }`.
 */
export async function publishLanded({
  storyId,
  prNumber,
  prUrl,
  gh,
  env = process.env,
  ...lib
}) {
  const { owner, repo } = lib.config?.github ?? {};
  if (!getCoordination(lib.config, env).enabled) return { disabled: true };
  if (!owner || !repo) return { skipped: 'no-repository' };
  try {
    const files = parseApiJson(
      await gh.api({
        method: 'GET',
        endpoint: `repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=${FILES_PAGE}`,
      }),
    );
    const paths = files.map((file) => file.filename);
    const { publishEvent } = await import('./channel.js');
    return await publishEvent(
      {
        kind: 'landed',
        summary: `Story #${storyId} landed in PR #${prNumber}`,
        paths,
        // shortcut: one page of files; a fuller PR broadcasts, page it if that gets noisy.
        broadcast: paths.length >= FILES_PAGE,
        link: prUrl ?? repoUrl(lib.config, `pull/${prNumber}`),
        storyId,
      },
      { ...lib, env, once: true },
    );
  } catch (err) {
    return { degraded: unavailable(err) };
  }
}

/**
 * The in-flight Stories sharing a concrete path with `story`, each with those
 * paths. Globs are skipped: an unparseable body would match everything.
 *
 * @returns {Array<{ id: number, paths: string[] }>}
 */
function overlapsOf(story, inFlight, { storyFootprintPaths, detectCollision }) {
  const files = storyFootprintPaths(story.body, story.id);
  return inFlight
    .filter((other) => other.id !== story.id)
    .map((other) => ({
      id: other.id,
      paths:
        detectCollision({ files }, other, { concreteOnly: true })?.paths ?? [],
    }))
    .filter((hit) => hit.paths.length > 0);
}

/**
 * Publish one `plan-change` event per persisted Story whose declared
 * footprint collides with another open `agent::executing` Story. Each event
 * posts on the new Story and names the in-flight ones.
 *
 * @param {{ stories: Array<{ id: number, body: string, adopted?: boolean }>,
 *   config: object, provider: object }} opts An `adopted` Story (a resumed
 *   persist) publishes once only.
 * @returns {Promise<{ published: number[], warnings: string[] }>}
 */
export async function publishPlanChanges({
  stories,
  env = process.env,
  ...lib
}) {
  const { config, provider } = lib;
  const out = { published: [], warnings: [] };
  const usable =
    getCoordination(config, env).enabled &&
    typeof provider?.listTicketsByLabel === 'function';
  if (!usable) return out;
  try {
    const [{ publishEvent }, { storyFootprintPaths }, { detectCollision }] =
      await Promise.all([
        import('./channel.js'),
        import('../orchestration/resolve-stories.js'),
        import('../wave-runner/footprint.js'),
      ]);
    const executing = await provider.listTicketsByLabel({
      state: 'open',
      labels: AGENT_LABELS.EXECUTING,
    });
    const inFlight = executing.map(({ id, body }) => ({
      id,
      files: storyFootprintPaths(body, id),
    }));
    for (const story of stories) {
      const hits = overlapsOf(story, inFlight, {
        storyFootprintPaths,
        detectCollision,
      });
      if (hits.length === 0) continue;
      const result = await publishEvent(
        {
          kind: 'plan-change',
          summary: `Story #${story.id} was planned over files in-flight work is changing`,
          stories: hits.map((hit) => hit.id),
          paths: [...new Set(hits.flatMap((hit) => hit.paths))].sort(),
          link: repoUrl(config, `issues/${story.id}`),
          storyId: story.id,
        },
        { ...lib, env, once: story.adopted === true },
      );
      if (result.published) out.published.push(story.id);
      const failure = result.degraded ?? result.refused;
      if (failure) {
        out.warnings.push(
          `[plan-persist] plan-change event for Story #${story.id} was not published: ${failure}`,
        );
      }
    }
  } catch (err) {
    out.warnings.push(
      `[plan-persist] plan-change events were not published: ${unavailable(err)}`,
    );
  }
  return out;
}
