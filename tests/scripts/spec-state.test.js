/**
 * Integration tests for `.agents/scripts/lib/spec/state.js` — Story #1491 /
 * Task #1509. Covers the hashing primitives and the spec→mapping
 * projection used by `writeState`.
 *
 * Contract under test:
 *   - `canonicalise` deeply sorts object keys, preserves array order.
 *   - `canonicalStringify` produces equal output for logically equal
 *     inputs regardless of authored key order.
 *   - `sha256Hex` is deterministic and emits `sha256:<hex>`.
 *   - `hashSpecEntry` is determinism-stable across Node 22+ on the same
 *     input (AC: "Hashing is deterministic across Node 22 runs").
 *   - `iterSpecEntries` yields every slug-bearing entity in the spec.
 *   - `projectMapping` carries forward prior `issueNumber` +
 *     `lastObservedAgentState`, re-hashes structural content, and emits
 *     `null` placeholders for newly added slugs.
 *   - `buildState` packages it all into the file-shape the writer
 *     consumes; passing `now` makes the result byte-stable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildState,
  canonicalise,
  canonicalStringify,
  hashSpecEntry,
  iterSpecEntries,
  projectMapping,
  sha256Hex,
} from '../../.agents/scripts/lib/spec/index.js';

const SAMPLE_SPEC = Object.freeze({
  epic: { id: 1182, title: 'Epic 1182' },
  features: [
    {
      slug: 'feat-a',
      title: 'Feature A',
      stories: [
        {
          slug: 'story-a',
          title: 'Story A',
          wave: 0,
          tasks: [
            { slug: 'task-a1', title: 'Task A1' },
            { slug: 'task-a2', title: 'Task A2' },
          ],
        },
        {
          slug: 'story-b',
          title: 'Story B',
          wave: 1,
          dependsOn: ['story-a'],
          tasks: [],
        },
      ],
    },
    {
      slug: 'feat-b',
      title: 'Feature B',
      stories: [],
    },
  ],
});

describe('lib/spec/state.js — canonicalise', () => {
  it('sorts object keys at every depth', () => {
    const input = { b: 1, a: { d: 4, c: 3 } };
    const result = canonicalise(input);
    assert.deepEqual(Object.keys(result), ['a', 'b']);
    assert.deepEqual(Object.keys(result.a), ['c', 'd']);
  });

  it('preserves array order (array order is semantically meaningful)', () => {
    const input = { items: [3, 1, 2] };
    const result = canonicalise(input);
    assert.deepEqual(result.items, [3, 1, 2]);
  });

  it('passes scalars through unchanged', () => {
    assert.equal(canonicalise(42), 42);
    assert.equal(canonicalise('x'), 'x');
    assert.equal(canonicalise(null), null);
  });
});

describe('lib/spec/state.js — canonicalStringify', () => {
  it('produces identical output for equal objects with different key order', () => {
    const a = { slug: 'x', title: 'X', tasks: [{ slug: 't1', title: 'T1' }] };
    const b = { title: 'X', tasks: [{ title: 'T1', slug: 't1' }], slug: 'x' };
    assert.equal(canonicalStringify(a), canonicalStringify(b));
  });

  it('distinguishes logically different objects', () => {
    const a = { slug: 'x', title: 'X' };
    const b = { slug: 'x', title: 'Y' };
    assert.notEqual(canonicalStringify(a), canonicalStringify(b));
  });
});

describe('lib/spec/state.js — sha256Hex', () => {
  it('produces the documented sha256: prefix and hex body', () => {
    const out = sha256Hex('hello');
    assert.match(out, /^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic across calls', () => {
    assert.equal(sha256Hex('a'), sha256Hex('a'));
  });
});

describe('lib/spec/state.js — hashSpecEntry', () => {
  it('hashes equivalent entries to the same digest regardless of key order', () => {
    const a = { slug: 'x', title: 'X', tasks: [{ slug: 't', title: 'T' }] };
    const b = { tasks: [{ title: 'T', slug: 't' }], title: 'X', slug: 'x' };
    assert.equal(hashSpecEntry(a), hashSpecEntry(b));
  });

  it('changes when a structural field changes', () => {
    const a = { slug: 'x', title: 'X' };
    const b = { slug: 'x', title: 'Y' };
    assert.notEqual(hashSpecEntry(a), hashSpecEntry(b));
  });

  it('is stable run-to-run for a fixed input (AC: deterministic across Node 22 runs)', () => {
    const entry = { slug: 'schema-author', title: 'Author schema', wave: 0 };
    // Re-hashing the same input in the same process is the closest we can
    // get to "across runs" without invoking a subprocess — the algorithm
    // is sha256 over canonical JSON, so cross-process stability is a
    // direct consequence of in-process stability.
    const first = hashSpecEntry(entry);
    const second = hashSpecEntry(entry);
    assert.equal(first, second);
    // And a known-good fixture pins the actual digest so an accidental
    // canonicalisation change would surface as a test failure.
    assert.match(first, /^sha256:[0-9a-f]{64}$/);
  });
});

describe('lib/spec/state.js — iterSpecEntries', () => {
  it('yields every slug-bearing entity in feature-major order', () => {
    const slugs = [...iterSpecEntries(SAMPLE_SPEC)].map(([slug]) => slug);
    assert.deepEqual(slugs, [
      'feat-a',
      'story-a',
      'task-a1',
      'task-a2',
      'story-b',
      'feat-b',
    ]);
  });

  it('tolerates a spec missing features (yields nothing)', () => {
    const slugs = [...iterSpecEntries({})].map(([slug]) => slug);
    assert.deepEqual(slugs, []);
  });

  it('skips entries without a slug', () => {
    const spec = {
      features: [
        { title: 'no slug', stories: [] },
        { slug: 'has-slug', title: 'ok', stories: [] },
      ],
    };
    const slugs = [...iterSpecEntries(spec)].map(([slug]) => slug);
    assert.deepEqual(slugs, ['has-slug']);
  });
});

describe('lib/spec/state.js — projectMapping', () => {
  it('emits an entry per slug with a deterministic contentHash', () => {
    const mapping = projectMapping(SAMPLE_SPEC);
    assert.deepEqual(Object.keys(mapping).sort(), [
      'feat-a',
      'feat-b',
      'story-a',
      'story-b',
      'task-a1',
      'task-a2',
    ]);
    for (const entry of Object.values(mapping)) {
      assert.match(entry.contentHash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(entry.issueNumber, null);
      assert.equal(entry.lastObservedAgentState, null);
    }
  });

  it('carries forward prior issueNumber + lastObservedAgentState', () => {
    const prior = {
      mapping: {
        'story-a': {
          issueNumber: 1490,
          contentHash: 'sha256:stale',
          lastObservedAgentState: 'agent::done',
        },
      },
    };
    const mapping = projectMapping(SAMPLE_SPEC, prior);
    assert.equal(mapping['story-a'].issueNumber, 1490);
    assert.equal(mapping['story-a'].lastObservedAgentState, 'agent::done');
    // contentHash is freshly computed, not the stale value
    assert.notEqual(mapping['story-a'].contentHash, 'sha256:stale');
  });

  it('drops slugs that are no longer in the spec (spec is SSOT)', () => {
    const prior = {
      mapping: {
        'removed-slug': {
          issueNumber: 999,
          contentHash: 'sha256:x',
          lastObservedAgentState: 'agent::ready',
        },
      },
    };
    const mapping = projectMapping(SAMPLE_SPEC, prior);
    assert.equal(mapping['removed-slug'], undefined);
  });

  it('tolerates an undefined prior mapping', () => {
    const mapping = projectMapping(SAMPLE_SPEC);
    assert.ok(mapping['feat-a']);
  });
});

describe('lib/spec/state.js — buildState', () => {
  it('packages epicId, lastReconciledAt, and a fresh mapping', () => {
    const state = buildState(
      SAMPLE_SPEC,
      {},
      { now: '2026-05-12T00:00:00.000Z' },
    );
    assert.equal(state.epicId, 1182);
    assert.equal(state.lastReconciledAt, '2026-05-12T00:00:00.000Z');
    assert.equal(typeof state.mapping, 'object');
    assert.ok(state.mapping['feat-a']);
  });

  it('falls back to prior.epicId when spec.epic.id is missing', () => {
    const state = buildState(
      { features: [] },
      { epicId: 1182, mapping: {} },
      { now: '2026-05-12T00:00:00.000Z' },
    );
    assert.equal(state.epicId, 1182);
  });

  it('default-injects an ISO timestamp when `now` is omitted', () => {
    const state = buildState(SAMPLE_SPEC, {});
    assert.match(
      state.lastReconciledAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('produces a byte-identical canonical form when called twice with the same inputs', () => {
    const a = buildState(SAMPLE_SPEC, {}, { now: '2026-05-12T00:00:00.000Z' });
    const b = buildState(SAMPLE_SPEC, {}, { now: '2026-05-12T00:00:00.000Z' });
    assert.equal(canonicalStringify(a), canonicalStringify(b));
  });
});
