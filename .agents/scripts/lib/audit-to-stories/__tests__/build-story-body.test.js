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
import {
  __testing as bodyTesting,
  buildStoryBody,
} from '../build-story-body.js';

const { buildAndGateStories } = auditCli;
const { DEFAULT_VERIFY, sequencingDepsForGroup } = bodyTesting;

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
        agentPrompt: 'Rewrite goalFromGroup to return group.title.trim().',
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
        agentPrompt: '',
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

  it('resolves edges[] anchored on the group and renders a ## Sequencing block', () => {
    const group = makeGroup();
    const edges = [
      { fromGroupKey: group.groupKey, toGroupKey: 'file:other.js', via: 'x' },
      { fromGroupKey: 'file:unrelated.js', toGroupKey: 'file:nope.js' },
    ];
    assert.deepEqual(sequencingDepsForGroup(group, edges), ['file:other.js']);
    const { body } = buildStoryBody({ group, edges });
    assert.match(body, /## Sequencing/);
    assert.match(body, /depends on group `file:other\.js`/);
    // The unrelated edge's target must not leak in.
    assert.ok(!body.includes('file:nope.js'));
  });

  it('omits the ## Sequencing block when no edge anchors on the group', () => {
    const { body } = buildStoryBody({ group: makeGroup() });
    assert.ok(!body.includes('## Sequencing'));
    assert.deepEqual(parse(body).body.depends_on, []);
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
    assert.match(built[0].body, /depends on group `file:other\.js`/);
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
