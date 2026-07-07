// tests/lib/story-body/story-body-meta-round-trip.test.js
/**
 * Round-trip tests for the Story-body meta comment block (Story #3487).
 *
 * serialize() writes `wide` and `estimated_test_files` into a trailing
 * `<!-- meta: {...} -->` comment so the values survive a serialize → parse
 * round-trip. Before Story #3487, parse()'s markdown branch hardcoded both
 * fields to null and a `## References` section immediately followed by the
 * meta block swallowed the comment as a references entry. These tests pin the
 * corrected behaviour:
 *
 *   - parse() recovers `wide` from the meta block.
 *   - parse() recovers estimated_test_files from the meta block.
 *   - A References section followed by a meta block does not list the
 *     comment as a references entry.
 *   - serialize(parse(serialize(body)).body) === serialize(body) for a
 *     body carrying both meta fields.
 *
 * Story #3760 collapsed the `sizingProfile` enum into the `wide = { reason }`
 * declaration; these round-trip tests exercise the new field.
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

const WIDE_REASON = 'hard cutover: migrate every call site in one PR';
const REASON_TO_EXIST =
  'Promote the cohesion rule to a parseable, critic-checkable meta field.';

/** A canonical body carrying every meta field and a References section. */
const BODY_WITH_META = {
  goal: 'Recover meta fields on parse.',
  changes: [
    {
      path: '.agents/scripts/lib/story-body/story-body.js',
      assumption: 'refactors-existing',
    },
  ],
  acceptance: ['parse recovers wide', 'parse recovers test count'],
  verify: [
    'node --test tests/lib/story-body/story-body-meta-round-trip.test.js (unit)',
  ],
  references: [{ path: 'docs/architecture.md', assumption: 'exists' }],
  wide: { reason: WIDE_REASON },
  reason_to_exist: REASON_TO_EXIST,
  depends_on: [],
  estimated_test_files: 3,
};

// ---------------------------------------------------------------------------
// parse() recovers meta fields from the comment block
// ---------------------------------------------------------------------------

describe('parse() — meta block recovery', () => {
  it('recovers wide from a serialized meta block', () => {
    const md = serialize(BODY_WITH_META);
    const { body } = parse(md);
    assert.deepEqual(body.wide, { reason: WIDE_REASON });
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
      wide: null,
      estimated_test_files: null,
    });
    const { body, warnings } = parse(md);
    assert.equal(body.wide, null);
    assert.equal(body.estimated_test_files, null);
    assert.ok(warnings.some((w) => w.startsWith('test-surface-unestimated')));
  });

  it('recovers wide alone when estimated_test_files is absent', () => {
    const md = serialize({ ...BODY_WITH_META, estimated_test_files: null });
    const { body } = parse(md);
    assert.deepEqual(body.wide, { reason: WIDE_REASON });
    assert.equal(body.estimated_test_files, null);
  });

  it('recovers estimated_test_files alone when wide is absent', () => {
    const md = serialize({ ...BODY_WITH_META, wide: null });
    const { body } = parse(md);
    assert.equal(body.wide, null);
    assert.equal(body.estimated_test_files, 3);
  });
});

// ---------------------------------------------------------------------------
// reason_to_exist round-trips through the meta block (Story #4164).
// The cohesion reason ("why this Story exists") is promoted to a parseable
// meta field the epic-plan-consolidate critic checks. serialize() then parse()
// MUST round-trip a non-empty reason; an empty / absent reason parses to null.
// ---------------------------------------------------------------------------

describe('parse() — reason_to_exist meta round-trip', () => {
  it('round-trips a non-empty reason_to_exist through serialize() → parse()', () => {
    const md = serialize(BODY_WITH_META);
    const { body } = parse(md);
    assert.equal(body.reason_to_exist, REASON_TO_EXIST);
  });

  it('emits reason_to_exist into the serialized meta block', () => {
    const md = serialize(BODY_WITH_META);
    assert.ok(md.includes('<!-- meta:'));
    assert.ok(md.includes(`"reason_to_exist":"${REASON_TO_EXIST}"`));
  });

  it('parses reason_to_exist to null when absent from the meta block', () => {
    const md = serialize({ ...BODY_WITH_META, reason_to_exist: null });
    const { body } = parse(md);
    assert.equal(body.reason_to_exist, null);
    assert.ok(!md.includes('reason_to_exist'));
  });

  it('treats a blank / whitespace-only reason_to_exist as absent (null)', () => {
    for (const blank of ['', '   ', '\n\t']) {
      const md = serialize({ ...BODY_WITH_META, reason_to_exist: blank });
      const { body } = parse(md);
      assert.equal(
        body.reason_to_exist,
        null,
        `expected blank reason ${JSON.stringify(blank)} to parse as null`,
      );
      assert.ok(!md.includes('reason_to_exist'));
    }
  });

  it('preserves reason_to_exist across a serialize → parse → serialize round-trip', () => {
    const once = serialize(BODY_WITH_META);
    const twice = serialize(parse(once).body);
    assert.equal(twice, once);
    assert.ok(twice.includes(`"reason_to_exist":"${REASON_TO_EXIST}"`));
  });
});

// ---------------------------------------------------------------------------
// Malformed / non-object meta block degrades to defaults (never throws).
// The meta block is an optional machine-written convenience; a corrupt comment
// must not corrupt an otherwise-valid Story body.
// ---------------------------------------------------------------------------

describe('parse() — malformed / non-object meta block degrades safely', () => {
  /**
   * Serialize a valid body, then splice a raw (possibly malformed) meta
   * comment in place of the canonical one so the corrupt block is exercised
   * against an otherwise round-trippable body.
   */
  function bodyWithRawMeta(rawMeta) {
    const base = serialize({
      ...BODY_WITH_META,
      wide: null,
      estimated_test_files: null,
    });
    return `${base}\n\n<!-- meta: ${rawMeta} -->`;
  }

  it('degrades a malformed (non-JSON) meta block to null defaults without throwing', () => {
    // Brace-delimited so META_BLOCK_RE matches and the JSON.parse catch fires.
    const md = bodyWithRawMeta('{not valid json: ,}');
    let result;
    assert.doesNotThrow(() => {
      result = parse(md);
    });
    assert.equal(result.body.wide, null);
    assert.equal(result.body.estimated_test_files, null);
    // The body itself still parses — Goal survived the corrupt meta comment.
    assert.equal(result.body.goal, BODY_WITH_META.goal);
  });

  it('degrades a non-object meta payload (array / scalar) to null defaults', () => {
    for (const raw of ['[1,2,3]', '42', '"a string"', 'null']) {
      let result;
      assert.doesNotThrow(() => {
        result = parse(bodyWithRawMeta(raw));
      }, `expected no throw for meta payload ${raw}`);
      assert.equal(result.body.wide, null);
      assert.equal(result.body.estimated_test_files, null);
    }
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
      '<!-- meta: {"wide":{"reason":"broad cutover"},"estimated_test_files":2} -->',
    ].join('\n');
    const { body } = parse(md);
    assert.equal(body.references.length, 1);
    assert.deepEqual(body.references[0], {
      path: 'docs/architecture.md',
      assumption: 'exists',
    });
    assert.deepEqual(body.wide, { reason: 'broad cutover' });
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

  it('round-trips a body carrying only wide', () => {
    const body = { ...BODY_WITH_META, estimated_test_files: null };
    const once = serialize(body);
    const twice = serialize(parse(once).body);
    assert.equal(twice, once);
  });

  it('round-trips a body carrying only estimated_test_files', () => {
    const body = { ...BODY_WITH_META, wide: null };
    const once = serialize(body);
    const twice = serialize(parse(once).body);
    assert.equal(twice, once);
  });

  it('preserves the meta block across a round-trip', () => {
    const once = serialize(BODY_WITH_META);
    const twice = serialize(parse(once).body);
    assert.ok(twice.includes('<!-- meta:'));
    assert.ok(twice.includes(`"wide":{"reason":"${WIDE_REASON}"}`));
    assert.ok(twice.includes('"estimated_test_files":3'));
  });
});

// ---------------------------------------------------------------------------
// Framework provenance stamp (Story #4382): mandrel_version + authored_at
// round-trip through the meta block and the visible marker, and are IMMUTABLE
// across a parse → serialize (never re-derived / bumped).
// ---------------------------------------------------------------------------

const STAMPED_BODY = {
  ...BODY_WITH_META,
  mandrel_version: '1.2.3',
  authored_at: '2026-07-07',
};

describe('parse()/serialize() — framework-version stamp round-trip', () => {
  it('emits the hidden mandrel_version + authored_at fields into the meta block', () => {
    const md = serialize(STAMPED_BODY);
    assert.ok(md.includes('"mandrel_version":"1.2.3"'));
    assert.ok(md.includes('"authored_at":"2026-07-07"'));
  });

  it('emits the visible authoring marker line', () => {
    const md = serialize(STAMPED_BODY);
    assert.ok(md.includes('> 🏷️ Authored with Mandrel v1.2.3 · 2026-07-07'));
  });

  it('appends the stamp keys LAST in the meta block (stable key order)', () => {
    const md = serialize(STAMPED_BODY);
    assert.match(
      md,
      /"estimated_test_files":3,"mandrel_version":"1\.2\.3","authored_at":"2026-07-07"\}/,
    );
  });

  it('recovers mandrel_version + authored_at on parse', () => {
    const { body } = parse(serialize(STAMPED_BODY));
    assert.equal(body.mandrel_version, '1.2.3');
    assert.equal(body.authored_at, '2026-07-07');
  });

  it('the visible marker does not pollute the trailing structured section', () => {
    // verify[] is the last structured section; the marker must not bleed in.
    const { body } = parse(serialize(STAMPED_BODY));
    assert.deepEqual(body.verify, STAMPED_BODY.verify);
    assert.ok(!body.verify.some((v) => v.includes('Authored with Mandrel')));
  });

  it('is byte-stable and version-immutable across serialize → parse → serialize', () => {
    const once = serialize(STAMPED_BODY);
    const twice = serialize(parse(once).body);
    assert.equal(twice, once);
    assert.equal(extractVersion(twice), '1.2.3');
  });

  it('leaves a stamp-less body byte-identical to before (no marker, no keys)', () => {
    const md = serialize(BODY_WITH_META);
    assert.ok(!md.includes('mandrel_version'));
    assert.ok(!md.includes('Authored with Mandrel'));
  });
});

/** Pull the mandrel_version out of a serialized meta block for assertions. */
function extractVersion(md) {
  const m = md.match(/"mandrel_version":"([^"]+)"/);
  return m ? m[1] : null;
}
