import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_BASELINE_PATH,
  DEFAULT_TOLERANCE_PCT,
  readBaseline,
  validateBaseline,
  writeBaseline,
} from '../../../.agents/scripts/lib/mutation/baseline-snapshot.js';

/**
 * Story #1736 / Task #1752. Direct unit coverage for the mutation
 * baseline-snapshot helpers. Both read and write paths are dependency-
 * injection-friendly so these tests never touch real fs state — the fs
 * surface is replaced by an in-memory Map shim and the clock is fixed
 * so generated timestamps are stable.
 */

function makeFsShim(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    existsSync(p) {
      return store.has(p);
    },
    readFileSync(p) {
      if (!store.has(p)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return store.get(p);
    },
    writeFileSync(p, bytes) {
      store.set(p, bytes);
    },
    mkdirSync() {
      // shim — directory tracking is irrelevant for byte-equality checks
    },
    renameSync(from, to) {
      const bytes = store.get(from);
      store.set(to, bytes);
      store.delete(from);
    },
    unlinkSync(p) {
      store.delete(p);
    },
  };
}

const FIXED_CLOCK = () => new Date('2026-05-14T18:00:00.000Z');

describe('mutation/baseline-snapshot — validateBaseline', () => {
  it('accepts a well-formed envelope', () => {
    const payload = {
      generatedAt: '2026-05-14T17:00:00.000Z',
      tolerancePct: 0,
      workspaces: { '*': 75.5 },
    };
    assert.deepEqual(validateBaseline(payload), payload);
  });

  it('rejects non-object input', () => {
    assert.throws(() => validateBaseline(null), /expected an object/);
    assert.throws(() => validateBaseline([]), /expected an object/);
    assert.throws(() => validateBaseline('hi'), /expected an object/);
  });

  it('requires a non-empty generatedAt string', () => {
    assert.throws(
      () =>
        validateBaseline({
          generatedAt: '',
          tolerancePct: 0,
          workspaces: { '*': 50 },
        }),
      /'generatedAt'/,
    );
    assert.throws(
      () => validateBaseline({ tolerancePct: 0, workspaces: { '*': 50 } }),
      /'generatedAt'/,
    );
  });

  it('requires non-negative tolerancePct', () => {
    assert.throws(
      () =>
        validateBaseline({
          generatedAt: 'now',
          tolerancePct: -1,
          workspaces: {},
        }),
      /'tolerancePct'/,
    );
    assert.throws(
      () =>
        validateBaseline({
          generatedAt: 'now',
          tolerancePct: 'x',
          workspaces: {},
        }),
      /'tolerancePct'/,
    );
  });

  it('requires workspaces to be an object with numeric scores in [0, 100]', () => {
    assert.throws(
      () =>
        validateBaseline({
          generatedAt: 'now',
          tolerancePct: 0,
          workspaces: [],
        }),
      /'workspaces'/,
    );
    assert.throws(
      () =>
        validateBaseline({
          generatedAt: 'now',
          tolerancePct: 0,
          workspaces: { '*': 101 },
        }),
      /workspace "\*" score/,
    );
    assert.throws(
      () =>
        validateBaseline({
          generatedAt: 'now',
          tolerancePct: 0,
          workspaces: { '*': -0.1 },
        }),
      /workspace "\*" score/,
    );
    assert.throws(
      () =>
        validateBaseline({
          generatedAt: 'now',
          tolerancePct: 0,
          workspaces: { '*': 'high' },
        }),
      /workspace "\*" score/,
    );
  });
});

describe('mutation/baseline-snapshot — readBaseline', () => {
  it('returns null when the baseline file does not exist', () => {
    const fsImpl = makeFsShim();
    const result = readBaseline('/repo/baselines/mutation.json', { fsImpl });
    assert.equal(result, null);
  });

  it('parses and validates an existing baseline', () => {
    const payload = {
      generatedAt: '2026-05-14T17:00:00.000Z',
      tolerancePct: 1.5,
      workspaces: { '*': 80, web: 75 },
    };
    const fsImpl = makeFsShim({
      '/repo/baselines/mutation.json': `${JSON.stringify(payload, null, 2)}\n`,
    });
    const result = readBaseline('/repo/baselines/mutation.json', { fsImpl });
    assert.deepEqual(result, payload);
  });

  it('throws on invalid JSON', () => {
    const fsImpl = makeFsShim({
      '/repo/baselines/mutation.json': '{not json',
    });
    assert.throws(
      () => readBaseline('/repo/baselines/mutation.json', { fsImpl }),
      /failed to parse/,
    );
  });

  it('throws when the envelope fails validation', () => {
    const fsImpl = makeFsShim({
      '/repo/baselines/mutation.json':
        '{"generatedAt":"now","tolerancePct":-5,"workspaces":{}}',
    });
    assert.throws(
      () => readBaseline('/repo/baselines/mutation.json', { fsImpl }),
      /'tolerancePct'/,
    );
  });
});

describe('mutation/baseline-snapshot — writeBaseline', () => {
  it('writes a canonical envelope with a trailing newline', () => {
    const fsImpl = makeFsShim();
    const result = writeBaseline(
      '/repo/baselines/mutation.json',
      {
        tolerancePct: 0,
        workspaces: { '*': 80 },
      },
      { fsImpl, clock: FIXED_CLOCK },
    );
    assert.equal(result.didChange, true);
    assert.equal(result.path, '/repo/baselines/mutation.json');
    const bytes = fsImpl.store.get('/repo/baselines/mutation.json');
    assert.ok(bytes.endsWith('\n'), 'baseline must end with a newline');
    const parsed = JSON.parse(bytes);
    assert.equal(parsed.generatedAt, '2026-05-14T18:00:00.000Z');
    assert.equal(parsed.tolerancePct, 0);
    assert.deepEqual(parsed.workspaces, { '*': 80 });
  });

  it('pins the "*" catch-all to the first slot and sorts the rest alphabetically', () => {
    const fsImpl = makeFsShim();
    writeBaseline(
      '/repo/baselines/mutation.json',
      {
        tolerancePct: 1,
        workspaces: { web: 75, '*': 80, api: 60, mobile: 70 },
      },
      { fsImpl, clock: FIXED_CLOCK },
    );
    const bytes = fsImpl.store.get('/repo/baselines/mutation.json');
    const keysInOrder = bytes
      .match(/"([^"]+)":/g)
      .map((m) => m.slice(1, -2))
      .filter((k) => ['*', 'api', 'mobile', 'web'].includes(k));
    assert.deepEqual(keysInOrder, ['*', 'api', 'mobile', 'web']);
  });

  it('defaults tolerancePct to DEFAULT_TOLERANCE_PCT when omitted', () => {
    const fsImpl = makeFsShim();
    writeBaseline(
      '/repo/baselines/mutation.json',
      { workspaces: { '*': 90 } },
      { fsImpl, clock: FIXED_CLOCK },
    );
    const parsed = JSON.parse(
      fsImpl.store.get('/repo/baselines/mutation.json'),
    );
    assert.equal(parsed.tolerancePct, DEFAULT_TOLERANCE_PCT);
  });

  it('returns didChange=false when the new bytes match the prior file', () => {
    const fsImpl = makeFsShim();
    writeBaseline(
      '/repo/baselines/mutation.json',
      { tolerancePct: 0, workspaces: { '*': 80 } },
      { fsImpl, clock: FIXED_CLOCK },
    );
    const result = writeBaseline(
      '/repo/baselines/mutation.json',
      { tolerancePct: 0, workspaces: { '*': 80 } },
      { fsImpl, clock: FIXED_CLOCK },
    );
    assert.equal(result.didChange, false);
  });

  it('returns didChange=true when scores differ', () => {
    const fsImpl = makeFsShim();
    writeBaseline(
      '/repo/baselines/mutation.json',
      { tolerancePct: 0, workspaces: { '*': 80 } },
      { fsImpl, clock: FIXED_CLOCK },
    );
    const result = writeBaseline(
      '/repo/baselines/mutation.json',
      { tolerancePct: 0, workspaces: { '*': 82 } },
      { fsImpl, clock: FIXED_CLOCK },
    );
    assert.equal(result.didChange, true);
  });

  it('throws when payload.workspaces is missing or not an object', () => {
    const fsImpl = makeFsShim();
    assert.throws(
      () => writeBaseline('/repo/baselines/mutation.json', {}, { fsImpl }),
      /workspaces/,
    );
    assert.throws(
      () =>
        writeBaseline(
          '/repo/baselines/mutation.json',
          { workspaces: null },
          { fsImpl },
        ),
      /workspaces/,
    );
  });

  it('honours an explicit generatedAt when supplied', () => {
    const fsImpl = makeFsShim();
    writeBaseline(
      '/repo/baselines/mutation.json',
      {
        generatedAt: '2025-01-01T00:00:00.000Z',
        tolerancePct: 0,
        workspaces: { '*': 80 },
      },
      { fsImpl, clock: FIXED_CLOCK },
    );
    const parsed = JSON.parse(
      fsImpl.store.get('/repo/baselines/mutation.json'),
    );
    assert.equal(parsed.generatedAt, '2025-01-01T00:00:00.000Z');
  });
});

describe('mutation/baseline-snapshot — constants', () => {
  it('exposes a sensible default baseline path', () => {
    assert.equal(DEFAULT_BASELINE_PATH, 'baselines/mutation.json');
  });

  it('defaults tolerance to 0% pts so the gate runs strict by default', () => {
    assert.equal(DEFAULT_TOLERANCE_PCT, 0);
  });
});
