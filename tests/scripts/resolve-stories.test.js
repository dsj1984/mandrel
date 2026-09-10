/**
 * tests/scripts/resolve-stories.test.js — Story #4540.
 *
 * `/mandrel-deliver` takes only Story ids; this resolver discovers the graph from
 * live state. Three of these tests pin defects a pre-mortem caught before
 * implementation — each would have shipped as a silent wedge or an
 * immediate crash:
 *
 *   1. `dag[].files` MUST be plain strings. `extractChangePaths` returns
 *      `{path, isGlob}` objects and `parseDag` rejects non-strings, so
 *      forwarding it verbatim fails every multi-Story run.
 *   2. The native-edge read MUST emit issue NUMBERS. The write path's
 *      helper returns database ids (its POST needs `issue_id`); reusing it
 *      builds an unsatisfiable dependency and wedges the run forever.
 *   3. The read MUST fail loud. A dropped read-side edge silently removes a
 *      dispatch gate — the inverse of the write path, where degrading is safe.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildStoriesEnvelope,
  isSatisfiedBlocker,
  nativeBlockedByNumbers,
  parseIds,
  readNativeBlockedBy,
  storiesToDag,
  storyFootprintPaths,
  toStoryRecord,
} from '../../.agents/scripts/lib/orchestration/resolve-stories.js';
import {
  planReadySet,
  storiesOverlap,
} from '../../.agents/scripts/lib/wave-runner/ready-set.js';
import { TRANSIENT_RETRY_DEFAULTS } from '../../.agents/scripts/providers/github/errors.js';
import { paginateRest } from '../../.agents/scripts/providers/github/request-helpers.js';
import {
  readNativeEdges,
  runResolveStories,
} from '../../.agents/scripts/resolve-stories.js';
import { parseDag } from '../../.agents/scripts/stories-wave-tick.js';

const REPO = { owner: 'dsj1984', repo: 'mandrel', issueNumber: 4534 };

/**
 * The retry seam `paginateRest` already exposes, wired to a no-op clock.
 *
 * `paginateRest` wraps every page GET in `withTransientRetry`, whose
 * production defaults are six attempts of jittered exponential backoff
 * (0.5s → 8s, ~16s in total). A fixture that throws `HTTP 502` — a
 * deliberately transient shape — therefore made this file *wait* 16 seconds
 * to assert a message, holding a test-runner worker slot the whole time.
 * Injecting `sleep` through the seam keeps the attempt count, the ordering
 * and the final throw identical, and drops the wall time to nothing. The
 * production backoff is untouched: this is a test clock, not a new default.
 */
const NO_SLEEP = Object.freeze({ sleep: async () => {}, random: () => 0 });

/** `paginateRest` on the injected clock, recording each retry it performs. */
function makeFastPaginate() {
  const retries = [];
  const paginate = (gh, endpoint, opts = {}) =>
    paginateRest(gh, endpoint, {
      ...opts,
      retry: NO_SLEEP,
      onRetry: (info) => retries.push(info),
    });
  return { paginate, retries };
}

/** Sugar for the many call sites that never exercise the retry path. */
const fastPaginate = makeFastPaginate().paginate;

/**
 * A `gh` fake for the dependencies endpoint that honours `page` / `per_page`
 * the way GitHub does — including the default page size of **30** when the
 * caller does not ask for one. Modelling that default is the whole point: it
 * is the boundary the first-page-only read silently truncated against.
 *
 * @param {object[]} edges Full edge list the endpoint would serve.
 * @param {{ failWith?: string }} [opts] Throw this message instead of serving.
 */
function makeDependenciesGh(edges, { failWith = null } = {}) {
  const calls = [];
  return {
    calls,
    api: async ({ endpoint }) => {
      calls.push(endpoint);
      if (failWith) throw new Error(failWith);
      const params = new URL(endpoint, 'https://api.github.test').searchParams;
      const page = Number(params.get('page') ?? 1);
      const perPage = Number(params.get('per_page') ?? 30);
      const slice = edges.slice((page - 1) * perPage, page * perPage);
      return { stdout: JSON.stringify(slice), stderr: '', code: 0 };
    },
  };
}

function storyBody({
  changes = ['.agents/scripts/a.js'],
  blockedBy = null,
} = {}) {
  const lines = [
    '## Goal',
    'Do the thing.',
    '',
    '## Changes',
    ...changes.map(
      (p) => `- {"path":"${p}","assumption":"refactors-existing"}`,
    ),
    '',
    '## Acceptance',
    '- [ ] it works',
    '',
    '## Verify',
    '- npm test (unit)',
  ];
  if (blockedBy) lines.push('', '---', `blocked by #${blockedBy}`);
  return lines.join('\n');
}

// A deliverable Story carries a lifecycle label: `/mandrel-plan` applies one at the
// end of planning, and the resolver now refuses a Story that has none (Story
// #5281). The fixture carries `agent::ready` so every case below tests what it
// says it tests rather than the guard.
function issue(over = {}) {
  return {
    number: 101,
    title: 'A Story',
    body: storyBody(),
    labels: [{ name: 'type::story' }, { name: 'agent::ready' }],
    state: 'open',
    ...over,
  };
}

describe('toStoryRecord — an id-scoped fetch errors rather than filtering', () => {
  it('maps a well-formed Story issue', () => {
    const rec = toStoryRecord(issue());
    assert.equal(rec.id, 101);
    assert.equal(rec.state, 'open');
    assert.deepEqual(rec.labels, ['type::story', 'agent::ready']);
  });

  it('hard-errors on a non-Story instead of silently dropping it', () => {
    // The label-scoped ancestor returned null here, which is right for
    // incidental query noise and wrong when the operator NAMED this id:
    // dropping it yields a partial envelope that under-delivers silently.
    assert.throws(
      () => toStoryRecord(issue({ labels: [] }), 101),
      /#101 is not a Story .*type::story tickets only/s,
    );
  });

  it('hard-errors on a surviving Epic footer, naming the Epic', () => {
    assert.throws(
      () => toStoryRecord(issue({ body: 'Epic: #4200\n\n## Goal\nx' })),
      /Epic: #4200.*Story-only/s,
    );
  });

  it('does not mistake prose mentioning an epic for a footer', () => {
    const rec = toStoryRecord(
      issue({
        body: `${storyBody()}\n\nThis relates to an Epic: #4200 loosely.`,
      }),
    );
    assert.equal(rec.id, 101);
  });
});

describe('isSatisfiedBlocker — what stops gating', () => {
  it('a closed issue is satisfied', () => {
    assert.equal(isSatisfiedBlocker({ state: 'closed', labels: [] }), true);
  });
  it('an open agent::done issue is satisfied', () => {
    assert.equal(
      isSatisfiedBlocker({ state: 'open', labels: [{ name: 'agent::done' }] }),
      true,
    );
  });
  it('an open in-progress issue still gates', () => {
    assert.equal(
      isSatisfiedBlocker({
        state: 'open',
        labels: [{ name: 'agent::executing' }],
      }),
      false,
    );
  });
});

describe('storyFootprintPaths — plain strings, never a crash', () => {
  it('emits plain path strings, not {path,isGlob} objects', () => {
    const paths = storyFootprintPaths(
      storyBody({ changes: ['a/b.js', 'c/d.js'] }),
      1,
    );
    assert.deepEqual(paths, ['a/b.js', 'c/d.js']);
    assert.ok(paths.every((p) => typeof p === 'string'));
  });

  it('never throws on an unparseable body — one bad body must not fail the whole resolution', () => {
    // These are live, human-editable issue bodies. (What it returns on that
    // path is the fail-safe contract asserted further down.)
    const warnings = [];
    assert.doesNotThrow(() =>
      storyFootprintPaths(
        '## Changes\n- a plain string bullet, not the object shape',
        7,
        (m) => warnings.push(m),
      ),
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /#7/);
  });
});

describe('the resolver envelope composes with the scheduler adapter', () => {
  it('parseDag accepts the resolver output verbatim (run-breaker #1)', () => {
    const env = buildStoriesEnvelope({
      stories: [toStoryRecord(issue())],
    });
    assert.ok(env.dag[0].files.every((f) => typeof f === 'string'));
    const { nodes, error } = parseDag(env.dag);
    assert.equal(
      error,
      null,
      'the two CLIs must compose; a {path,isGlob} footprint fails every N>1 run',
    );
    assert.equal(nodes[0].id, 101);
  });
});

describe('nativeBlockedByNumbers — issue numbers, not database ids (run-breaker #2)', () => {
  it('emits the issue number when id and number differ', () => {
    // The live shape observed on #4534 → #4530.
    const data = [
      {
        id: 4902374986,
        number: 4530,
        state: 'closed',
        repository_url: 'https://api.github.com/repos/dsj1984/mandrel',
      },
    ];
    assert.deepEqual(nativeBlockedByNumbers(data, REPO), [4530]);
  });

  it('drops a cross-repo blocker rather than matching its number locally', () => {
    // Matching another repo's #4530 against this repo's #4530 could satisfy a
    // gate that is still open — so the edge is dropped, loudly, never mapped.
    const warnings = [];
    assert.deepEqual(
      nativeBlockedByNumbers(
        [
          {
            id: 1,
            number: 4530,
            repository_url: 'https://api.github.com/repos/other/repo',
          },
          { id: 2, number: 4531 },
        ],
        { ...REPO, warn: (m) => warnings.push(m) },
      ),
      [4531],
      'the in-repo edge survives; only the unmatchable one is dropped',
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /another repository/);
    assert.match(warnings[0], /#4534/, 'the warning names the affected Story');
  });

  it('dedupes and tolerates a non-array payload', () => {
    assert.deepEqual(nativeBlockedByNumbers(null, REPO), []);
    assert.deepEqual(
      nativeBlockedByNumbers([{ number: 5 }, { number: 5 }], REPO),
      [5],
    );
  });
});

describe('readNativeBlockedBy — fails loud (run-breaker #3)', () => {
  it('returns the edges on success', async () => {
    const gh = makeDependenciesGh([{ id: 9, number: 42 }]);
    assert.deepEqual(
      await readNativeBlockedBy({ gh, ...REPO, paginate: fastPaginate }),
      [42],
    );
  });

  it('throws on 403 — a dropped edge would remove a real dispatch gate', async () => {
    // One 403 (dependencies API disabled, or a token missing the scope)
    // would otherwise erase EVERY native edge at once and co-dispatch the
    // whole run against unlanded blockers.
    const gh = makeDependenciesGh([], {
      failWith: 'HTTP 403: Resource not accessible by integration',
    });
    await assert.rejects(
      () => readNativeBlockedBy({ gh, ...REPO, paginate: fastPaginate }),
      /Refusing to continue.*dispatch gate/s,
    );
  });

  it('throws on a 5xx rather than degrading to no edges — after exhausting the shared retry', async () => {
    // A 502 is classified transient, so the read is *retried* before it is
    // allowed to fail. Both halves matter: the attempt count proves the
    // shared backoff still runs, and the throw proves an exhausted retry
    // never degrades into "this Story has no blockers".
    const gh = makeDependenciesGh([], { failWith: 'HTTP 502: Bad Gateway' });
    const { paginate, retries } = makeFastPaginate();
    await assert.rejects(
      () => readNativeBlockedBy({ gh, ...REPO, paginate }),
      /Could not read native blocked_by/,
    );
    assert.equal(
      retries.length,
      TRANSIENT_RETRY_DEFAULTS.maxAttempts - 1,
      'every transient attempt but the last is retried',
    );
    assert.equal(
      gh.calls.length,
      TRANSIENT_RETRY_DEFAULTS.maxAttempts,
      'the endpoint is hit once per attempt',
    );
  });
});

describe('AC-2: a 404 on the native read is an auth failure, not "no edges"', () => {
  // GitHub answers "this issue has no dependencies" with `200 []` — and
  // answers "your token cannot see the dependencies API" with 404. Reading
  // the second as the first erased every native edge in the run under a
  // mis-scoped token, silently, with a clean exit code (Story #5046).
  it('the read no longer resolves edge-free on 404 — it degrades loud, naming the story', async () => {
    const gh = makeDependenciesGh([], { failWith: 'HTTP 404: Not Found' });
    await assert.rejects(
      () => readNativeBlockedBy({ gh, ...REPO, paginate: fastPaginate }),
      (err) => {
        assert.match(
          err.message,
          new RegExp(`blocked_by edges for #${REPO.issueNumber}`),
          'the failure names the story whose edges could not be read',
        );
        assert.match(
          err.message,
          /404 here is NOT "no dependencies"/,
          'the failure explains why a 404 is not an empty result',
        );
        assert.match(err.message, /token's scopes/);
        return true;
      },
    );
  });

  it('an issue that genuinely has no dependencies still resolves to no edges', async () => {
    // The 200-empty path is what "no dependencies" looks like, so removing
    // the 404 escape hatch costs nothing legitimate.
    const gh = makeDependenciesGh([]);
    assert.deepEqual(
      await readNativeBlockedBy({ gh, ...REPO, paginate: fastPaginate }),
      [],
    );
  });
});

describe('AC-1: native reads are complete — the page walk runs to exhaustion', () => {
  // The fake models GitHub's real default: a caller that does not ask for a
  // page size gets 30 items. That default is exactly what the first-page-only
  // read silently truncated against.
  const manyEdges = Array.from({ length: 145 }, (_, i) => ({
    id: 9000 + i,
    number: 4000 + i,
  }));

  it('resolve-stories reads every edge of a 145-edge story, past the 30-item default', async () => {
    const gh = makeDependenciesGh(manyEdges);
    const numbers = await readNativeBlockedBy({
      gh,
      ...REPO,
      paginate: fastPaginate,
    });
    assert.equal(numbers.length, 145, 'no edge is dropped past the boundary');
    assert.deepEqual(
      numbers,
      manyEdges.map((e) => e.number),
      'every declared blocker is present, in order',
    );
    assert.ok(
      numbers.includes(4144),
      'the last edge — the one a first-page-only read loses — is a real gate',
    );
    assert.ok(gh.calls.length > 1, 'more than one page was requested');
  });

  it('a first-page-only read would have lost the tail — the fixture proves the defect is real', async () => {
    // Same fixture, read the way the shipped code used to: one un-paged GET.
    const gh = makeDependenciesGh(manyEdges);
    const firstPageOnly = async (ghFacade, endpoint) => {
      const result = await ghFacade.api({ method: 'GET', endpoint });
      return JSON.parse(result.stdout);
    };
    const truncated = await readNativeBlockedBy({
      gh,
      ...REPO,
      paginate: firstPageOnly,
    });
    assert.equal(
      truncated.length,
      30,
      'the old read stopped at GitHub default',
    );
    assert.equal(
      truncated.includes(4144),
      false,
      'and silently dropped a real dispatch gate',
    );
  });
});

describe('storiesToDag — body and native edges union into one graph', () => {
  it('unions native edges with body-parsed ones', () => {
    const stories = [
      toStoryRecord(issue({ body: storyBody({ blockedBy: 55 }) })),
    ];
    const dag = storiesToDag(stories, new Map([[101, [66]]]));
    assert.deepEqual(
      dag[0].dependsOn.sort((a, b) => a - b),
      [55, 66],
    );
  });

  it('keeps a foreign edge as a real gate (dropForeign:false)', () => {
    const stories = [
      toStoryRecord(issue({ body: storyBody({ blockedBy: 4530 }) })),
    ];
    const dag = storiesToDag(stories);
    assert.deepEqual(dag[0].dependsOn, [4530]);
  });
});

describe('AC-4: prose no longer mints dispatch gates — only the footer declares', () => {
  // The live reproduction this Story shipped from: Story #5046's own body
  // contained the phrase "blocked by #123" inside an acceptance criterion
  // describing this very defect, and the unanchored whole-body scan minted it
  // into a real dispatch edge (`resolve-stories --ids 5046` reported
  // `dependsOn [123]`). A body is prose an operator writes; it must not gate
  // dispatch by accident.
  const prose = [
    'Prose that merely MENTIONS a blocker declares nothing:',
    'a body containing "blocked by #123" outside the footer block must',
    'produce no dispatch edge. Nor may a sentence that depends on #456.',
  ].join('\n');

  it('a "blocked by #123" mention outside the footer produces no edge', () => {
    const stories = [
      toStoryRecord(issue({ body: `${storyBody()}\n\n${prose}` })),
    ];
    assert.deepEqual(
      storiesToDag(stories)[0].dependsOn,
      [],
      'prose mentioning #123 and #456 declares neither as a gate',
    );
  });

  it('the canonical footer form still declares a real gate', () => {
    const stories = [
      toStoryRecord(issue({ body: storyBody({ blockedBy: 777 }) })),
    ];
    assert.deepEqual(storiesToDag(stories)[0].dependsOn, [777]);
  });

  it('one body carrying both keeps only the footer edge', () => {
    // The discriminator is position, not phrasing: the same words gate from
    // inside the footer block and do not gate from outside it.
    const stories = [
      toStoryRecord(
        issue({ body: `${storyBody({ blockedBy: 777 })}\n${prose}` }),
      ),
    ];
    assert.deepEqual(storiesToDag(stories)[0].dependsOn, [777]);
  });

  it('a footer edge still unions with the native channel', () => {
    // Semantics stay the UNION of native relations and body footers — the
    // strict parse narrows the body channel, it does not replace it.
    const stories = [
      toStoryRecord(
        issue({ body: `${storyBody({ blockedBy: 777 })}\n${prose}` }),
      ),
    ];
    const dag = storiesToDag(stories, new Map([[101, [888]]]));
    assert.deepEqual(
      dag[0].dependsOn.sort((a, b) => a - b),
      [777, 888],
    );
  });

  it('end to end: the resolved envelope carries no prose edge', async () => {
    const provider = {
      getTicket: async (id) =>
        id === 101 ? issue({ body: `${storyBody()}\n\n${prose}` }) : null,
      _gh: makeDependenciesGh([]),
    };
    const chunks = [];
    await runResolveStories(
      { ids: '101', native: false },
      {
        provider,
        config: { github: { owner: 'dsj1984', repo: 'mandrel' } },
        stdout: { write: (s) => chunks.push(s) },
      },
    );
    const envelope = JSON.parse(chunks.join(''));
    assert.deepEqual(envelope.dag.find((n) => n.id === 101).dependsOn, []);
    assert.deepEqual(envelope.done, [], 'no phantom blocker to resolve either');
  });
});

describe('AC-3: a cross-repo edge degrades its own Story, never the whole set', () => {
  // It used to throw out of the per-Story read and take the entire resolution
  // down: one Story's unsupported edge meant no sibling resolved at all.
  const CROSS_REPO = {
    id: 1,
    number: 4530,
    repository_url: 'https://api.github.com/repos/other/repo',
  };

  function providerServing(byIssue) {
    return {
      _gh: {
        api: async ({ endpoint }) => {
          const issueNumber = Number(endpoint.match(/\/issues\/(\d+)\//)[1]);
          const params = new URL(endpoint, 'https://api.github.test')
            .searchParams;
          const page = Number(params.get('page') ?? 1);
          const perPage = Number(params.get('per_page') ?? 30);
          const all = byIssue[issueNumber] ?? [];
          return {
            stdout: JSON.stringify(
              all.slice((page - 1) * perPage, page * perPage),
            ),
            stderr: '',
            code: 0,
          };
        },
      },
    };
  }

  it('the carrier loses only the unmatchable edge; its siblings resolve intact', async () => {
    const warnings = [];
    const edges = await readNativeEdges({
      provider: providerServing({
        101: [CROSS_REPO, { id: 2, number: 4531 }],
        102: [{ id: 3, number: 4532 }],
        103: [],
      }),
      stories: [{ id: 101 }, { id: 102 }, { id: 103 }],
      owner: 'dsj1984',
      repo: 'mandrel',
      paginate: fastPaginate,
      warn: (m) => warnings.push(m),
    });

    assert.deepEqual(
      edges.get(101),
      [4531],
      'the carrier keeps every edge this repo can match',
    );
    assert.deepEqual(edges.get(102), [4532], 'a sibling resolves untouched');
    assert.deepEqual(edges.get(103), [], 'and so does an edge-free sibling');
    assert.equal(warnings.length, 1, 'exactly one Story degraded');
    assert.match(warnings[0], /#101/, 'the warning names the degraded Story');
    assert.match(warnings[0], /DROPPED for #101 only/);
  });

  it('a hard read failure on one Story still fails the run — a lost gate is not degradable', async () => {
    // The contrast that keeps the degrade honest: an unmatchable cross-repo
    // edge is a KNOWN edge we decline to map, while an unreadable channel is
    // an UNKNOWN edge set. Only the first is safe to continue past.
    const provider = {
      _gh: {
        api: async () => {
          throw new Error('HTTP 403: Resource not accessible by integration');
        },
      },
    };
    await assert.rejects(
      () =>
        readNativeEdges({
          provider,
          stories: [{ id: 101 }],
          owner: 'dsj1984',
          repo: 'mandrel',
          paginate: fastPaginate,
          warn: () => {},
        }),
      /Refusing to continue/,
    );
  });
});

describe('buildStoriesEnvelope — per-Story dispatchMode (Story #4722)', () => {
  // Story #4736 put a run-topology rule ahead of the shape read, and Story
  // #5006 removed the shape read entirely: `resolveStoryDispatchMode` sees
  // only the resolved set size. Every assertion below therefore pins the ONE
  // remaining axis — a sibling in the set — against the inputs that used to
  // move the verdict and no longer can.
  const filler = () =>
    toStoryRecord(
      issue({ number: 99, body: storyBody({ changes: ['src/filler.js'] }) }),
    );

  it('AC-5: a lite-shaped body in a multi-Story set dispatches subagent (#4829)', () => {
    // One refactor + one acceptance criterion, no sensitive path: a
    // lite-shaped body — which USED to come back `inline` here. It cannot:
    // `inline` means the router's own session, and this set has a sibling that
    // may be dispatched on the same beat.
    const env = buildStoriesEnvelope({
      stories: [toStoryRecord(issue({ number: 1 })), filler()],
    });
    assert.equal(env.stories[0].dispatchMode, 'subagent');
  });

  it('AC-4/AC-5: the route::lite label never routes — it is not even read', () => {
    // Full-shaped by EFFORT since Story #4764 (two deployables), carrying the
    // lite hint label. Neither input reaches the dispatch decision.
    const wide = storyBody({
      changes: ['apps/api/src/a.js', 'apps/web/src/b.js'],
    });
    const env = buildStoriesEnvelope({
      stories: [
        toStoryRecord(
          issue({
            number: 1,
            body: wide,
            labels: [
              { name: 'type::story' },
              { name: 'agent::ready' },
              { name: 'route::lite' },
            ],
          }),
        ),
        filler(),
      ],
    });
    assert.equal(env.stories[0].dispatchMode, 'subagent');
  });

  it('a Story body the resolver cannot parse still gets a mode', () => {
    // Dispatch no longer parses the body, so an unparseable one cannot make
    // the resolver throw or degrade — it is simply irrelevant.
    const env = buildStoriesEnvelope({
      stories: [
        toStoryRecord(issue({ number: 1, body: 'not a story body at all' })),
        filler(),
      ],
    });
    assert.equal(env.stories[0].dispatchMode, 'subagent');
  });
});

/**
 * Story #4736 — the resolver is where `/mandrel-deliver` reads the dispatch decision,
 * so this is where the run-topology rule has to be true end to end: a
 * one-Story `--ids` list yields `inline`, and adding a sibling puts the shape
 * axis back in charge.
 */
describe('buildStoriesEnvelope — single-Story runs dispatch inline (Story #4736)', () => {
  // Full-shaped by effort (two deployables), not by file count — Story #4764.
  const wideBody = storyBody({
    changes: ['apps/api/src/a.js', 'apps/web/src/b.js'],
  });

  it('AC-1: a one-Story run is inline even for a full-shaped Story', () => {
    const env = buildStoriesEnvelope({
      stories: [toStoryRecord(issue({ number: 1, body: wideBody }))],
    });
    assert.equal(env.stories.length, 1);
    assert.equal(env.stories[0].dispatchMode, 'inline');
  });

  it('AC-1: the same Story in a two-Story run goes back to sub-agent dispatch', () => {
    const env = buildStoriesEnvelope({
      stories: [
        toStoryRecord(issue({ number: 1, body: wideBody })),
        toStoryRecord(issue({ number: 2, body: wideBody })),
      ],
    });
    assert.deepEqual(
      env.stories.map((s) => s.dispatchMode),
      ['subagent', 'subagent'],
      'concurrent siblings share a checkout — that is what the sub-agent isolates',
    );
  });

  it('counts the resolved set, not the undelivered remainder', () => {
    // A sibling that already landed still counts: the mode a caller reads for
    // a given `--ids` list must not flip mid-run as siblings finish.
    const env = buildStoriesEnvelope({
      stories: [
        toStoryRecord(issue({ number: 1, body: wideBody })),
        toStoryRecord(
          issue({
            number: 2,
            body: wideBody,
            state: 'closed',
            labels: [{ name: 'type::story' }, { name: 'agent::done' }],
          }),
        ),
      ],
    });
    assert.equal(env.stories[0].dispatchMode, 'subagent');
  });
});

/**
 * Story #4829 — the resolver's dispatch modes and the wave tick's ready set
 * are two answers to one run, and they must not contradict each other.
 *
 * Measured twice on 2026-07-29 (`/mandrel-deliver 4824 4825`, `/mandrel-deliver 4828 4829
 * 4830`): every Story resolved `inline` while the tick reported the whole set
 * ready under a cap of five. `inline` means the router's own session, so that
 * pair of answers instructs one session to run two — then three — engines over
 * one checkout. This asserts them TOGETHER, from one envelope, because
 * asserting either alone is exactly how the contradiction survived.
 */
describe('buildStoriesEnvelope ↔ ready set — one run, one consistent answer', () => {
  /** A lite-shaped body per Story, with a disjoint footprint so the
   *  overlap guard never masks the result by serialising the beat itself. */
  const liteStory = (number) =>
    toStoryRecord(
      issue({
        number,
        body: storyBody({ changes: [`src/feature-${number}.js`] }),
      }),
    );

  for (const ids of [
    [4824, 4825],
    [4828, 4829, 4830],
  ]) {
    it(`the measured ${ids.length}-Story run: no Story claims the session the tick fans out from`, () => {
      const stories = ids.map(liteStory);
      const env = buildStoriesEnvelope({ stories });

      // The tick's view of the same run: every Story ready, cap 5 — the
      // reported condition, reproduced rather than assumed.
      const ready = planReadySet({
        stories: stories.map((s) => ({
          id: s.id,
          dependsOn: [],
          files: [`src/feature-${s.id}.js`],
        })),
        doneIds: new Set(),
        inFlight: 0,
        globalCap: 5,
      }).selected.map((s) => s.id);
      assert.deepEqual(ready, ids, 'the measured ready set must reproduce');

      const inline = env.stories.filter((s) => s.dispatchMode === 'inline');
      assert.deepEqual(
        inline,
        [],
        `${ready.length} Stories are dispatchable on one beat, so none of them may be told to run in the router's single session`,
      );
    });
  }

  it('a one-Story run keeps inline — and its ready set is the one Story', () => {
    const stories = [liteStory(4829)];
    const env = buildStoriesEnvelope({ stories });
    const ready = planReadySet({
      stories: [{ id: 4829, dependsOn: [], files: ['src/feature-4829.js'] }],
      doneIds: new Set(),
      inFlight: 0,
      globalCap: 5,
    }).selected;
    assert.equal(ready.length, 1);
    assert.equal(
      env.stories[0].dispatchMode,
      'inline',
      'a ready set of one and an inline verdict agree — that is the rule being preserved, not narrowed',
    );
  });
});

describe('buildStoriesEnvelope — done[] is what unlocks cross-run delivery', () => {
  it('reports an in-set landed Story as done', () => {
    const env = buildStoriesEnvelope({
      stories: [
        toStoryRecord(issue({ number: 1, state: 'closed' })),
        toStoryRecord(issue({ number: 2 })),
      ],
    });
    assert.deepEqual(env.done, [1]);
  });

  it('folds a foreign landed blocker into done[] so its dependent becomes ready', () => {
    // The headline capability: #4530 landed in a DIFFERENT plan run. Without
    // this, its dependent is withheld forever — the wedge that made
    // cross-run, over-time delivery structurally impossible.
    const stories = [
      toStoryRecord(
        issue({ number: 4534, body: storyBody({ blockedBy: 4530 }) }),
      ),
    ];
    const env = buildStoriesEnvelope({
      stories,
      foreignDone: [4530],
    });
    assert.deepEqual(env.dag[0].dependsOn, [4530]);
    assert.deepEqual(env.done, [4530]);
  });

  it('sorts stories and done for a stable envelope', () => {
    const env = buildStoriesEnvelope({
      stories: [
        toStoryRecord(issue({ number: 9, state: 'closed' })),
        toStoryRecord(issue({ number: 3, state: 'closed' })),
      ],
    });
    assert.deepEqual(
      env.stories.map((s) => s.id),
      [3, 9],
    );
    assert.deepEqual(env.done, [3, 9]);
  });
});

describe('parseIds', () => {
  it('parses and dedupes a csv', () => {
    assert.deepEqual(parseIds('101, 102,101'), [101, 102]);
  });
  it('rejects a non-numeric id', () => {
    assert.throws(() => parseIds('101,abc'), /positive issue numbers/);
  });
  it('rejects an empty list', () => {
    assert.throws(() => parseIds(''), /--ids is required/);
  });
  it('expands an inclusive dash range, as the operator types it', () => {
    assert.deepEqual(parseIds('4922-4925'), [4922, 4923, 4924, 4925]);
    assert.deepEqual(parseIds('4922 - 4924'), [4922, 4923, 4924]);
  });
  it('dedupes a range against the singles around it', () => {
    assert.deepEqual(parseIds('4920,4922-4924,4923'), [4920, 4922, 4923, 4924]);
  });
  it('rejects a backwards range instead of resolving nothing', () => {
    assert.throws(() => parseIds('4926-4922'), /low-to-high/);
  });
  it('names the caller flag in the error, so --stories does not report --ids', () => {
    assert.throws(() => parseIds('abc', '--stories'), /--stories must be/);
    assert.throws(() => parseIds('', '--stories'), /--stories is required/);
  });
});

describe('storyFootprintPaths — an unreadable footprint fails SAFE, not open', () => {
  it('an unparseable body yields a glob footprint, so the Story is never co-dispatched', () => {
    // Returning [] here would be fail-OPEN: the guard reads an empty
    // footprint as "overlaps nothing" and never withholds, so a Story whose
    // changes we could not read would silently race a genuine conflict.
    // Unknown width is not no width — the same argument that makes a glob
    // overlap everything applies to a body we failed to parse.
    const warnings = [];
    const paths = storyFootprintPaths(
      '## Changes\n- a plain string bullet, not the {path, assumption} shape',
      7,
      (m) => warnings.push(m),
    );
    assert.deepEqual(paths, ['**']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /#7/);
    assert.match(warnings[0], /unknown/i);
  });

  it('the unknown footprint actually withholds the Story from co-dispatch', () => {
    const unreadable =
      '## Changes\n- a plain string bullet, not the object shape';
    const unknown = {
      id: 1,
      dependsOn: [],
      files: storyFootprintPaths(unreadable, 1),
    };
    const other = { id: 2, dependsOn: [], files: ['docs/README.md'] };
    assert.equal(storiesOverlap(unknown, other), true);
    const ready = planReadySet({
      stories: [unknown, other],
      doneIds: new Set(),
      inFlight: 0,
      globalCap: 5,
    }).selected.map((s) => s.id);
    assert.deepEqual(ready, [1], 'the unreadable Story takes the beat alone');
  });

  it('a Story that genuinely declares NO changes keeps the permissive empty footprint', () => {
    // "Declares nothing" and "we could not read it" are different facts.
    // Withholding on the former would serialize every run.
    const body = [
      '## Goal',
      'g',
      '',
      '## Acceptance',
      '- [ ] a',
      '',
      '## Verify',
      '- npm test (unit)',
    ].join('\n');
    assert.deepEqual(storyFootprintPaths(body, 1), []);
  });
});

describe('runResolveStories — the injectable CLI flow core (Story #4842)', () => {
  const CONFIG = { github: { owner: 'dsj1984', repo: 'mandrel' } };

  function makeProvider(byId) {
    return {
      getTicket: async (id) => byId[id] ?? null,
      // readNativeEdges reaches gh through this seam; an empty payload
      // exercises the native branch without shape assumptions.
      _gh: { api: async () => ({ stdout: '[]' }) },
    };
  }

  function capture() {
    const chunks = [];
    return { write: (s) => chunks.push(s), text: () => chunks.join('') };
  }

  it('writes the compact single-line envelope with a trailing newline', async () => {
    const provider = makeProvider({
      101: issue(),
      102: issue({ number: 102, body: storyBody({ blockedBy: 101 }) }),
    });
    const out = capture();
    const code = await runResolveStories(
      { ids: '101,102', native: false },
      { provider, config: CONFIG, stdout: out },
    );
    assert.equal(code, 0);
    const text = out.text();
    assert.ok(text.endsWith('\n'), 'envelope line is newline-terminated');
    assert.equal(
      text.trimEnd().includes('\n'),
      false,
      'compact mode emits exactly one stdout line',
    );
    const envelope = JSON.parse(text);
    assert.equal(envelope.kind, 'stories');
    assert.deepEqual(
      envelope.stories.map((s) => s.id),
      [101, 102],
    );
    const node = envelope.dag.find((n) => n.id === 102);
    assert.deepEqual(node.dependsOn, [101]);
    assert.deepEqual(envelope.done, []);
  });

  it('pretty-prints the same envelope when asked', async () => {
    const provider = makeProvider({ 101: issue() });
    const out = capture();
    await runResolveStories(
      { ids: '101', native: false, pretty: true },
      { provider, config: CONFIG, stdout: out },
    );
    const text = out.text();
    assert.ok(text.includes('\n  '), 'pretty mode indents');
    assert.equal(JSON.parse(text).kind, 'stories');
  });

  it('a closed foreign blocker lands in done[]', async () => {
    const provider = makeProvider({
      101: issue({ body: storyBody({ blockedBy: 4000 }) }),
      4000: issue({ number: 4000, state: 'closed' }),
    });
    const out = capture();
    await runResolveStories(
      { ids: '101', native: false },
      { provider, config: CONFIG, stdout: out },
    );
    const envelope = JSON.parse(out.text());
    assert.deepEqual(envelope.done, [4000]);
  });

  it('reads native edges through the injected provider gh seam', async () => {
    const provider = makeProvider({ 101: issue() });
    const out = capture();
    await runResolveStories(
      { ids: '101' },
      { provider, config: CONFIG, stdout: out },
    );
    const envelope = JSON.parse(out.text());
    assert.deepEqual(envelope.dag.find((n) => n.id === 101).dependsOn, []);
  });
});

// --- Story #5281: an unenriched audit Story is not dispatchable --------------

describe('the agent::* dispatch guard', () => {
  it('refuses a Story with no agent::* label, naming the enrich step', () => {
    assert.throws(
      () => toStoryRecord(issue({ labels: [{ name: 'type::story' }] }), 101),
      (err) => {
        assert.match(err.message, /#101 carries no "agent::\*" label/);
        assert.match(err.message, /Enrich before you deliver/);
        assert.match(err.message, /\/mandrel-plan/);
        assert.match(err.message, /--allow-unlabelled/);
        return true;
      },
    );
  });

  it('proceeds under --allow-unlabelled', () => {
    const rec = toStoryRecord(
      issue({ labels: [{ name: 'type::story' }, { name: 'audit::security' }] }),
      101,
      { allowUnlabelled: true },
    );
    assert.equal(rec.id, 101);
    assert.deepEqual(rec.labels, ['type::story', 'audit::security']);
  });

  it('accepts any agent::* state, not only agent::ready', () => {
    for (const state of ['agent::executing', 'agent::blocked', 'agent::done']) {
      const rec = toStoryRecord(
        issue({ labels: [{ name: 'type::story' }, { name: state }] }),
      );
      assert.ok(rec.labels.includes(state));
    }
  });

  it('the CLI exits non-zero for an unlabelled Story and proceeds with the flag', async () => {
    const unlabelled = {
      number: 101,
      title: 'Audit finding',
      body: storyBody(),
      labels: [{ name: 'type::story' }, { name: 'audit::quality' }],
      state: 'open',
    };
    const provider = { getTicket: async () => unlabelled };
    const config = { github: { owner: 'o', repo: 'r' } };
    const stdout = { write: () => {} };

    await assert.rejects(
      runResolveStories(
        { ids: '101', native: false },
        { provider, config, stdout },
      ),
      /carries no "agent::\*" label/,
    );

    const written = [];
    await runResolveStories(
      { ids: '101', native: false, allowUnlabelled: true },
      { provider, config, stdout: { write: (s) => written.push(s) } },
    );
    assert.equal(JSON.parse(written.join('')).stories[0].id, 101);
  });
});
