// tests/lib/story-body/story-body-meta-round-trip.test.js
/**
 * Round-trip tests for the Story-body meta comment block (Story #3487).
 *
 * serialize() writes `sizingProfile` and `estimated_test_files` into a
 * trailing `<!-- meta: {...} -->` comment so the values survive a
 * serialize → parse round-trip. Before this Story, parse()'s markdown
 * branch hardcoded both fields to null and a `## References` section
 * immediately followed by the meta block swallowed the comment as a
 * references entry. These tests pin the corrected behaviour:
 *
 *   - parse() recovers sizingProfile from the meta block.
 *   - parse() recovers estimated_test_files from the meta block.
 *   - A References section followed by a meta block does not list the
 *     comment as a references entry.
 *   - serialize(parse(serialize(body)).body) === serialize(body) for a
 *     body carrying both meta fields.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parse,
  serialize,
} from '../../../.agents/scripts/lib/story-body/story-body.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A canonical body carrying both meta fields and a References section. */
const BODY_WITH_META = {
  goal: 'Recover meta fields on parse.',
  changes: [
    {
      path: '.agents/scripts/lib/story-body/story-body.js',
      assumption: 'refactors-existing',
    },
  ],
  acceptance: ['parse recovers sizingProfile', 'parse recovers test count'],
  verify: [
    'node --test tests/lib/story-body/story-body-meta-round-trip.test.js (unit)',
  ],
  references: [{ path: 'docs/architecture.md', assumption: 'exists' }],
  sizingProfile: 'mechanical-sweep',
  depends_on: [],
  estimated_test_files: 3,
};

// ---------------------------------------------------------------------------
// parse() recovers meta fields from the comment block
// ---------------------------------------------------------------------------

describe('parse() — meta block recovery', () => {
  it('recovers sizingProfile from a serialized meta block', () => {
    const md = serialize(BODY_WITH_META);
    const { body } = parse(md);
    assert.equal(body.sizingProfile, 'mechanical-sweep');
  });

  it('recovers estimated_test_files from a serialized meta block', () => {
    const md = serialize(BODY_WITH_META);
    const { body } = parse(md);
    assert.equal(body.estimated_test_files, 3);
  });

  it('does not emit test-surface-unestimated when the meta block carries a count', () => {
    const md = serialize(BODY_WITH_META);
    const { warnings } = parse(md);
    assert.ok(
      !warnings.some((w) => w.startsWith('test-surface-unestimated')),
      `expected no test-surface-unestimated warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  it('still defaults both meta fields to null when no meta block is present', () => {
    const md = serialize({
      ...BODY_WITH_META,
      sizingProfile: null,
      estimated_test_files: null,
    });
    const { body, warnings } = parse(md);
    assert.equal(body.sizingProfile, null);
    assert.equal(body.estimated_test_files, null);
    assert.ok(warnings.some((w) => w.startsWith('test-surface-unestimated')));
  });

  it('recovers sizingProfile alone when estimated_test_files is absent', () => {
    const md = serialize({ ...BODY_WITH_META, estimated_test_files: null });
    const { body } = parse(md);
    assert.equal(body.sizingProfile, 'mechanical-sweep');
    assert.equal(body.estimated_test_files, null);
  });

  it('recovers estimated_test_files alone when sizingProfile is absent', () => {
    const md = serialize({ ...BODY_WITH_META, sizingProfile: null });
    const { body } = parse(md);
    assert.equal(body.sizingProfile, null);
    assert.equal(body.estimated_test_files, 3);
  });
});

// ---------------------------------------------------------------------------
// References section must not swallow the meta block
// ---------------------------------------------------------------------------

describe('parse() — References immediately followed by meta block', () => {
  it('does not list the meta comment as a references entry', () => {
    const md = serialize(BODY_WITH_META);
    const { body } = parse(md);
    assert.deepEqual(body.references, [
      { path: 'docs/architecture.md', assumption: 'exists' },
    ]);
  });

  it('handles a hand-authored References-then-meta body without a blank line', () => {
    const md = [
      '## Goal',
      'Do the thing.',
      '',
      '## References',
      `- ${JSON.stringify({ path: 'docs/architecture.md', assumption: 'exists' })}`,
      '<!-- meta: {"sizingProfile":"mechanical-sweep","estimated_test_files":2} -->',
    ].join('\n');
    const { body } = parse(md);
    assert.equal(body.references.length, 1);
    assert.deepEqual(body.references[0], {
      path: 'docs/architecture.md',
      assumption: 'exists',
    });
    assert.equal(body.sizingProfile, 'mechanical-sweep');
    assert.equal(body.estimated_test_files, 2);
  });
});

// ---------------------------------------------------------------------------
// Faithful serialize → parse → serialize round-trip
// ---------------------------------------------------------------------------

describe('round-trip: serialize → parse → serialize', () => {
  it('serialize(parse(serialize(body)).body) equals serialize(body) for a body with meta', () => {
    const once = serialize(BODY_WITH_META);
    const reparsed = parse(once).body;
    const twice = serialize(reparsed);
    assert.equal(twice, once);
  });

  it('round-trips a body carrying only sizingProfile', () => {
    const body = { ...BODY_WITH_META, estimated_test_files: null };
    const once = serialize(body);
    const twice = serialize(parse(once).body);
    assert.equal(twice, once);
  });

  it('round-trips a body carrying only estimated_test_files', () => {
    const body = { ...BODY_WITH_META, sizingProfile: null };
    const once = serialize(body);
    const twice = serialize(parse(once).body);
    assert.equal(twice, once);
  });

  it('preserves the meta block across a round-trip', () => {
    const once = serialize(BODY_WITH_META);
    const twice = serialize(parse(once).body);
    assert.ok(twice.includes('<!-- meta:'));
    assert.ok(twice.includes('"sizingProfile":"mechanical-sweep"'));
    assert.ok(twice.includes('"estimated_test_files":3'));
  });
});
