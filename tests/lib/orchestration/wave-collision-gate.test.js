/**
 * tests/lib/orchestration/wave-collision-gate.test.js — the split gate
 * (Story #5332).
 *
 * ADR `20260912-5312` deleted every numeric plan-time ceiling and left the
 * default-single policy enforced by prose plus an acceptance-partition check
 * that only refused byte-identical acceptance text across siblings. The gate
 * is now the dispatcher's own predicate: a draft of more than one Story with
 * any same-wave colliding pair is refused **before the first `createIssue`**,
 * naming each pair, its colliding paths and the remedy.
 *
 * Two tiers here, both load-bearing:
 *   - the pure refusal (`assertNoWaveCollisions`) — message shape, and the
 *     N=1 exemption that can never trip;
 *   - the wiring (`runPlanPersist --dry-run`) — that the refusal lands ahead
 *     of creation, so a refused draft leaves nothing live. A dry run creates
 *     nothing either way, so the assertion that matters is that the run
 *     *throws* and that a fake provider counting `createIssue` calls stays at
 *     zero on the ordered and single-Story drafts' write paths too.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runPlanPersist } from '../../../.agents/scripts/lib/orchestration/plan-persist/run-plan-persist.js';
import { assertNoWaveCollisions } from '../../../.agents/scripts/lib/orchestration/plan-persist/wave-collision-gate.js';
import { serialize } from '../../../.agents/scripts/lib/story-body/story-body.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

/** The path every fixture Story declares — it exists at `main`. */
const SHARED_PATH = 'tests/scripts/plan-persist.flat-stories.test.js';
const OTHER_PATH = 'tests/scripts/plan-persist.summary.test.js';

/**
 * A Story declaring exactly one `refactors-existing` path.
 *
 * @param {string} slug
 * @param {{ path?: string, depends_on?: string[] }} [args]
 */
function ticket(slug, { path = SHARED_PATH, depends_on = [] } = {}) {
  const acceptance = [`${slug} is delivered`];
  const verify = ['npm test'];
  return {
    slug,
    type: 'story',
    title: `Story ${slug}`,
    acceptance,
    verify,
    depends_on,
    body: serialize({
      goal: `Goal of ${slug}.`,
      changes: [{ path, assumption: 'refactors-existing' }],
      acceptance,
      verify,
    }),
  };
}

/** A provider that counts every issue it was asked to create. */
function countingProvider() {
  const created = [];
  let nextId = 7100;
  return {
    created,
    async createIssue({ title, body, labels }) {
      const id = nextId++;
      created.push({ id, title, body, labels: [...(labels ?? [])] });
      return { id, url: `https://example.test/${id}` };
    },
    async getTicket(id) {
      return { id, state: 'open', labels: [] };
    },
    async listIssuesByLabel() {
      return [];
    },
    async updateTicket() {},
    async getTicketComments() {
      return [];
    },
    async postComment() {
      return { id: 1 };
    },
  };
}

/** Per-test isolated tempRoot so plan-metrics never touch the shared ledger. */
function isolatedConfig() {
  return { project: { paths: { tempRoot: makeTempDir('wave-gate-') } } };
}

/**
 * Run persist over a draft, returning the thrown error (or `null`) plus the
 * provider so the caller can assert on what reached creation.
 *
 * @param {object[]} stories
 */
async function persist(stories) {
  const provider = countingProvider();
  let error = null;
  try {
    await runPlanPersist({
      provider,
      artifacts: { stories },
      config: isolatedConfig(),
      opts: { dryRun: true, skipCleanup: true },
    });
  } catch (err) {
    error = err;
  }
  return { error, provider };
}

/** A footprint-bearing record in the shape `assemblePlanStories` returns. */
function assembled(slug, path = SHARED_PATH) {
  return {
    slug,
    title: slug,
    body: `## Changes\n- \`${path}\` — refactors-existing`,
    bodyObject: { changes: [{ path, assumption: 'refactors-existing' }] },
  };
}

const oneWave = (...slugs) => [
  { wave: 0, stories: slugs.map((slug) => ({ slug, title: slug })) },
];

describe('assertNoWaveCollisions — the refusal (Story #5332 AC-4)', () => {
  it('refuses an N>1 draft, naming the pair, its paths and both remedies', () => {
    assert.throws(
      () =>
        assertNoWaveCollisions(oneWave('alpha', 'beta'), [
          assembled('alpha'),
          assembled('beta'),
        ]),
      (err) => {
        assert.match(err.message, /1 same-wave collision/);
        assert.match(err.message, /"alpha" \+ "beta"/);
        assert.match(
          err.message,
          new RegExp(SHARED_PATH.replace(/\./g, '\\.')),
        );
        assert.match(err.message, /merge each pair/i);
        assert.match(err.message, /depends_on/);
        return true;
      },
    );
  });

  it('reads the footprint an assembled Story carries in bodyObject', () => {
    // The production shape: `storyFootprint` looks for a top-level
    // `changes[]`, so without the reconciliation this gate would see an empty
    // footprint for every real Story and could never fire.
    assert.throws(() =>
      assertNoWaveCollisions(oneWave('alpha', 'beta'), [
        assembled('alpha'),
        assembled('beta'),
      ]),
    );
  });

  it('N=1 can never trip it, whatever the draft declares', () => {
    assert.deepEqual(
      assertNoWaveCollisions(oneWave('solo'), [assembled('solo')]),
      [],
    );
  });

  it('returns the computed collisions for the receipt when nothing collides', () => {
    assert.deepEqual(
      assertNoWaveCollisions(oneWave('alpha', 'beta'), [
        assembled('alpha'),
        assembled('beta', OTHER_PATH),
      ]),
      [],
    );
  });

  it('reads a runtime record top-level footprint untouched', () => {
    // `resolve-stories.js` records already carry `changes` at the top level —
    // and `files` / `changeset` are the other two shapes `storyFootprint`
    // accepts. None may be shadowed by the `bodyObject` fallback.
    const shapes = [
      { changes: [{ path: SHARED_PATH }] },
      { files: [SHARED_PATH] },
      { changeset: [{ path: SHARED_PATH }] },
    ];
    for (const shape of shapes) {
      assert.throws(
        () =>
          assertNoWaveCollisions(oneWave('alpha', 'beta'), [
            { slug: 'alpha', ...shape },
            { slug: 'beta', ...shape },
          ]),
        /same-wave collision/,
        `the ${Object.keys(shape)[0]} shape must be read as declared`,
      );
    }
  });

  it('tolerates a footprint-free draft and a malformed record', () => {
    // An empty footprint means "no known overlap" by `detectCollision`'s
    // contract, so a Story declaring nothing — or a record that is not an
    // object at all — is never withheld and never crashes the gate.
    assert.deepEqual(
      assertNoWaveCollisions(oneWave('alpha', 'beta'), [
        { slug: 'alpha', title: 'alpha' },
        { slug: 'beta', title: 'beta', bodyObject: {} },
      ]),
      [],
    );
    // A non-array `stories` degrades to an empty draft rather than throwing.
    assert.deepEqual(assertNoWaveCollisions([], 'not-an-array'), []);
  });

  it('names every colliding pair, not just the first', () => {
    const collisions = (() => {
      try {
        assertNoWaveCollisions(oneWave('a', 'b', 'c'), [
          assembled('a'),
          assembled('b'),
          assembled('c'),
        ]);
      } catch (err) {
        return err.message;
      }
      return null;
    })();
    assert.match(collisions, /3 same-wave collision/);
    for (const pair of ['"a" + "b"', '"a" + "c"', '"b" + "c"']) {
      assert.ok(collisions.includes(pair), `must name ${pair}`);
    }
  });

  it('never pairs Stories the wave table puts in different waves', () => {
    const table = [
      { wave: 0, stories: [{ slug: 'early', title: 'early' }] },
      { wave: 1, stories: [{ slug: 'late', title: 'late' }] },
    ];
    assert.deepEqual(
      assertNoWaveCollisions(table, [assembled('early'), assembled('late')]),
      [],
    );
  });
});

describe('runPlanPersist — the gate runs before the first create (AC-4)', () => {
  it('refuses two same-wave siblings that both declare one path', async () => {
    const { error, provider } = await persist([
      ticket('alpha'),
      ticket('beta'),
    ]);
    assert.ok(error, 'a colliding two-Story draft must be refused');
    assert.match(error.message, /same-wave collision/);
    assert.match(error.message, /"alpha" \+ "beta"/);
    assert.equal(
      provider.created.length,
      0,
      'nothing may reach createIssue on a refused draft',
    );
  });

  it('persists the same pair cleanly once depends_on orders it', async () => {
    const { error } = await persist([
      ticket('alpha'),
      ticket('beta', { depends_on: ['alpha'] }),
    ]);
    assert.equal(
      error,
      null,
      `an ordered pair must persist: ${error?.message ?? ''}`,
    );
  });

  it('persists two siblings that declare different paths', async () => {
    const { error } = await persist([
      ticket('alpha'),
      ticket('beta', { path: OTHER_PATH }),
    ]);
    assert.equal(
      error,
      null,
      `a non-colliding pair must persist: ${error?.message ?? ''}`,
    );
  });

  it('persists a single-Story draft', async () => {
    const { error } = await persist([ticket('solo')]);
    assert.equal(
      error,
      null,
      `the default-single path must persist: ${error?.message ?? ''}`,
    );
  });
});
