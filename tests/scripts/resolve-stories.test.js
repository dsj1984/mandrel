/**
 * tests/scripts/resolve-stories.test.js — Story #4540.
 *
 * `/deliver` takes only Story ids; this resolver discovers the graph from
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
  selectReadySet,
  storiesOverlap,
} from '../../.agents/scripts/lib/wave-runner/ready-set.js';
import { parseDag } from '../../.agents/scripts/stories-wave-tick.js';

const REPO = { owner: 'dsj1984', repo: 'mandrel', issueNumber: 4534 };

/**
 * Stand-in sensitive-path manifest for the dispatchMode shape derivation —
 * injected so no test reads the repo's live `audit-rules.json` (whose
 * operator-editable globs would otherwise decide these assertions).
 */
const RULES = {
  sensitivePaths: {
    security: { filePatterns: ['**/auth/**'] },
  },
};

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

function issue(over = {}) {
  return {
    number: 101,
    title: 'A Story',
    body: storyBody(),
    labels: [{ name: 'type::story' }],
    state: 'open',
    ...over,
  };
}

describe('toStoryRecord — an id-scoped fetch errors rather than filtering', () => {
  it('maps a well-formed Story issue', () => {
    const rec = toStoryRecord(issue());
    assert.equal(rec.id, 101);
    assert.equal(rec.state, 'open');
    assert.deepEqual(rec.labels, ['type::story']);
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
      injectedRules: RULES,
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

  it('rejects a cross-repo blocker rather than matching its number locally', () => {
    assert.throws(
      () =>
        nativeBlockedByNumbers(
          [
            {
              id: 1,
              number: 4530,
              repository_url: 'https://api.github.com/repos/other/repo',
            },
          ],
          REPO,
        ),
      /another repository/,
    );
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
  const parseJson = (r) => JSON.parse(r.stdout);

  it('returns the edges on success', async () => {
    const gh = {
      api: async () => ({ stdout: JSON.stringify([{ id: 9, number: 42 }]) }),
    };
    assert.deepEqual(
      await readNativeBlockedBy({ gh, ...REPO, parseJson }),
      [42],
    );
  });

  it('treats 404 as a legitimate empty result', async () => {
    const gh = {
      api: async () => {
        throw new Error('HTTP 404: Not Found');
      },
    };
    assert.deepEqual(await readNativeBlockedBy({ gh, ...REPO, parseJson }), []);
  });

  it('throws on 403 — a dropped edge would remove a real dispatch gate', async () => {
    // One 403 (dependencies API disabled, or a token missing the scope)
    // would otherwise erase EVERY native edge at once and co-dispatch the
    // whole run against unlanded blockers.
    const gh = {
      api: async () => {
        throw new Error('HTTP 403: Resource not accessible by integration');
      },
    };
    await assert.rejects(
      () => readNativeBlockedBy({ gh, ...REPO, parseJson }),
      /Refusing to continue.*dispatch gate/s,
    );
  });

  it('throws on a 5xx rather than degrading to no edges', async () => {
    const gh = {
      api: async () => {
        throw new Error('HTTP 502: Bad Gateway');
      },
    };
    await assert.rejects(
      () => readNativeBlockedBy({ gh, ...REPO, parseJson }),
      /Could not read native blocked_by/,
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

describe('buildStoriesEnvelope — per-Story dispatchMode (Story #4722)', () => {
  it('AC-5: derives inline from the BODY shape with the route::lite label absent', () => {
    // One refactor + one acceptance criterion, no sensitive path: a
    // lite-shaped body. No label anywhere — the shape is the control signal.
    const env = buildStoriesEnvelope({
      stories: [toStoryRecord(issue({ number: 1 }))],
      injectedRules: RULES,
    });
    assert.equal(env.stories[0].dispatchMode, 'inline');
  });

  it('AC-4/AC-5: the route::lite label never routes — a full-shaped body dispatches subagent', () => {
    const wide = storyBody({
      changes: ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js'],
    });
    const env = buildStoriesEnvelope({
      stories: [
        toStoryRecord(
          issue({
            number: 1,
            body: wide,
            labels: [{ name: 'type::story' }, { name: 'route::lite' }],
          }),
        ),
      ],
      injectedRules: RULES,
    });
    assert.equal(env.stories[0].dispatchMode, 'subagent');
  });

  it('AC-6: a sensitive-path footprint dispatches subagent even at lite width', () => {
    const env = buildStoriesEnvelope({
      stories: [
        toStoryRecord(
          issue({
            number: 1,
            body: storyBody({ changes: ['src/auth/session.js'] }),
            labels: [{ name: 'type::story' }, { name: 'route::lite' }],
          }),
        ),
      ],
      injectedRules: RULES,
    });
    assert.equal(env.stories[0].dispatchMode, 'subagent');
  });

  it('planning.complexityGate.enabled=false forces subagent dispatch', () => {
    const env = buildStoriesEnvelope({
      stories: [toStoryRecord(issue({ number: 1 }))],
      config: { planning: { complexityGate: { enabled: false } } },
      injectedRules: RULES,
    });
    assert.equal(env.stories[0].dispatchMode, 'subagent');
  });
});

describe('buildStoriesEnvelope — done[] is what unlocks cross-run delivery', () => {
  it('reports an in-set landed Story as done', () => {
    const env = buildStoriesEnvelope({
      stories: [
        toStoryRecord(issue({ number: 1, state: 'closed' })),
        toStoryRecord(issue({ number: 2 })),
      ],
      injectedRules: RULES,
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
      injectedRules: RULES,
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
      injectedRules: RULES,
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
    const ready = selectReadySet({
      stories: [unknown, other],
      doneIds: new Set(),
      inFlight: 0,
      globalCap: 5,
    }).map((s) => s.id);
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
