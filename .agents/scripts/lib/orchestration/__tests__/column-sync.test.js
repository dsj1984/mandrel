/**
 * column-sync — on-disk board-metadata cache tests (Story #4252).
 *
 * The companion behavioural suite for `columnForLabels` / `ColumnSync.sync` /
 * `readCurrentColumn` lives at `tests/lib/orchestration/column-sync.test.js`.
 * This file is the test home the Story's `verify[]` command names and is
 * scoped to the disk-cache contract: warm-cache collapses a flip to ~1
 * GraphQL call, the cache is keyed by `owner/projectNumber` under `tempRoot`,
 * it carries a TTL, and it is invalidated on a GraphQL mutation error so a
 * mid-run board reconfiguration self-heals.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ColumnSync } from '../column-sync.js';
import {
  DEFAULT_META_TTL_MS,
  projectMetaCachePath,
  readProjectMetaCache,
  writeProjectMetaCache,
} from '../project-meta-cache.js';

/**
 * A fresh isolated tempRoot per test so the on-disk cache never bleeds
 * across cases (or into the repo's real `temp/`). Returned as a config bag
 * shaped like the resolved config (`project.paths.tempRoot`). The absolute
 * path is honoured verbatim by the temp-paths anchor.
 */
function makeTempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandrel-pmcache-'));
  return { dir, config: { project: { paths: { tempRoot: dir } } } };
}

/**
 * A provider whose `graphql` records every call and answers the three query
 * shapes ColumnSync issues: the board-metadata resolve, the by-issue
 * projectItems lookup, and the Status mutation. `onMutate` lets a test make
 * the mutation throw to exercise invalidate-on-error.
 */
function recordingProvider({ onMutate } = {}) {
  const graphqlCalls = [];
  const provider = {
    graphqlCalls,
    projectNumber: 42,
    owner: 'acme',
    repo: 'widgets',
    async graphql(query, vars) {
      graphqlCalls.push({ query, vars });
      if (
        query.includes('projectV2(number') &&
        !query.includes('projectItems')
      ) {
        return {
          viewer: {
            projectV2: {
              id: 'PROJ',
              field: {
                id: 'FIELD',
                options: [
                  { id: 'opt-todo', name: 'Todo' },
                  { id: 'opt-inprog', name: 'In Progress' },
                  { id: 'opt-done', name: 'Done' },
                ],
              },
            },
          },
        };
      }
      if (query.includes('projectItems(first')) {
        return {
          repository: {
            issue: {
              projectItems: {
                nodes: [{ id: 'ITEM-1', project: { id: 'PROJ' } }],
              },
            },
          },
        };
      }
      if (query.includes('updateProjectV2ItemFieldValue')) {
        if (onMutate) onMutate();
        return {
          updateProjectV2ItemFieldValue: { projectV2Item: { id: vars.itemId } },
        };
      }
      return {};
    },
  };
  return provider;
}

const countResolveCalls = (provider) =>
  provider.graphqlCalls.filter(
    (c) =>
      c.query.includes('projectV2(number') && !c.query.includes('projectItems'),
  ).length;
const countItemLookups = (provider) =>
  provider.graphqlCalls.filter((c) => c.query.includes('projectItems(first'))
    .length;
const countMutations = (provider) =>
  provider.graphqlCalls.filter((c) =>
    c.query.includes('updateProjectV2ItemFieldValue'),
  ).length;

describe('project-meta disk cache (Story #4252)', () => {
  let tmp;

  beforeEach(() => {
    tmp = makeTempConfig();
  });

  afterEach(() => {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('persists { projectId, fieldId, options } keyed by owner/projectNumber under tempRoot', async () => {
    const provider = recordingProvider();
    const sync = new ColumnSync({ provider, config: tmp.config });
    await sync.sync(321, ['agent::executing']);

    const cacheFile = projectMetaCachePath(tmp.config);
    // The cache file lives under the resolved tempRoot.
    assert.ok(
      cacheFile.startsWith(tmp.dir),
      `cache file ${cacheFile} should live under tempRoot ${tmp.dir}`,
    );
    assert.ok(fs.existsSync(cacheFile), 'cache file was written');

    const store = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const entry = store['acme/42'];
    assert.ok(entry, 'cache is keyed by owner/projectNumber');
    assert.equal(entry.projectId, 'PROJ');
    assert.equal(entry.fieldId, 'FIELD');
    assert.deepEqual(entry.options, {
      Todo: 'opt-todo',
      'In Progress': 'opt-inprog',
      Done: 'opt-done',
    });
    assert.equal(typeof entry.cachedAt, 'number');
  });

  it('warm cache collapses a label flip to ~1 GraphQL call (the mutation)', async () => {
    // Cold process #1: full resolve + item lookup + mutation = 3 calls.
    const cold = recordingProvider();
    const coldSync = new ColumnSync({ provider: cold, config: tmp.config });
    const coldRes = await coldSync.sync(321, ['agent::executing']);
    assert.equal(coldRes.status, 'synced');
    assert.ok(countResolveCalls(cold) >= 1, 'cold resolve happened');
    assert.equal(countMutations(cold), 1);

    // Cold process #2: a *new* ColumnSync (empty in-process cache, as a
    // separate CLI process would have) reads the metadata from disk and
    // skips the resolve entirely. The only metadata-shaped call left is the
    // by-issue item lookup; the mutation is the single board-state write.
    const warm = recordingProvider();
    const warmSync = new ColumnSync({ provider: warm, config: tmp.config });
    const warmRes = await warmSync.sync(321, ['agent::executing']);
    assert.equal(warmRes.status, 'synced');

    assert.equal(
      countResolveCalls(warm),
      0,
      'warm cache skips resolveProjectMeta (the ~2 metadata round-trips)',
    );
    assert.equal(countMutations(warm), 1, 'still issues exactly the mutation');
    // ~1 GraphQL call: the mutation. (An item-id lookup is still needed to
    // address the per-issue project item; it is not board metadata and is
    // out of scope per the Story.)
    assert.equal(countItemLookups(warm), 1, 'one item-id lookup, no resolve');
  });

  it('treats an expired entry as a miss and re-resolves (TTL)', async () => {
    // Seed a stale entry well outside the TTL window.
    writeProjectMetaCache({
      owner: 'acme',
      projectNumber: 42,
      meta: {
        projectId: 'STALE',
        fieldId: 'STALE',
        options: new Map([['In Progress', 'stale-opt']]),
      },
      config: tmp.config,
      now: Date.now() - (DEFAULT_META_TTL_MS + 60_000),
    });

    const provider = recordingProvider();
    const sync = new ColumnSync({ provider, config: tmp.config });
    const res = await sync.sync(321, ['agent::executing']);
    assert.equal(res.status, 'synced');
    // Expired → resolve fired again and the live projectId was used.
    assert.ok(
      countResolveCalls(provider) >= 1,
      'expired entry forced a re-resolve',
    );
    const mutation = provider.graphqlCalls.find((c) =>
      c.query.includes('updateProjectV2ItemFieldValue'),
    );
    assert.equal(
      mutation.vars.projectId,
      'PROJ',
      'used freshly-resolved board id',
    );
  });

  it('invalidates the disk cache on a GraphQL mutation error so the next flip re-resolves', async () => {
    // Warm the cache from a clean process.
    const warmProvider = recordingProvider();
    await new ColumnSync({ provider: warmProvider, config: tmp.config }).sync(
      321,
      ['agent::executing'],
    );
    assert.ok(
      readProjectMetaCache({
        owner: 'acme',
        projectNumber: 42,
        config: tmp.config,
      }),
    );

    // Next cold process reads the warm cache, but the mutation fails (e.g.
    // the board was reconfigured and the cached optionId is now invalid).
    const failingProvider = recordingProvider({
      onMutate() {
        throw new Error('board reconfigured');
      },
    });
    const failingSync = new ColumnSync({
      provider: failingProvider,
      config: tmp.config,
      logger: { warn: () => {} },
    });
    await assert.rejects(
      () => failingSync.sync(321, ['agent::executing']),
      /board reconfigured/,
    );

    // The error invalidated the cache entry — the next flip will re-resolve.
    assert.equal(
      readProjectMetaCache({
        owner: 'acme',
        projectNumber: 42,
        config: tmp.config,
      }),
      null,
      'cache entry was invalidated after the mutation error',
    );

    // Prove self-heal: a fresh process now re-resolves against the live board.
    const healed = recordingProvider();
    const healedRes = await new ColumnSync({
      provider: healed,
      config: tmp.config,
    }).sync(321, ['agent::executing']);
    assert.equal(healedRes.status, 'synced');
    assert.ok(countResolveCalls(healed) >= 1, 'self-healed by re-resolving');
  });

  it('does not invalidate the cache when the failing meta was freshly resolved (cold miss)', async () => {
    // No warm entry: the mutation error is transient/live, not a stale-cache
    // problem, so the just-written cache entry must survive.
    const provider = recordingProvider({
      onMutate() {
        throw new Error('transient API blip');
      },
    });
    const sync = new ColumnSync({
      provider,
      config: tmp.config,
      logger: { warn: () => {} },
    });
    await assert.rejects(
      () => sync.sync(321, ['agent::executing']),
      /transient API blip/,
    );
    // The resolve still wrote the cache; a transient mutation failure must
    // not discard freshly-resolved, valid metadata.
    assert.ok(
      readProjectMetaCache({
        owner: 'acme',
        projectNumber: 42,
        config: tmp.config,
      }),
      'fresh-resolve cache entry survives a transient mutation error',
    );
  });
});
