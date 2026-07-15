/**
 * tests/spec-authoring-code-grounding.test.js — Story #4139 (Epic #4131, F10).
 *
 * AC-11: spec authoring is grounded in the actual files it prescribes edits
 * to. The planner-context codebase snapshot must no longer *silently* drop the
 * majority of matched files, and cited-but-absent file paths must be surfaced
 * to the operator during authoring.
 *
 * Two surfaces are exercised:
 *
 *   1. The pure grounding helpers in `spec-authoring-grounding.js`
 *      (`buildTruncationSignal`, `findCitedButAbsent`, `buildAuthoringGrounding`)
 *      — unit tier, no I/O, fully deterministic.
 *
 *   2. The `buildAuthoringContext` integration — the emit-context envelope the
 *      `epic-plan-spec-author` Skill consumes must carry the
 *      `codebaseSnapshot.grounding` block without breaking the existing
 *      envelope shape.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildAuthoringContext } from '../.agents/scripts/lib/orchestration/planning/authoring-context.js';
import {
  buildAuthoringGrounding,
  buildTruncationSignal,
  findCitedButAbsent,
  MAX_CITED_ABSENT,
} from '../.agents/scripts/lib/orchestration/planning/spec-authoring-grounding.js';
import {
  collectReferences,
  hasNewFileCue,
} from '../.agents/scripts/lib/orchestration/spec-freshness.js';

const REAL_DEPS = { collectReferences, hasNewFileCue };

describe('buildTruncationSignal — surfaces dropped files, never silent', () => {
  it('returns null when the snapshot is absent', () => {
    assert.equal(buildTruncationSignal(null), null);
    assert.equal(buildTruncationSignal(undefined), null);
  });

  it('returns null when the snapshot was not truncated', () => {
    const snapshot = {
      truncated: false,
      fileCount: 10,
      files: new Array(10).fill('lib/x.js'),
      tier: 'skinny',
    };
    assert.equal(buildTruncationSignal(snapshot), null);
  });

  it('reports the dropped count, totals, tier, and remedies when truncated', () => {
    // Mirrors the real "377 of 627 files dropped" run the Story cites.
    const snapshot = {
      truncated: true,
      fileCount: 627,
      files: new Array(250).fill('lib/x.js'),
      tier: 'skinny',
    };
    const signal = buildTruncationSignal(snapshot);
    assert.ok(signal, 'a truncated snapshot must yield a non-null signal');
    assert.equal(signal.matched, 627);
    assert.equal(signal.shown, 250);
    assert.equal(signal.dropped, 377);
    assert.equal(signal.tier, 'skinny');
    assert.ok(Array.isArray(signal.remedies));
    // Both operator remedies (raise tier / narrow include) are named so the
    // degradation is actionable, not just visible.
    assert.match(signal.remedies.join(' '), /tier: "medium"/);
    assert.match(signal.remedies.join(' '), /include/);
  });

  it('floors the dropped count at zero when totals are inconsistent', () => {
    const snapshot = {
      truncated: true,
      fileCount: 5,
      files: new Array(10).fill('lib/x.js'),
      tier: 'skinny',
    };
    const signal = buildTruncationSignal(snapshot);
    assert.equal(signal.dropped, 0);
  });
});

describe('findCitedButAbsent — surfaces cited-but-absent paths', () => {
  it('returns paths cited in prose that are missing from the snapshot file set', () => {
    const prose = [
      'This Epic refactors `lib/present.js` and also touches',
      '`lib/absent.js` which is not in the tree yet.',
    ].join('\n');
    const snapshotFiles = ['lib/present.js'];

    const { paths, truncated } = findCitedButAbsent(
      prose,
      snapshotFiles,
      REAL_DEPS,
    );

    assert.deepEqual(paths, ['lib/absent.js']);
    assert.equal(truncated, false);
  });

  it('does not surface a cited path that IS present in the snapshot', () => {
    const prose = 'The work edits `lib/present.js`.';
    const { paths } = findCitedButAbsent(prose, ['lib/present.js'], REAL_DEPS);
    assert.deepEqual(paths, []);
  });

  it('demotes net-new cued paths so proposed files are not flagged as drift', () => {
    const prose = 'We will create a new file `lib/brand-new.js` for this.';
    const { paths } = findCitedButAbsent(prose, [], REAL_DEPS);
    assert.deepEqual(
      paths,
      [],
      'a path phrased as net-new must not be reported as cited-but-absent',
    );
  });

  it('dedupes and sorts multiple absent citations', () => {
    const prose = [
      'Touches `lib/zeta.js`, then `lib/alpha.js`, then `lib/zeta.js` again.',
    ].join('\n');
    const { paths } = findCitedButAbsent(prose, [], REAL_DEPS);
    assert.deepEqual(paths, ['lib/alpha.js', 'lib/zeta.js']);
  });

  it('bounds the result and flags truncation past the cap', () => {
    const cited = [];
    for (let i = 0; i < MAX_CITED_ABSENT + 5; i += 1) {
      cited.push(`\`lib/file-${String(i).padStart(3, '0')}.js\``);
    }
    const prose = `Edits ${cited.join(', ')}.`;
    const { paths, truncated } = findCitedButAbsent(prose, [], REAL_DEPS);
    assert.equal(paths.length, MAX_CITED_ABSENT);
    assert.equal(truncated, true);
  });

  it('returns an empty result for empty prose', () => {
    assert.deepEqual(findCitedButAbsent('', ['lib/x.js'], REAL_DEPS), {
      paths: [],
      truncated: false,
    });
  });
});

describe('buildAuthoringGrounding — combined grounding block', () => {
  it('combines the truncation signal and the cited-but-absent list', () => {
    const snapshot = {
      truncated: true,
      fileCount: 627,
      files: ['lib/present.js'],
      tier: 'skinny',
    };
    const prose = 'Refactors `lib/present.js` and `lib/missing.js`.';

    const grounding = buildAuthoringGrounding({
      snapshot,
      prose,
      collectReferences,
      hasNewFileCue,
    });

    assert.ok(grounding.truncation, 'truncation signal must be present');
    assert.equal(grounding.truncation.dropped, 626);
    assert.deepEqual(grounding.citedButAbsent, ['lib/missing.js']);
    assert.equal(grounding.citedButAbsentTruncated, false);
  });

  it('yields a null truncation signal for an untruncated snapshot', () => {
    const snapshot = {
      truncated: false,
      fileCount: 1,
      files: ['lib/present.js'],
      tier: 'skinny',
    };
    const grounding = buildAuthoringGrounding({
      snapshot,
      prose: 'Edits `lib/present.js`.',
      collectReferences,
      hasNewFileCue,
    });
    assert.equal(grounding.truncation, null);
    assert.deepEqual(grounding.citedButAbsent, []);
  });
});

describe('buildAuthoringContext — envelope carries grounding', () => {
  // A mock provider whose Epic body cites a path that will not be present in
  // *this* repo's codebase snapshot, so the cited-but-absent surfacing fires
  // end to end through the real snapshot builder.
  const provider = {
    async getEpic(id) {
      return {
        id,
        title: 'Spec authoring code-grounding',
        body: [
          '## Scope',
          '',
          'This Epic refactors `.agents/scripts/epic-plan-spec.js` and also',
          'references `lib/this-path-does-not-exist-4139.js` which is absent',
          'from the source tree.',
        ].join('\n'),
        labels: ['type::story'],
        linkedIssues: { techSpec: null },
      };
    },
  };

  it('attaches codebaseSnapshot.grounding with the cited-but-absent path', async () => {
    const ctx = await buildAuthoringContext(4131, provider, {});

    assert.ok(ctx.codebaseSnapshot, 'snapshot must be present');
    assert.ok(
      ctx.codebaseSnapshot.grounding,
      'snapshot must carry a grounding block',
    );
    assert.ok(
      Array.isArray(ctx.codebaseSnapshot.grounding.citedButAbsent),
      'grounding.citedButAbsent must be an array',
    );
    assert.ok(
      ctx.codebaseSnapshot.grounding.citedButAbsent.includes(
        'lib/this-path-does-not-exist-4139.js',
      ),
      'a cited-but-absent path must be surfaced in the authoring envelope',
    );
  });

  it('does not break the existing envelope shape consumed by the skill', async () => {
    const ctx = await buildAuthoringContext(4131, provider, {});

    // Envelope keys the epic-plan-spec-author Skill relies on.
    assert.ok(ctx.epic);
    assert.ok(Object.hasOwn(ctx, 'docsContext'));
    assert.ok(Object.hasOwn(ctx, 'codebaseSnapshot'));
    assert.ok(ctx.bddRunner);
    assert.ok(ctx.memoryFreshness);
    assert.ok(ctx.priorFeedback);
    // The risk-verdict cutover (Epic #3865) — still no planningRisk.
    assert.equal(Object.hasOwn(ctx, 'planningRisk'), false);
  });
});
