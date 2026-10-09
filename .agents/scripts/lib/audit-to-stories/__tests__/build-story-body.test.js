/**
 * Colocated unit tests for the rebuilt audit Story-body shape (Story #4270).
 *
 * Asserts the inline-contract acceptance criteria:
 *   1. goal is the group intent only — no ordinal, no [SEVERITY]/(dimension).
 *   2. acceptance items are observable end-states, not verbatim recommendations.
 *   3. changes[] is populated from files[] in { path, assumption } form, and
 *      edges[] sequencing is carried through to depends_on[].
 *   4. verify[] is non-empty and tier-tagged with harness commands.
 *   5. the --emit-stories gate (buildAndGateStories) rejects an empty contract.
 *   6. the generated body round-trips through parse() / serialize().
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { __testing as auditCli } from '../../../audit-to-stories.js';
import { parse, serialize } from '../../story-body/story-body.js';
import { buildStoryBody } from '../build-story-body.js';

const { buildAndGateStories } = auditCli;

// The verify[] contract every generated audit Story carries (mirrors the
// frozen DEFAULT_VERIFY in build-story-body.js — asserted against literals so
// the module needs no test-only export).
const DEFAULT_VERIFY = ['npm run lint (validate)', 'npm test (unit)'];

/** A representative cross-audit group with files[], recommendations, prompts. */
function makeGroup(overrides = {}) {
  return {
    groupKey: 'file:.agents/scripts/lib/audit-to-stories/build-story-body.js',
    title: 'Remediate clean-code / security findings in build-story-body.js',
    dimensions: ['clean-code', 'injection'],
    files: ['.agents/scripts/lib/audit-to-stories/build-story-body.js'],
    severity: 'high',
    findings: [
      {
        title: 'Goal carries leftover ordinal + severity prefix',
        severity: 'high',
        dimension: 'clean-code',
        currentState: 'goal is polluted with `1. [HIGH] (clean-code)` prose',
        recommendation:
          'Derive goal from group.title only; drop summaryFromGroup.',
        sourceReport: 'temp/audits/audit-clean-code-results.md',
        files: ['.agents/scripts/lib/audit-to-stories/build-story-body.js'],
        fingerprint: { full: 'a'.repeat(40), short: 'a'.repeat(12) },
      },
      {
        title: 'verify[] hardcoded empty',
        severity: 'medium',
        dimension: 'clean-code',
        currentState: 'verify: [] ships an ungated Story',
        recommendation: 'Populate verify[] with harness commands.',
        sourceReport: 'temp/audits/audit-clean-code-results.md',
        files: ['.agents/scripts/lib/audit-to-stories/build-story-body.js'],
        fingerprint: { full: 'b'.repeat(40), short: 'b'.repeat(12) },
      },
    ],
    ...overrides,
  };
}

describe('buildStoryBody goal (criterion 1)', () => {
  it('uses the group title only — no ordinal, no [SEVERITY]/(dimension) prefix', () => {
    const { body } = parse(buildStoryBody({ group: makeGroup() }).body);
    assert.equal(
      body.goal,
      'Remediate clean-code / security findings in build-story-body.js',
    );
    assert.ok(
      !/^\d+\.\s/.test(body.goal),
      'goal must not lead with an ordinal',
    );
    assert.ok(!/\[[A-Z]+\]/.test(body.goal), 'goal must not carry [SEVERITY]');
    assert.ok(
      !/\((clean-code|injection)\)/.test(body.goal),
      'goal must not carry a (dimension) prefix',
    );
  });
});

describe('buildStoryBody acceptance (criterion 2)', () => {
  it('emits observable, non-verbatim end-states anchored on title + primary file', () => {
    const { body } = parse(buildStoryBody({ group: makeGroup() }).body);
    assert.equal(body.acceptance.length, 2);
    for (const item of body.acceptance) {
      assert.match(item, /is remediated/);
      assert.match(item, /no longer reproducible/);
    }
    // Must NOT be the verbatim recommendation paragraph.
    assert.ok(
      !body.acceptance.some((a) => a.includes('drop summaryFromGroup')),
      'acceptance must not echo the verbatim recommendation',
    );
    // Anchored on the primary file.
    assert.ok(
      body.acceptance[0].includes('build-story-body.js'),
      'acceptance should name the primary file',
    );
  });
});

describe('buildStoryBody changes + edges (criterion 3)', () => {
  it('populates changes[] from files[] in canonical { path, assumption } form', () => {
    const { body } = parse(buildStoryBody({ group: makeGroup() }).body);
    assert.deepEqual(body.changes, [
      {
        path: '.agents/scripts/lib/audit-to-stories/build-story-body.js',
        assumption: 'refactors-existing',
      },
    ]);
  });

  it('carries only the edges anchored on the group (Story #5044)', () => {
    // The prose `## Sequencing` block this replaced declared nothing any
    // scheduler could read, which is why standalone audit Stories shipped with
    // depends_on: [] and were serialized only by accident.
    const group = makeGroup();
    const edges = [
      { fromGroupKey: group.groupKey, toGroupKey: 'file:other.js', via: 'x' },
      { fromGroupKey: 'file:unrelated.js', toGroupKey: 'file:nope.js' },
    ];
    const built = buildStoryBody({ group, edges });
    assert.deepEqual(built.dependsOn, ['file:other.js']);
    assert.ok(!built.body.includes('## Sequencing'));

    const wired = buildStoryBody({
      group,
      edges,
      issueByGroupKey: { [group.groupKey]: 500, 'file:other.js': 499 },
    });
    assert.deepEqual(parse(wired.body).body.depends_on, ['#499']);
    // The unrelated edge's target must not leak in.
    assert.ok(!wired.body.includes('file:nope.js'));
  });

  it('declares nothing when no edge anchors on the group', () => {
    const built = buildStoryBody({ group: makeGroup() });
    assert.deepEqual(built.dependsOn, []);
    assert.deepEqual(parse(built.body).body.depends_on, []);
    assert.ok(!built.body.includes('blocked by'));
  });
});

describe('buildStoryBody verify (criterion 4)', () => {
  it('is non-empty and tier-tagged with harness commands', () => {
    const { body } = parse(buildStoryBody({ group: makeGroup() }).body);
    assert.ok(body.verify.length > 0);
    assert.deepEqual(body.verify, [...DEFAULT_VERIFY]);
    for (const v of body.verify) {
      assert.match(v, /\((validate|unit|contract|e2e)\)$/);
    }
  });
});

describe('buildStoryBody round-trip (criterion 6)', () => {
  it('round-trips the canonical structured sections through parse()/serialize()', () => {
    const { body } = parse(buildStoryBody({ group: makeGroup() }).body);
    // Re-serialize the parsed structured body and re-parse; the structured
    // fields must be stable.
    const reparsed = parse(serialize(body)).body;
    assert.equal(reparsed.goal, body.goal);
    assert.deepEqual(reparsed.changes, body.changes);
    assert.deepEqual(reparsed.acceptance, body.acceptance);
    assert.deepEqual(reparsed.verify, body.verify);
  });
});

describe('buildAndGateStories inline-contract gate (criterion 5)', () => {
  it('passes a well-formed batch and threads edges through', () => {
    const group = makeGroup();
    const built = buildAndGateStories(
      [group],
      [{ fromGroupKey: group.groupKey, toGroupKey: 'file:other.js' }],
    );
    assert.equal(built.length, 1);
    const { body } = parse(built[0].body);
    assert.ok(body.acceptance.length > 0 && body.verify.length > 0);
    // The edge rides the returned object, not the body: at create time the
    // blocker has no issue number, so there is no `#N` to declare yet. The
    // `--wire-edges` pass resolves it once the issues exist (Story #5044).
    assert.deepEqual(built[0].dependsOn, ['file:other.js']);
    assert.equal(built[0].groupKey, group.groupKey);
  });

  it('throws (opening no issues) when a group yields no acceptance items', () => {
    // A group with zero findings yields an empty acceptance[] — the legacy
    // ungated shape. The gate must reject it.
    const emptyGroup = makeGroup({ findings: [], files: [] });
    assert.throws(
      () => buildAndGateStories([emptyGroup], []),
      /inline-contract gate failed/,
    );
  });
});
