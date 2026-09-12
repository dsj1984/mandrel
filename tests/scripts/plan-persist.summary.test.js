/**
 * tests/scripts/plan-persist.summary.test.js
 *
 * Unit coverage for the `plan-summary` comment body.
 *
 * Story #4542 retired the risk/routing receipts this file used to pin (the
 * `- Risk: <level> · <gateDecision> (review routing: …)` line and the
 * acceptance auto-waiver line, #4496 fix 2). Nothing computes a risk level, a
 * gate decision, or an acceptance disposition at plan time any more, so
 * printing one would document a mechanism that does not run — the regression
 * guard below asserts exactly that. `--force-review` is the one review gate the
 * planner still carries, and the summary reports it as an explicit operator
 * receipt.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPlanSummaryCommentBody } from '../../.agents/scripts/lib/orchestration/plan-persist/summary.js';
import { predictWaveSerialisation } from '../../.agents/scripts/lib/orchestration/plan-persist/wave-serialisation.js';

const BASE = {
  epicId: 4242,
  ticketCount: 2,
  freshness: { stale: 0, ambiguous: 0 },
  healthcheck: { ok: true },
  waveTable: [
    { wave: 0, stories: [{ slug: 'a', title: 'A' }] },
    { wave: 1, stories: [{ slug: 'b', title: 'B' }] },
  ],
};

describe('plan-summary — review receipt (Story #4542)', () => {
  it('reports an operator-forced review stop', () => {
    const body = buildPlanSummaryCommentBody({ ...BASE, forceReview: true });
    const line = body.split('\n').find((l) => l.startsWith('- ⚠️ Review:'));
    assert.ok(line, `expected a review line:\n${body}`);
    assert.match(line, /--force-review/);
  });

  it('says nothing about review when the operator did not force one', () => {
    for (const args of [{ ...BASE }, { ...BASE, forceReview: false }]) {
      const body = buildPlanSummaryCommentBody(args);
      assert.doesNotMatch(body, /Review:/);
    }
  });

  it('never reports a risk level, gate decision, or acceptance disposition', () => {
    // The retired chain's receipts. Persist derives none of them, so the
    // summary must not claim any — a stale line here is exactly the
    // "documents a mechanism that does not run" defect #4542 removed.
    const body = buildPlanSummaryCommentBody({ ...BASE, forceReview: true });
    assert.doesNotMatch(body, /- Risk:/);
    assert.doesNotMatch(body, /gateDecision|review routing/i);
    assert.doesNotMatch(body, /acceptance disposition/i);
    assert.doesNotMatch(body, /auto-waived/i);
  });
});

describe('plan summary — names the exact deliver command (Story #4540)', () => {
  const base = {
    epicId: 101,
    ticketCount: 1,
    freshness: {},
    healthcheck: {},
    waveTable: [],
  };

  it('prints the literal ids for a multi-Story plan', () => {
    // This comment is posted to GitHub on every plan run, so it is the
    // operator's primary instruction. It used to end with
    // "/mandrel-deliver --run <planRunId> (N>1)" — a flag that no longer exists —
    // and to claim "Plan-run: single Story (default)" even for N=3.
    const body = buildPlanSummaryCommentBody({
      ...base,
      ticketCount: 3,
      stories: [
        { id: 4540, slug: 'a' },
        { id: 4541, slug: 'b' },
        { id: 4542, slug: 'c' },
      ],
    });
    assert.match(body, /\/mandrel-deliver 4540 4541 4542/);
  });

  it('never advertises the retired --run flag or a plan-run label', () => {
    const body = buildPlanSummaryCommentBody({
      ...base,
      stories: [{ id: 4540, slug: 'a' }],
    });
    assert.doesNotMatch(body, /--run/);
    assert.doesNotMatch(body, /plan-run/i);
    assert.doesNotMatch(body, /Plan-run: single Story/);
    assert.match(body, /\/mandrel-deliver 4540/);
  });

  it('falls back to a generic form when no story ids are supplied', () => {
    const body = buildPlanSummaryCommentBody(base);
    assert.match(body, /\/mandrel-deliver <storyId>/);
    assert.doesNotMatch(body, /--run/);
  });
});

describe('plan summary — findings persist beside the promise (Story #5045)', () => {
  const sharedEditor = (path, storySlugs) => ({
    kind: 'shared-editor',
    severity: 'soft',
    path,
    storySlugs,
  });

  it('renders shared-editor findings next to the wave table', () => {
    // The wave table promises "these run together"; the shared-editor pass
    // knows exactly where that promise breaks. Until now the promise was
    // posted and the caveat died on stderr.
    const body = buildPlanSummaryCommentBody({
      ...BASE,
      conflictFindings: [sharedEditor('lib/shared.js', ['a', 'b'])],
    });

    const lines = body.split('\n');
    const waveHeading = lines.findIndex((l) =>
      l.startsWith('#### Delivery order'),
    );
    const collisionHeading = lines.findIndex((l) =>
      l.includes('Known collisions'),
    );
    assert.ok(waveHeading >= 0, `expected a wave table:\n${body}`);
    assert.ok(
      collisionHeading > waveHeading,
      `expected collisions after the wave table:\n${body}`,
    );

    assert.match(body, /\| `lib\/shared\.js` \| `a`, `b` \|/);
    assert.match(body, /1 shared file\(s\)/);
  });

  it('names the knob that would turn the advisory into a refusal', () => {
    const body = buildPlanSummaryCommentBody({
      ...BASE,
      conflictFindings: [sharedEditor('lib/shared.js', ['a', 'b'])],
    });
    assert.match(body, /planning\.failOnSharedEditors/);
    assert.match(body, /off by default/);
  });

  it('renders one row per colliding path, ordered deterministically', () => {
    const body = buildPlanSummaryCommentBody({
      ...BASE,
      conflictFindings: [
        sharedEditor('lib/z.js', ['b', 'a']),
        sharedEditor('lib/a.js', ['a', 'b']),
      ],
    });
    const rows = body
      .split('\n')
      .filter((line) => line.startsWith('| `lib/'))
      .map((line) => line.split('|')[1].trim());
    assert.deepEqual(rows, ['`lib/a.js`', '`lib/z.js`']);
    assert.match(body, /2 shared file\(s\)/);
  });

  it('says nothing when the passes found no collision', () => {
    for (const conflictFindings of [
      null,
      undefined,
      [],
      // Other conflict kinds have their own remediation and are not a
      // parallelism caveat — only shared-editor belongs beside the table.
      [
        {
          kind: 'implicit-cross-story-dep',
          severity: 'soft',
          path: 'lib/x.js',
        },
      ],
    ]) {
      const body = buildPlanSummaryCommentBody({ ...BASE, conflictFindings });
      assert.doesNotMatch(body, /Known collisions/);
    }
  });
});

describe('plan-summary — predicted serialisation (Story #5265, narrowed by #5313)', () => {
  // The tick withholds on `detectCollision` over the DECLARED footprint, so
  // two same-wave Stories that both declare a path are one wave in the table
  // and two beats in reality. Persist runs that same exported predicate and
  // renders what it will do; a shared `## Verify` gate predicts nothing.
  const declaring = (slug, shared) => ({
    slug,
    title: slug,
    changes: [
      { path: `lib/${slug}.js`, assumption: 'refactors-existing' },
      { path: shared, assumption: 'refactors-existing' },
    ],
    body: `## Changes\n- \`lib/${slug}.js\`\n- \`${shared}\``,
  });
  const withVerify = (slug, gate) => ({
    slug,
    title: slug,
    changes: [{ path: `lib/${slug}.js`, assumption: 'refactors-existing' }],
    body: [
      `## Changes`,
      `- \`lib/${slug}.js\` — refactors-existing`,
      '',
      '## Verify',
      `- node ${gate} (validate)`,
    ].join('\n'),
  });

  const oneWave = (slugs) => [
    { wave: 0, stories: slugs.map((slug) => ({ slug, title: slug })) },
  ];

  it('AC-4: names every same-wave pair the guard would withhold', () => {
    const stories = [
      declaring('alpha', 'baselines/maintainability.json'),
      declaring('beta', 'baselines/maintainability.json'),
      // `gamma` shares no declared path, so it must NOT appear: a prediction
      // that names every pair is no prediction.
      withVerify('gamma', '.agents/scripts/check-baselines.js'),
    ];
    const waveTable = oneWave(['alpha', 'beta', 'gamma']);

    const collisions = predictWaveSerialisation(waveTable, stories);
    assert.equal(collisions.length, 1);
    assert.deepEqual(collisions[0].slugs, ['alpha', 'beta']);
    assert.deepEqual(collisions[0].paths, ['baselines/maintainability.json']);
    assert.equal(collisions[0].source, 'declared-overlap');
    assert.equal('attribution' in collisions[0], false);

    const body = buildPlanSummaryCommentBody({
      ...BASE,
      waveTable,
      waveCollisions: collisions,
    });
    assert.match(body, /Predicted serialisation \(1 same-order pair\(s\)\)/);
    assert.match(body, /`alpha` \+ `beta`/);
    assert.match(body, /maintainability\.json/);
    assert.match(body, /declared-overlap/);
    assert.doesNotMatch(body, /Scraped from|scraped-overlap/);
    const predicted = body.slice(body.indexOf('Predicted serialisation'));
    assert.doesNotMatch(predicted, /`gamma`/);
  });

  it('Story #5313: a shared ## Verify gate predicts no serialisation', () => {
    const collisions = predictWaveSerialisation(oneWave(['alpha', 'beta']), [
      withVerify('alpha', '.agents/scripts/check-baselines.js'),
      withVerify('beta', '.agents/scripts/check-baselines.js'),
    ]);
    assert.deepEqual(collisions, []);
  });

  it('never pairs Stories from different waves', () => {
    const stories = [
      withVerify('early', '.agents/scripts/check-baselines.js'),
      withVerify('late', '.agents/scripts/check-baselines.js'),
    ];
    const collisions = predictWaveSerialisation(
      [
        { wave: 0, stories: [{ slug: 'early', title: 'early' }] },
        { wave: 1, stories: [{ slug: 'late', title: 'late' }] },
      ],
      stories,
    );
    assert.deepEqual(collisions, []);
  });

  it('says nothing when no same-wave pair collides', () => {
    for (const waveCollisions of [null, undefined, []]) {
      const body = buildPlanSummaryCommentBody({ ...BASE, waveCollisions });
      assert.doesNotMatch(body, /Predicted serialisation/);
    }
  });

  it('tolerates a wave naming a slug the story set does not carry', () => {
    const collisions = predictWaveSerialisation(oneWave(['alpha', 'ghost']), [
      withVerify('alpha', '.agents/scripts/check-baselines.js'),
    ]);
    assert.deepEqual(collisions, []);
  });
});
