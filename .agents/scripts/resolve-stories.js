#!/usr/bin/env node

/**
 * resolve-stories.js — resolve a list of Story ids into the
 * `{ stories, dag, done }` envelope `/mandrel-deliver` sequences from.
 *
 * This is the ONE resolution step for multi-Story delivery. `/mandrel-deliver` takes
 * only Story ids; the graph is discovered here, from live state, rather than
 * hand-transcribed by the host or implied by a batch label.
 *
 * What it resolves, per Story:
 *   - the issue itself, fetched with **state=all** so an already-landed
 *     sibling is present rather than silently dropped;
 *   - its dependency edges: the union of the body's `---` footer
 *     (`blocked by #N`, footer-scoped and strict — prose mentioning a blocker
 *     elsewhere in the body declares nothing) and native GitHub `blocked_by`
 *     edges, read to exhaustion and failing loud rather than degrading to
 *     "no edges";
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
import { resolveEpicNodeId } from './lib/orchestration/epic-container.js';
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
 * Read an Epic's native sub-issue children as issue numbers.
 *
 * Injected into `expandEpicIds` so the lib layer stays provider-agnostic,
 * exactly as `paginate` is injected into `readNativeBlockedBy`. A provider
 * without the GraphQL surface yields `[]`, and the Epic body's checklist
 * carries the children on its own — as does an Epic carrying no resolvable
 * node id, which `resolveEpicNodeId` reports rather than letting an
 * `undefined` reach the API as a rejected `ID!` variable.
 *
 * @param {object} provider
 * @returns {(epic: object) => Promise<number[]>}
 */
export function nativeChildReader(provider) {
  return async (epic) => {
    const nodeId = resolveEpicNodeId(epic);
    if (nodeId === null) return [];
    return (
      provider?._getNativeSubIssues?.(nodeId, epic?.number ?? epic?.id) ?? []
    );
  };
}

/**
 * Fetch every requested id and map it to a Story record, failing on the first
 * id that is not a deliverable Story.
 *
 * Container Epics are expanded to their open child Stories **first**, so
 * everything downstream sees a plain Story-id list (Story #5139). The
 * expansion walk is sequential because it is id-by-id conditional; the Story
 * fetch that follows stays under the bounded concurrency.
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
 * Read native blocked_by edges for every Story in the set.
 *
 * `paginate` is injected rather than imported inside the lib layer so
 * `readNativeBlockedBy` stays provider-agnostic and unit-testable; production
 * passes `paginateRest`, which walks every page (the read used to stop at the
 * first, silently truncating a Story's gates — Story #5046).
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

/**
 * Resolve the requested ids into the `{ stories, dag, done }` envelope and
 * write it to `stdout`. The flow core behind `main` — provider, config, and
 * stdout are injected so the whole path is unit-testable without a live
 * GitHub round-trip. Exported for testing.
 *
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
 * Project the parsed flags onto the flow core's options object, so `main` reads
 * as parse → help → run and the flag-name spellings live in one place.
 *
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

  return runResolveStories(toRunOptions(values), resolveStoriesProvider());
}

runAsCli(import.meta.url, main, {
  source: 'resolve-stories',
  propagateExitCode: true,
  usage: HELP,
});
