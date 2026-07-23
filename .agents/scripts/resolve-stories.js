#!/usr/bin/env node

/**
 * resolve-stories.js — resolve a list of Story ids into the
 * `{ stories, dag, done }` envelope `/deliver` sequences from.
 *
 * This is the ONE resolution step for multi-Story delivery. `/deliver` takes
 * only Story ids; the graph is discovered here, from live state, rather than
 * hand-transcribed by the host or implied by a batch label.
 *
 * What it resolves, per Story:
 *   - the issue itself, fetched with **state=all** so an already-landed
 *     sibling is present rather than silently dropped;
 *   - its dependency edges: the union of body-parsed `blocked by #N` /
 *     `depends on #N` and native GitHub `blocked_by` edges;
 *   - its declared file footprint, as plain path strings, so the scheduler's
 *     co-dispatch overlap guard has something to work with.
 *
 * And across the set: every dependency id — inside the requested set or
 * foreign to it — is checked against live issue state, and a blocker that is
 * closed or `agent::done` lands in `done[]`. That is what makes "deliver
 * Stories across plan runs and over time" work: a Story whose blocker merged
 * weeks ago in a different run is simply ready.
 *
 * Usage:
 *   node .agents/scripts/resolve-stories.js --ids 101,102
 *   node .agents/scripts/resolve-stories.js --ids 101,102 --pretty
 *   node .agents/scripts/resolve-stories.js --ids 101 --no-native   # skip the dependencies API
 *
 * Exit codes: 0 ok, 1 usage/resolution error.
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger, routeAllOutputToStderr } from './lib/Logger.js';
import {
  buildStoriesEnvelope,
  isSatisfiedBlocker,
  parseIds,
  readNativeBlockedBy,
  toStoryRecord,
} from './lib/orchestration/resolve-stories.js';
import { createProvider } from './lib/provider-factory.js';
import { concurrentMap } from './lib/util/concurrent-map.js';
import { parseApiJson } from './providers/github/request-helpers.js';

export { buildStoriesEnvelope, parseIds, readNativeBlockedBy, toStoryRecord };

/**
 * Bounded concurrency for the per-issue round-trips. Matches the edge-writer's
 * cap: modest enough for GitHub's secondary rate limits, while collapsing
 * wall-clock from sum(round-trips) toward sum/concurrency.
 */
const FETCH_CONCURRENCY = 5;

const HELP = `\
Usage:
  resolve-stories.js --ids <n,n,...> [--pretty] [--no-native]

Resolve Story ids into the { stories, dag, done } envelope /deliver sequences
from. Dependencies are discovered from live state: body edges union native
blocked_by edges, with every blocker (in-set or foreign) resolved against its
real issue state.

Options:
  --ids <csv>    Comma-separated Story issue numbers. Required.
  --pretty       Pretty-print the JSON envelope.
  --no-native    Skip the native blocked_by read (body edges only).
  --help         Show this help.
`;

/**
 * @param {object} [deps]
 * @returns {{ provider: object, config: object }}
 */
export function resolveStoriesProvider({
  resolveConfigFn = resolveConfig,
  createProviderFn = createProvider,
} = {}) {
  const config = resolveConfigFn();
  return { provider: createProviderFn(config), config };
}

/**
 * Fetch every requested id and map it to a Story record, failing on the first
 * id that is not a deliverable Story.
 *
 * @param {object} provider
 * @param {number[]} ids
 * @returns {Promise<object[]>}
 */
export async function fetchStories(provider, ids) {
  return concurrentMap(
    ids,
    async (id) => {
      const issue = await provider.getTicket(id);
      if (!issue) {
        throw new Error(`[resolve-stories] Issue #${id} was not found.`);
      }
      return toStoryRecord(issue, id);
    },
    { concurrency: FETCH_CONCURRENCY },
  );
}

/**
 * Read native blocked_by edges for every Story in the set.
 *
 * @returns {Promise<Map<number, number[]>>}
 */
export async function readNativeEdges({ provider, stories, owner, repo }) {
  const entries = await concurrentMap(
    stories,
    async (story) => [
      story.id,
      await readNativeBlockedBy({
        gh: provider._gh,
        owner,
        repo,
        issueNumber: story.id,
        parseJson: parseApiJson,
      }),
    ],
    { concurrency: FETCH_CONCURRENCY },
  );
  return new Map(entries);
}

/**
 * Resolve dependency ids that are NOT in the requested set against live issue
 * state. A foreign blocker that already landed must enter `done[]`, or the
 * scheduler withholds its dependent forever — the exact wedge that made
 * cross-run delivery impossible.
 *
 * A foreign id that cannot be read is left OUT of `done[]`: unknown means
 * "still gating", which withholds the dependent rather than dispatching it
 * against a possibly-unlanded blocker.
 *
 * @returns {Promise<number[]>}
 */
export async function resolveForeignDone({ provider, dag, inSetIds }) {
  const foreign = [
    ...new Set(
      dag.flatMap((node) => node.dependsOn).filter((dep) => !inSetIds.has(dep)),
    ),
  ];
  if (foreign.length === 0) return [];
  const resolved = await concurrentMap(
    foreign,
    async (id) => {
      try {
        const issue = await provider.getTicket(id);
        return isSatisfiedBlocker(issue) ? id : null;
      } catch (err) {
        Logger.warn(
          `[resolve-stories] Could not read foreign blocker #${id} (${err?.message ?? err}) — ` +
            `treating it as still gating.`,
        );
        return null;
      }
    },
    { concurrency: FETCH_CONCURRENCY },
  );
  return resolved.filter((id) => id !== null);
}

async function main() {
  const { values } = parseArgs({
    options: {
      ids: { type: 'string' },
      pretty: { type: 'boolean', default: false },
      native: { type: 'boolean', default: true },
      help: { type: 'boolean', default: false },
    },
    // The documented opt-out is `--no-native`; without allowNegative,
    // parseArgs rejects it as an unknown option and the CLI has no working
    // way to skip the dependencies API.
    allowNegative: true,
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!values.ids) {
    process.stderr.write(HELP);
    throw new Error('[resolve-stories] --ids <n,n,...> is required');
  }

  // stdout is a JSON stream — keep human-readable output on stderr so a
  // headless caller can pipe this straight into stories-wave-tick.js.
  routeAllOutputToStderr();

  const ids = parseIds(values.ids);
  const { provider, config } = resolveStoriesProvider();
  const owner = config.github?.owner;
  const repo = config.github?.repo;

  const stories = await fetchStories(provider, ids);
  const nativeEdges = values.native
    ? await readNativeEdges({ provider, stories, owner, repo })
    : new Map();

  const inSetIds = new Set(stories.map((s) => s.id));
  const provisional = buildStoriesEnvelope({
    stories,
    nativeEdges,
    warn: (m) => Logger.warn(m),
    config,
  });
  const foreignDone = await resolveForeignDone({
    provider,
    dag: provisional.dag,
    inSetIds,
  });
  const envelope = buildStoriesEnvelope({
    stories,
    nativeEdges,
    foreignDone,
    warn: () => {},
    config,
  });

  process.stdout.write(
    values.pretty
      ? `${JSON.stringify(envelope, null, 2)}\n`
      : `${JSON.stringify(envelope)}\n`,
  );
  return 0;
}

runAsCli(import.meta.url, main, {
  source: 'resolve-stories',
  propagateExitCode: true,
});
