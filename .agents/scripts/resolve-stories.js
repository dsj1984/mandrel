#!/usr/bin/env node

/**
 * resolve-stories.js — resolve Story ids into the `{ stories, dag, done }`
 * envelope `/mandrel-deliver` sequences from, discovering the graph from live
 * state: footer `blocked by #N` edges union native `blocked_by` edges (read to
 * exhaustion, failing loud), plus each Story's footprint for the overlap
 * guard. Every blocker, in-set or foreign, is checked live, so one that landed
 * in an earlier run lands in `done[]`.
 *
 * Usage:
 *   node .agents/scripts/resolve-stories.js --ids 101,102
 *   node .agents/scripts/resolve-stories.js --ids 101-104        # inclusive range
 *   node .agents/scripts/resolve-stories.js --ids 101,102 --pretty
 *   node .agents/scripts/resolve-stories.js --ids 101 --no-native   # skip the dependencies API
 *   node .agents/scripts/resolve-stories.js --ids 101 --allow-unlabelled
 *
 * Exit codes: 0 ok, 1 usage/resolution error.
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger, routeAllOutputToStderr } from './lib/Logger.js';
import { nativeChildReader } from './lib/orchestration/epic-container.js';
import { expandEpicIds } from './lib/orchestration/epic-expansion.js';
import {
  buildStoriesEnvelope,
  isSatisfiedBlocker,
  parseIds,
  readNativeBlockedBy,
  toStoryRecord,
} from './lib/orchestration/resolve-stories.js';
import { createProvider } from './lib/provider-factory.js';
import { concurrentMap } from './lib/util/concurrent-map.js';
import { paginateRest } from './providers/github/request-helpers.js';

export {
  buildStoriesEnvelope,
  // Re-exported, not redefined: expansion and the Epic rollup must share one
  // reader or an Epic becomes expandable but unclosable.
  nativeChildReader,
  parseIds,
  readNativeBlockedBy,
  toStoryRecord,
};

/** Modest enough for GitHub's secondary rate limits. */
const FETCH_CONCURRENCY = 5;

const HELP = `\
Usage:
  resolve-stories.js --ids <n,n,...> [--pretty] [--no-native]

Resolve Story ids into the { stories, dag, done } envelope /mandrel-deliver sequences
from. Dependencies are discovered from live state: body edges union native
blocked_by edges, with every blocker (in-set or foreign) resolved against its
real issue state.

Options:
  --ids <csv>    Comma-separated Story issue numbers. Required. A token may be
                 a single id (4922) or an inclusive dash range (4922-4926);
                 ranges expand in place and dedupe against the rest. A
                 container Epic id expands to its open child Stories, and may
                 be mixed with Story ids.
  --pretty       Pretty-print the JSON envelope.
  --no-native    Skip the native blocked_by read (body edges only).
  --allow-unlabelled
                 Resolve a Story carrying no agent::* label. Without it such a
                 Story is refused: the audit sweep files Stories without one on
                 purpose, and delivering one means dispatching a worker at
                 unenriched audit prose. Route it through /mandrel-plan first.
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
 * Container Epics expand to their open child Stories first; fails on the
 * first id that is not a deliverable Story.
 *
 * @param {object} provider
 * @param {number[]} ids
 * @param {{ allowUnlabelled?: boolean }} [options]
 * @returns {Promise<object[]>}
 */
export async function fetchStories(provider, ids, { allowUnlabelled } = {}) {
  const { ids: resolvedIds, expansions } = await expandEpicIds({
    ids,
    getTicket: (id) => provider.getTicket(id),
    readNativeChildIds: nativeChildReader(provider),
    warn: (m) => Logger.warn(m),
  });

  for (const { epicId, childIds } of expansions) {
    Logger.info(
      `[resolve-stories] Epic #${epicId} → ${childIds.length} open Story(ies): ` +
        childIds.map((c) => `#${c}`).join(', '),
    );
  }

  return concurrentMap(
    resolvedIds,
    async (id) => {
      const issue = await provider.getTicket(id);
      if (!issue) {
        throw new Error(`[resolve-stories] Issue #${id} was not found.`);
      }
      return toStoryRecord(issue, id, { allowUnlabelled });
    },
    { concurrency: FETCH_CONCURRENCY },
  );
}

/**
 * `paginate` must walk every page; stopping at one silently drops gates.
 *
 * @returns {Promise<Map<number, number[]>>}
 */
export async function readNativeEdges({
  provider,
  stories,
  owner,
  repo,
  paginate = paginateRest,
  warn = (m) => Logger.warn(m),
}) {
  const entries = await concurrentMap(
    stories,
    async (story) => [
      story.id,
      await readNativeBlockedBy({
        gh: provider._gh,
        owner,
        repo,
        issueNumber: story.id,
        paginate,
        warn,
      }),
    ],
    { concurrency: FETCH_CONCURRENCY },
  );
  return new Map(entries);
}

/**
 * A landed foreign blocker must enter `done[]` or its dependent waits forever;
 * an unreadable one stays out (unknown means still gating).
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

/**
 * @param {{ ids: string, native?: boolean, pretty?: boolean,
 *   allowUnlabelled?: boolean }} args
 * @param {{ provider: object, config: object, stdout?: { write(s: string): void } }} deps
 * @returns {Promise<number>}
 */
export async function runResolveStories(
  { ids: rawIds, native = true, pretty = false, allowUnlabelled = false },
  { provider, config, stdout = process.stdout },
) {
  const ids = parseIds(rawIds);
  const owner = config.github?.owner;
  const repo = config.github?.repo;

  const stories = await fetchStories(provider, ids, { allowUnlabelled });
  const nativeEdges = native
    ? await readNativeEdges({ provider, stories, owner, repo })
    : new Map();

  const inSetIds = new Set(stories.map((s) => s.id));
  const provisional = buildStoriesEnvelope({
    stories,
    nativeEdges,
    warn: (m) => Logger.warn(m),
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
  });

  stdout.write(
    pretty
      ? `${JSON.stringify(envelope, null, 2)}\n`
      : `${JSON.stringify(envelope)}\n`,
  );
  return 0;
}

/**
 * @param {Record<string, unknown>} values
 * @returns {{ ids: string, native: boolean, pretty: boolean, allowUnlabelled: boolean }}
 */
function toRunOptions(values) {
  return {
    ids: values.ids,
    native: values.native,
    pretty: values.pretty,
    allowUnlabelled: values['allow-unlabelled'],
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      ids: { type: 'string' },
      pretty: { type: 'boolean', default: false },
      native: { type: 'boolean', default: true },
      'allow-unlabelled': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    // Required for `--no-native` to parse.
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

  // stdout is a JSON stream.
  routeAllOutputToStderr();

  return runResolveStories(toRunOptions(values), resolveStoriesProvider());
}

runAsCli(import.meta.url, main, {
  source: 'resolve-stories',
  propagateExitCode: true,
  usage: HELP,
});
