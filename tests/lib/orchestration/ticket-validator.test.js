import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  _internal,
  validateAndNormalizeTickets,
} from '../../../.agents/scripts/lib/orchestration/ticket-validator.js';

/**
 * Single-Story-Feature rejection (Story #3777).
 *
 * `assertNoSingleStoryFeature` is a deterministic, HARD invariant: a Feature
 * MUST decompose into at least two Stories. A Feature with a single Story is
 * the work of a Story, not a Feature — it signals decomposition at
 * module/task granularity rather than deliverable granularity. The check
 * throws (matching the surrounding `assertHierarchy` / `assertEachTypePresent`
 * style) and names the offending Feature so the planner can collapse it.
 *
 * 3-tier (Epic #3238): every Story carries its top-level inline contract
 * (`acceptance[]` + `verify[]`) plus a structured body.
 */

function feature(slug, title = `Feature ${slug}`) {
  return { slug, type: 'feature', title, body: 'feature body' };
}

function story(slug, parentSlug, title = `Story ${slug}`) {
  return {
    slug,
    type: 'story',
    title,
    parent_slug: parentSlug,
    acceptance: [`${title} is implemented`],
    verify: ['npm test (unit)'],
    body: {
      goal: `Goal for ${slug}.`,
      changes: [`src/${slug}.js: edit`],
      acceptance: [`${title} is implemented`],
      verify: ['npm test (unit)'],
    },
  };
}

describe('ticket-validator: single-Story-Feature rejection (Story #3777)', () => {
  it('REJECTS a backlog whose Feature contains a single Story', () => {
    const backlog = [feature('f1'), story('s1', 'f1')];
    assert.throws(
      () => validateAndNormalizeTickets(backlog),
      /decompose into fewer than two Stories/,
    );
  });

  it('names the offending Feature and tells the planner to collapse it', () => {
    const backlog = [
      feature('f-lonely', 'Lonely Feature'),
      story('s1', 'f-lonely'),
    ];
    let caught;
    try {
      validateAndNormalizeTickets(backlog);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected a throw');
    assert.match(caught.message, /"Lonely Feature" \(f-lonely, 1 Story\)/);
    assert.match(caught.message, /[Cc]ollapse/);
  });

  it('PASSES a backlog whose Feature contains two Stories', () => {
    const backlog = [feature('f1'), story('s1', 'f1'), story('s2', 'f1')];
    assert.doesNotThrow(() => validateAndNormalizeTickets(backlog));
  });

  it('rejects when ANY Feature in a multi-Feature backlog has a single Story', () => {
    const backlog = [
      feature('f-ok'),
      story('s1', 'f-ok'),
      story('s2', 'f-ok'),
      feature('f-bad'),
      story('s3', 'f-bad'),
    ];
    assert.throws(
      () => validateAndNormalizeTickets(backlog),
      /"Feature f-bad" \(f-bad, 1 Story\)/,
    );
  });

  it('names every offending Feature when several are undersized', () => {
    const backlog = [
      feature('f-a'),
      story('s1', 'f-a'),
      feature('f-b'),
      story('s2', 'f-b'),
    ];
    let caught;
    try {
      validateAndNormalizeTickets(backlog);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected a throw');
    assert.match(caught.message, /2 Feature\(s\)/);
    assert.match(caught.message, /f-a/);
    assert.match(caught.message, /f-b/);
  });
});

describe('assertNoSingleStoryFeature unit (Story #3777)', () => {
  const { assertNoSingleStoryFeature } = _internal;

  it('throws on a zero-Story Feature', () => {
    assert.throws(
      () =>
        assertNoSingleStoryFeature({
          features: [feature('f-empty')],
          stories: [],
        }),
      /fewer than two Stories/,
    );
  });

  it('throws on a one-Story Feature', () => {
    assert.throws(
      () =>
        assertNoSingleStoryFeature({
          features: [feature('f1')],
          stories: [story('s1', 'f1')],
        }),
      /fewer than two Stories/,
    );
  });

  it('does not throw when every Feature has at least two Stories', () => {
    assert.doesNotThrow(() =>
      assertNoSingleStoryFeature({
        features: [feature('f1'), feature('f2')],
        stories: [
          story('s1', 'f1'),
          story('s2', 'f1'),
          story('s3', 'f2'),
          story('s4', 'f2'),
        ],
      }),
    );
  });
});

describe('re-decompose to deliverable granularity yields a coarser hierarchy (Story #3777)', () => {
  // AC #6 — the deliverable-granularity guidance asks the planner to fold
  // module-level slices (one Story per file) into the capability they belong
  // to. This demo proves the SHAPE difference: a fine-grained backlog with a
  // single-Story-per-module Feature is REJECTED, and re-decomposing the same
  // work at deliverable granularity (one capability Feature with cohesive
  // sibling Stories) is ACCEPTED and produces fewer, coarser tickets. We do
  // NOT re-decompose in production — this is a test/demo only.

  // Fine-grained (module/task level): three Features, each wrapping exactly
  // one module-scoped Story. This is the anti-pattern the invariant forbids.
  const fineGrained = [
    feature('f-parser', 'Parser module'),
    story('s-parser', 'f-parser', 'Edit parser.js'),
    feature('f-caller', 'Caller module'),
    story('s-caller', 'f-caller', 'Edit caller.js'),
    feature('f-config', 'Config module'),
    story('s-config', 'f-config', 'Edit config.js'),
  ];

  // Coarse (deliverable granularity): one capability Feature whose cohesive
  // sibling Stories deliver shippable slices a reviewer would accept.
  const coarse = [
    feature('f-capability', 'Wire the new parser end to end'),
    story(
      's-parse-and-call',
      'f-capability',
      'Parse input and route to caller',
    ),
    story('s-config-surface', 'f-capability', 'Expose the config surface'),
  ];

  it('rejects the fine-grained, module-level decomposition', () => {
    assert.throws(
      () => validateAndNormalizeTickets(fineGrained),
      /fewer than two Stories/,
    );
  });

  it('accepts the coarser, deliverable-granularity decomposition', () => {
    assert.doesNotThrow(() => validateAndNormalizeTickets(coarse));
  });

  it('the coarse hierarchy has strictly fewer Features and tickets', () => {
    const fineFeatures = fineGrained.filter((t) => t.type === 'feature').length;
    const coarseFeatures = coarse.filter((t) => t.type === 'feature').length;
    assert.ok(
      coarseFeatures < fineFeatures,
      'deliverable-granularity decomposition collapses module Features',
    );
    assert.ok(
      coarse.length < fineGrained.length,
      'the coarser hierarchy is fewer tickets overall',
    );
  });
});
