import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT_LABELS } from '../../.agents/scripts/lib/label-constants.js';
import {
  classifyStory,
  selectReadySet,
  storiesOverlap,
  storyFootprint,
  storyIdOf,
} from '../../.agents/scripts/lib/wave-runner/ready-set.js';

/**
 * Convenience factory for a Story record. `dependsOn` feeds the explicit
 * dependency-field arm of `buildStoryAdjacency`; `files` feeds the
 * footprint extractor.
 */
function story(id, { labels = [], state = 'open', dependsOn, files } = {}) {
  const rec = { id, labels, state };
  if (dependsOn !== undefined) rec.dependsOn = dependsOn;
  if (files !== undefined) rec.files = files;
  return rec;
}

const ids = (recs) => recs.map((r) => r.id).sort((a, b) => a - b);

describe('lib/wave-runner/ready-set — storyIdOf', () => {
  it('reads the ticket `id` shape and the GitHub `number` shape', () => {
    assert.equal(storyIdOf({ id: 7 }), 7);
    assert.equal(storyIdOf({ number: 9 }), 9);
    assert.equal(storyIdOf(11), 11);
  });

  it('returns null for absent / non-positive / non-integer ids', () => {
    assert.equal(storyIdOf({}), null);
    assert.equal(storyIdOf({ id: 0 }), null);
    assert.equal(storyIdOf({ id: -3 }), null);
    assert.equal(storyIdOf({ id: 'abc' }), null);
  });
});

describe('lib/wave-runner/ready-set — classifyStory', () => {
  it('classifies done via the agent::done label', () => {
    assert.equal(
      classifyStory(story(1, { labels: [AGENT_LABELS.DONE] })),
      'done',
    );
  });

  it('classifies done via a closed issue even without the label', () => {
    assert.equal(
      classifyStory(story(1, { labels: [], state: 'closed' })),
      'done',
    );
  });

  it('lets done win over a stale executing label', () => {
    assert.equal(
      classifyStory(
        story(1, { labels: [AGENT_LABELS.EXECUTING], state: 'closed' }),
      ),
      'done',
    );
  });

  it('classifies blocked', () => {
    assert.equal(
      classifyStory(story(1, { labels: [AGENT_LABELS.BLOCKED] })),
      'blocked',
    );
  });

  it('classifies executing for both executing and closing labels', () => {
    assert.equal(
      classifyStory(story(1, { labels: [AGENT_LABELS.EXECUTING] })),
      'executing',
    );
    assert.equal(
      classifyStory(story(1, { labels: [AGENT_LABELS.CLOSING] })),
      'executing',
    );
  });

  it('classifies an unlabelled open Story as ready', () => {
    assert.equal(classifyStory(story(1)), 'ready');
  });
});

describe('lib/wave-runner/ready-set — storyFootprint & storiesOverlap', () => {
  it('reads the string-array `files` shape', () => {
    const fp = storyFootprint({ files: ['a.js', 'b.js'] });
    assert.deepEqual([...fp].sort(), ['a.js', 'b.js']);
  });

  it('reads the object-array `{ path }` shape and trims/drops blanks', () => {
    const fp = storyFootprint({
      changes: [{ path: ' lib/x.js ' }, { path: '' }, 'lib/y.js', 42],
    });
    assert.deepEqual([...fp].sort(), ['lib/x.js', 'lib/y.js']);
  });

  it('overlaps when footprints share a path', () => {
    assert.equal(
      storiesOverlap({ files: ['a.js', 'b.js'] }, { files: ['b.js', 'c.js'] }),
      true,
    );
  });

  it('does not overlap on disjoint footprints', () => {
    assert.equal(
      storiesOverlap({ files: ['a.js'] }, { files: ['b.js'] }),
      false,
    );
  });

  it('treats an empty footprint on either side as no overlap', () => {
    assert.equal(storiesOverlap({ files: [] }, { files: ['b.js'] }), false);
    assert.equal(storiesOverlap({ files: ['a.js'] }, {}), false);
  });
});

describe('lib/wave-runner/ready-set — selectReadySet dependency gating', () => {
  // Acceptance: Given a graph where Story C depends only on Story A,
  // selectReadySet includes C as soon as A is in the done set, even when an
  // unrelated Story B is not in it. (No false barrier.)
  it('selects C (deps only on A) once A is done, while unrelated B is still pending', () => {
    const A = story(1, { labels: [AGENT_LABELS.DONE] });
    const B = story(2); // unrelated, not done, not a dependency of C
    const C = story(3, { dependsOn: [1] });

    const selected = selectReadySet({
      stories: [A, B, C],
      inFlight: 0,
      globalCap: 5,
    });

    // C must be present; A is done (not re-selected); B is independently ready.
    assert.ok(ids(selected).includes(3), 'C should be ready once A is done');
    assert.ok(!ids(selected).includes(1), 'done A is never re-selected');
    // The pending unrelated B must not act as a barrier for C.
    assert.deepEqual(ids(selected), [2, 3]);
  });

  it('withholds a Story until every dependency is in the done set', () => {
    const A = story(1, { labels: [AGENT_LABELS.DONE] });
    const B = story(2); // not done
    const C = story(3, { dependsOn: [1, 2] }); // needs BOTH A and B

    const selected = selectReadySet({
      stories: [A, B, C],
      inFlight: 0,
      globalCap: 5,
    });

    // C still blocked on B; only the independently-ready B is selected.
    assert.deepEqual(ids(selected), [2]);
  });

  it('honours caller-supplied doneIds in addition to live-done records', () => {
    // A is not in the record set at all; the caller asserts it is done.
    const C = story(3, { dependsOn: [1] });
    const selected = selectReadySet({
      stories: [C],
      doneIds: [1],
      inFlight: 0,
      globalCap: 5,
    });
    assert.deepEqual(ids(selected), [3]);
  });

  it('treats an absent (foreign, not-done) dependency as a barrier', () => {
    // C depends on 99, which is neither in the set nor in doneIds.
    const C = story(3, { dependsOn: [99] });
    const selected = selectReadySet({
      stories: [C],
      inFlight: 0,
      globalCap: 5,
    });
    assert.deepEqual(ids(selected), []);
  });

  it('never selects done / blocked / executing Stories', () => {
    const done = story(1, { labels: [AGENT_LABELS.DONE] });
    const blocked = story(2, { labels: [AGENT_LABELS.BLOCKED] });
    const executing = story(3, { labels: [AGENT_LABELS.EXECUTING] });
    const ready = story(4);

    const selected = selectReadySet({
      stories: [done, blocked, executing, ready],
      inFlight: 0,
      globalCap: 10,
    });
    assert.deepEqual(ids(selected), [4]);
  });
});

describe('lib/wave-runner/ready-set — selectReadySet dropForeign policy', () => {
  // The default (dropForeign:false) keeps a foreign dependency as a gate —
  // the standalone / operator-DAG contract (see the "absent foreign
  // dependency as a barrier" test above). The Epic path opts into
  // dropForeign:true so a `blocked by #N` whose target is out-of-scope (a
  // foreign id or a typo) is pruned rather than treated as a permanent
  // unsatisfiable gate that would silently strand the dependent.
  it('dropForeign:true prunes a foreign dependency so the dependent becomes schedulable', () => {
    const C = story(3, { dependsOn: [99] }); // 99 is not in scope
    const selected = selectReadySet({
      stories: [C],
      inFlight: 0,
      globalCap: 5,
      dropForeign: true,
    });
    assert.deepEqual(ids(selected), [3]);
  });

  it('dropForeign:true still gates on an IN-scope, not-done dependency', () => {
    // Pruning is limited to foreign edges — a sibling dependency that is in
    // scope and not yet done must still withhold the dependent.
    const A = story(1); // in scope, not done
    const C = story(3, { dependsOn: [1] });
    const selected = selectReadySet({
      stories: [A, C],
      inFlight: 0,
      globalCap: 5,
      dropForeign: true,
    });
    // Only the independently-ready A is selected; C waits on in-scope A.
    assert.deepEqual(ids(selected), [1]);
  });

  it('defaults to dropForeign:false — a foreign dependency stays a barrier', () => {
    const C = story(3, { dependsOn: [99] });
    const selected = selectReadySet({ stories: [C], globalCap: 5 });
    assert.deepEqual(ids(selected), []);
  });
});

describe('lib/wave-runner/ready-set — selectReadySet capacity', () => {
  // Acceptance: selectReadySet never returns more than (globalCap - inFlight).
  it('never returns more than globalCap - inFlight stories', () => {
    const stories = [story(1), story(2), story(3), story(4), story(5)];
    const selected = selectReadySet({
      stories,
      inFlight: 2,
      globalCap: 4,
    });
    // 4 - 2 = 2 slots; five are ready but only two may go.
    assert.equal(selected.length, 2);
    // Deterministic: lowest ids first.
    assert.deepEqual(ids(selected), [1, 2]);
  });

  it('returns an empty set when inFlight has saturated globalCap', () => {
    const stories = [story(1), story(2)];
    assert.deepEqual(
      selectReadySet({ stories, inFlight: 3, globalCap: 3 }),
      [],
    );
    assert.deepEqual(
      selectReadySet({ stories, inFlight: 5, globalCap: 3 }),
      [],
    );
  });

  it('returns an empty set for a non-positive or missing globalCap', () => {
    const stories = [story(1)];
    assert.deepEqual(selectReadySet({ stories, globalCap: 0 }), []);
    assert.deepEqual(selectReadySet({ stories }), []);
  });
});

describe('lib/wave-runner/ready-set — selectReadySet file-overlap guard', () => {
  // Acceptance: Two ready stories whose file footprints overlap are never
  // both returned in one dispatch set; one is withheld until the other clears.
  it('never returns two overlapping-footprint stories in one set', () => {
    const A = story(1, { files: ['lib/shared.js', 'lib/a.js'] });
    const B = story(2, { files: ['lib/shared.js', 'lib/b.js'] }); // overlaps A
    const C = story(3, { files: ['lib/c.js'] }); // disjoint

    const selected = selectReadySet({
      stories: [A, B, C],
      inFlight: 0,
      globalCap: 10,
    });

    const picked = ids(selected);
    // A (lowest id) is admitted; B is withheld for the overlap; C is disjoint.
    assert.deepEqual(picked, [1, 3]);
    // Assert the invariant directly: no two selected stories overlap.
    for (let i = 0; i < selected.length; i++) {
      for (let j = i + 1; j < selected.length; j++) {
        assert.equal(
          storiesOverlap(selected[i], selected[j]),
          false,
          `selected ${selected[i].id} and ${selected[j].id} must not overlap`,
        );
      }
    }
  });

  it('admits the withheld story on a later beat once its peer has cleared', () => {
    const A = story(1, { files: ['lib/shared.js'] });
    const B = story(2, { files: ['lib/shared.js'] });

    // Beat 1: A and B both ready & overlapping → only A goes.
    const beat1 = selectReadySet({
      stories: [A, B],
      inFlight: 0,
      globalCap: 10,
    });
    assert.deepEqual(ids(beat1), [1]);

    // Beat 2: A has closed (done); B is now free of its overlapping peer.
    const Adone = story(1, {
      labels: [AGENT_LABELS.DONE],
      files: ['lib/shared.js'],
    });
    const beat2 = selectReadySet({
      stories: [Adone, B],
      inFlight: 0,
      globalCap: 10,
    });
    assert.deepEqual(ids(beat2), [2]);
  });

  it('does not withhold stories that declare no footprint', () => {
    // Two footprint-less stories never collide → both selected.
    const A = story(1);
    const B = story(2);
    const selected = selectReadySet({
      stories: [A, B],
      inFlight: 0,
      globalCap: 10,
    });
    assert.deepEqual(ids(selected), [1, 2]);
  });
});

describe('lib/wave-runner/ready-set — selectReadySet edge cases', () => {
  it('returns an empty set for an empty / missing story list', () => {
    assert.deepEqual(selectReadySet({ stories: [], globalCap: 5 }), []);
    assert.deepEqual(selectReadySet({ globalCap: 5 }), []);
    assert.deepEqual(selectReadySet(), []);
  });
});

describe('storiesOverlap — glob footprints fail safe (Story #4540)', () => {
  const glob = { id: 1, dependsOn: [], files: ['.agents/scripts/lib/**'] };
  const exact = {
    id: 2,
    dependsOn: [],
    files: ['.agents/scripts/lib/story-adjacency.js'],
  };
  const unrelated = { id: 3, dependsOn: [], files: ['docs/README.md'] };

  it('a glob overlaps a path it would match — exact-string comparison missed this', () => {
    // storiesOverlap compares strings, so `lib/**` never equalled
    // `lib/story-adjacency.js` and the guard silently passed two Stories
    // that genuinely race the same file.
    assert.equal(storiesOverlap(glob, exact), true);
  });

  it('a glob overlaps everything — unknown width is not no width', () => {
    assert.equal(storiesOverlap(glob, unrelated), true);
    assert.equal(storiesOverlap(unrelated, glob), true);
  });

  it('exact footprints keep their precise semantics', () => {
    assert.equal(storiesOverlap(exact, unrelated), false);
    assert.equal(
      storiesOverlap(exact, { id: 4, files: [exact.files[0]] }),
      true,
    );
  });

  it('an undeclared footprint is still never withheld', () => {
    // Permissive by necessity: withholding on absence would serialize
    // every run, since most Stories declare nothing.
    assert.equal(storiesOverlap({ id: 5, files: [] }, glob), false);
    assert.equal(storiesOverlap(glob, { id: 5 }), false);
  });

  it('a glob-bearing Story is not co-dispatched with anything', () => {
    const ready = selectReadySet({
      stories: [glob, exact, unrelated],
      doneIds: new Set(),
      inFlight: 0,
      globalCap: 5,
    }).map((s) => s.id);
    assert.deepEqual(ready, [1], 'the glob Story takes the beat alone');
  });
});
