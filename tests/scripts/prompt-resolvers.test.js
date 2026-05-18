/**
 * prompt-resolvers.test — Story #2459 / Task #2470
 *
 * Exercises each `resolveFrom*` helper in isolation. The resolvers are a
 * priority-ordered chain (`RESOLVERS`) that replaces the seven-`continue`
 * loop the previous `collectAnswers` implementation carried. Each helper
 * returns one of three outcomes:
 *
 *   { kind: 'value', value }  — accepted this answer
 *   { kind: 'missing' }       — required answer is missing
 *   { kind: 'skip' }          — this resolver doesn't apply
 *
 * Per-resolver tests pin the contract so the chain stays the only branch
 * point in `collectAnswers` itself.
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import {
  RESOLVERS,
  resolveAssumeYes,
  resolveFromEnv,
  resolveFromFlag,
  resolveFromSilent,
  resolveInteractive,
} from '../../.agents/scripts/lib/bootstrap/prompt.js';

const QUESTION = Object.freeze({
  key: 'owner',
  flag: 'owner',
  env: 'GH_OWNER',
  message: 'GitHub owner',
  default: 'acme',
  required: true,
});

function baseCtx(overrides = {}) {
  return {
    q: { ...QUESTION, ...(overrides.q ?? {}) },
    flags: overrides.flags ?? {},
    env: overrides.env ?? {},
    silentSet: overrides.silentSet ?? new Set(),
    interactive: overrides.interactive ?? false,
    assumeYes: overrides.assumeYes ?? false,
    getRl: overrides.getRl ?? (() => Promise.reject(new Error('no rl'))),
    output: overrides.output ?? { write: () => {} },
  };
}

describe('resolveFromFlag', () => {
  it('returns value when the flag is a non-empty string', () => {
    const ctx = baseCtx({ flags: { owner: 'flagged' } });
    assert.deepEqual(resolveFromFlag(ctx), { kind: 'value', value: 'flagged' });
  });

  it('skips when the flag is absent', () => {
    const ctx = baseCtx();
    assert.deepEqual(resolveFromFlag(ctx), { kind: 'skip' });
  });

  it('skips when the flag is an empty string', () => {
    const ctx = baseCtx({ flags: { owner: '' } });
    assert.deepEqual(resolveFromFlag(ctx), { kind: 'skip' });
  });

  it('skips when the flag is boolean true (non-string)', () => {
    const ctx = baseCtx({ flags: { owner: true } });
    assert.deepEqual(resolveFromFlag(ctx), { kind: 'skip' });
  });
});

describe('resolveFromEnv', () => {
  it('returns value when the env var holds a non-empty string', () => {
    const ctx = baseCtx({ env: { GH_OWNER: 'env-owner' } });
    assert.deepEqual(resolveFromEnv(ctx), {
      kind: 'value',
      value: 'env-owner',
    });
  });

  it('skips when the question has no env mapping', () => {
    const ctx = baseCtx({ q: { env: undefined }, env: {} });
    assert.deepEqual(resolveFromEnv(ctx), { kind: 'skip' });
  });

  it('skips when the env var is unset', () => {
    const ctx = baseCtx({ env: {} });
    assert.deepEqual(resolveFromEnv(ctx), { kind: 'skip' });
  });

  it('skips when the env var is an empty string', () => {
    const ctx = baseCtx({ env: { GH_OWNER: '' } });
    assert.deepEqual(resolveFromEnv(ctx), { kind: 'skip' });
  });
});

describe('resolveFromSilent', () => {
  it('returns the default value when the key is in silentSet', () => {
    const ctx = baseCtx({ silentSet: new Set(['owner']) });
    assert.deepEqual(resolveFromSilent(ctx), {
      kind: 'value',
      value: 'acme',
    });
  });

  it('skips when the key is not in silentSet', () => {
    const ctx = baseCtx({ silentSet: new Set() });
    assert.deepEqual(resolveFromSilent(ctx), { kind: 'skip' });
  });

  it('skips when the default is null', () => {
    const ctx = baseCtx({
      silentSet: new Set(['owner']),
      q: { default: null },
    });
    assert.deepEqual(resolveFromSilent(ctx), { kind: 'skip' });
  });

  it('skips when the default is an empty string', () => {
    const ctx = baseCtx({
      silentSet: new Set(['owner']),
      q: { default: '' },
    });
    assert.deepEqual(resolveFromSilent(ctx), { kind: 'skip' });
  });
});

describe('resolveInteractive', () => {
  /** Build a fake readline interface backed by a scripted list of answers. */
  function makeRl(scriptedAnswers) {
    const queue = [...scriptedAnswers];
    return {
      question: async () => {
        if (queue.length === 0) {
          throw new Error('resolveInteractive asked more times than expected');
        }
        return queue.shift();
      },
      close: () => {},
    };
  }

  it('skips when not in interactive mode', async () => {
    const ctx = baseCtx({ interactive: false });
    assert.deepEqual(await resolveInteractive(ctx), { kind: 'skip' });
  });

  it('returns the typed value on the first prompt when validation passes', async () => {
    const rl = makeRl(['typed-owner']);
    const ctx = baseCtx({
      interactive: true,
      getRl: () => Promise.resolve(rl),
    });
    assert.deepEqual(await resolveInteractive(ctx), {
      kind: 'value',
      value: 'typed-owner',
    });
  });

  it('falls back to the default when the user presses Enter on an empty line', async () => {
    const rl = makeRl(['']);
    const ctx = baseCtx({
      interactive: true,
      getRl: () => Promise.resolve(rl),
    });
    assert.deepEqual(await resolveInteractive(ctx), {
      kind: 'value',
      value: 'acme',
    });
  });

  it('re-asks once when validation fails on the first answer', async () => {
    const rl = makeRl(['bad!', 'good']);
    const writes = [];
    const ctx = baseCtx({
      interactive: true,
      getRl: () => Promise.resolve(rl),
      output: { write: (chunk) => writes.push(chunk) },
      q: {
        ...QUESTION,
        validate: (v) => (v.includes('!') ? 'no bang' : null),
      },
    });
    assert.deepEqual(await resolveInteractive(ctx), {
      kind: 'value',
      value: 'good',
    });
    assert.ok(writes.some((w) => w.includes('no bang')));
  });

  it('returns missing after a second validation failure', async () => {
    const rl = makeRl(['bad1', 'bad2']);
    const ctx = baseCtx({
      interactive: true,
      getRl: () => Promise.resolve(rl),
      q: { ...QUESTION, validate: () => 'always bad' },
    });
    assert.deepEqual(await resolveInteractive(ctx), { kind: 'missing' });
  });

  it('returns missing when answer is empty and the question is required without a default', async () => {
    const rl = makeRl(['']);
    const ctx = baseCtx({
      interactive: true,
      getRl: () => Promise.resolve(rl),
      q: { ...QUESTION, default: null, required: true },
    });
    assert.deepEqual(await resolveInteractive(ctx), { kind: 'missing' });
  });
});

describe('resolveAssumeYes', () => {
  it('returns the default when assumeYes is on and a default exists', () => {
    const ctx = baseCtx({ assumeYes: true });
    assert.deepEqual(resolveAssumeYes(ctx), {
      kind: 'value',
      value: 'acme',
    });
  });

  it('skips when assumeYes is off', () => {
    const ctx = baseCtx({ assumeYes: false });
    assert.deepEqual(resolveAssumeYes(ctx), { kind: 'skip' });
  });

  it('returns missing when required and no default', () => {
    const ctx = baseCtx({
      assumeYes: true,
      q: { ...QUESTION, default: null, required: true },
    });
    assert.deepEqual(resolveAssumeYes(ctx), { kind: 'missing' });
  });

  it('skips when not required and no default', () => {
    const ctx = baseCtx({
      assumeYes: true,
      q: { ...QUESTION, default: null, required: false },
    });
    assert.deepEqual(resolveAssumeYes(ctx), { kind: 'skip' });
  });
});

describe('RESOLVERS priority order', () => {
  it('is a frozen array with five resolvers in the documented order', () => {
    assert.equal(RESOLVERS.length, 5);
    assert.equal(RESOLVERS[0], resolveFromFlag);
    assert.equal(RESOLVERS[1], resolveFromEnv);
    assert.equal(RESOLVERS[2], resolveFromSilent);
    assert.equal(RESOLVERS[3], resolveInteractive);
    assert.equal(RESOLVERS[4], resolveAssumeYes);
    assert.ok(Object.isFrozen(RESOLVERS));
  });
});

// PassThrough import smoke (Node 22 ESM): assert the dependency loads when
// run via `node --test` — this is a guard against drift in the test runner
// rather than logic under test.
describe('test-runner smoke', () => {
  it('node:stream PassThrough resolves under ESM', () => {
    assert.equal(typeof PassThrough, 'function');
  });
});
