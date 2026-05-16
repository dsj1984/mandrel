import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  deepEqual,
  FULL_AGENTRC_PATH,
  getAgentrcDefaults,
  iterDefaultLeaves,
  lookupPath,
} from '../../.agents/scripts/lib/config/defaults.js';

const TEMPLATE_PATH = fileURLToPath(
  new URL('../../.agents/full-agentrc.json', import.meta.url),
);

describe('getAgentrcDefaults', () => {
  it('resolves to .agents/full-agentrc.json', () => {
    assert.equal(FULL_AGENTRC_PATH, TEMPLATE_PATH);
  });

  it('returns the parsed template minus the $schema pointer', () => {
    const defaults = getAgentrcDefaults({ bustCache: true });
    const raw = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8'));
    delete raw.$schema;
    assert.deepEqual(defaults, raw);
  });

  it('returns a deep-frozen snapshot', () => {
    const defaults = getAgentrcDefaults();
    assert.throws(() => {
      defaults.project.baseBranch = 'tampered';
    });
    assert.throws(() => {
      defaults.delivery.quality.gates.crap.targetDirs.push('mutated');
    });
  });

  it('caches between calls', () => {
    const a = getAgentrcDefaults();
    const b = getAgentrcDefaults();
    assert.equal(a, b);
  });
});

describe('iterDefaultLeaves', () => {
  it('yields scalar leaves with dotted paths', () => {
    const sample = { a: { b: 1, c: 'x' }, d: true };
    const leaves = [...iterDefaultLeaves(sample)];
    const paths = leaves.map(([p]) => p).sort();
    assert.deepEqual(paths, ['a.b', 'a.c', 'd']);
  });

  it('treats arrays as opaque leaf values', () => {
    const sample = { list: [1, 2, 3], nested: { items: ['a'] } };
    const leaves = [...iterDefaultLeaves(sample)];
    const paths = leaves.map(([p]) => p).sort();
    assert.deepEqual(paths, ['list', 'nested.items']);
  });

  it('covers full-agentrc.json end-to-end without throwing', () => {
    const defaults = getAgentrcDefaults();
    const leaves = [...iterDefaultLeaves(defaults)];
    assert.ok(leaves.length > 20, 'expected non-trivial leaf count');
  });
});

describe('lookupPath', () => {
  it('returns present:true for an existing leaf', () => {
    const obj = { a: { b: 42 } };
    assert.deepEqual(lookupPath(obj, 'a.b'), { present: true, value: 42 });
  });

  it('returns present:false for a missing leaf', () => {
    const obj = { a: { b: 42 } };
    assert.deepEqual(lookupPath(obj, 'a.c'), {
      present: false,
      value: undefined,
    });
  });

  it('returns present:false when traversing through a non-object', () => {
    const obj = { a: 42 };
    assert.deepEqual(lookupPath(obj, 'a.b'), {
      present: false,
      value: undefined,
    });
  });

  it('returns present:true with value:null for an explicit null leaf', () => {
    const obj = { a: { b: null } };
    assert.deepEqual(lookupPath(obj, 'a.b'), { present: true, value: null });
  });
});

describe('deepEqual', () => {
  it('matches primitives and nulls', () => {
    assert.ok(deepEqual(1, 1));
    assert.ok(deepEqual(null, null));
    assert.ok(!deepEqual(null, undefined));
    assert.ok(!deepEqual(1, '1'));
  });

  it('compares arrays by element order', () => {
    assert.ok(deepEqual([1, 2, 3], [1, 2, 3]));
    assert.ok(!deepEqual([1, 2, 3], [3, 2, 1]));
  });

  it('compares objects by key/value', () => {
    assert.ok(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }));
    assert.ok(!deepEqual({ a: 1 }, { a: 1, b: 2 }));
  });
});
