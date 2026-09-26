/**
 * signal-validator.js — the schema compiles lazily (Story #5445).
 *
 * Every CLI that imports the signals writer used to pay the AJV compile at
 * module load, even for `--help`. These tests pin that importing the module
 * compiles nothing, the first `validateSignal` call compiles once for the
 * process, and a compile failure still warns once and fails open.
 *
 * Each test imports a fresh module instance (cache-busting query) so its
 * memoised validator starts unbuilt; `ajv` and `Logger` stay shared, which is
 * what lets the test observe them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import Ajv from 'ajv';

import { Logger } from '../../../.agents/scripts/lib/Logger.js';

const VALIDATOR_URL = new URL(
  '../../../.agents/scripts/lib/observability/signal-validator.js',
  import.meta.url,
).href;

let freshCount = 0;

/** A module instance whose memoised validator has never been built. */
function importFresh() {
  freshCount += 1;
  return import(`${VALIDATOR_URL}?fresh=${freshCount}`);
}

/** The prototype that owns `compile`, so a mock sees every instance's call. */
function compileOwner() {
  let proto = Ajv.prototype;
  while (proto && !Object.hasOwn(proto, 'compile')) {
    proto = Object.getPrototypeOf(proto);
  }
  assert.ok(proto, 'Ajv exposes a compile method');
  return proto;
}

describe('signal-validator — lazy schema compile', () => {
  it('compiles nothing at import and exactly once on first use', async (t) => {
    const compile = t.mock.method(compileOwner(), 'compile');
    const { validateSignal } = await importFresh();
    assert.equal(compile.mock.callCount(), 0, 'import must not compile');

    const first = validateSignal({});
    assert.equal(first.valid, false, 'the compiled schema rejects {}');
    assert.equal(compile.mock.callCount(), 1, 'first call compiles');

    validateSignal({});
    validateSignal('not an object');
    assert.equal(compile.mock.callCount(), 1, 'the validator is memoised');
  });

  it('a compile failure warns once and disables validation for the process', async (t) => {
    const compile = t.mock.method(compileOwner(), 'compile', () => {
      throw new Error('boom');
    });
    const warn = t.mock.method(Logger, 'warn', () => {});
    const { validateSignal } = await importFresh();
    assert.equal(warn.mock.callCount(), 0, 'import must not warn');

    const open = { valid: true, violatingField: null, message: null };
    assert.deepEqual(validateSignal({}), open);
    assert.deepEqual(validateSignal('not an object'), open);

    assert.equal(
      compile.mock.callCount(),
      1,
      'a failed compile is not retried',
    );
    assert.equal(warn.mock.callCount(), 1, 'the failure warns exactly once');
    const [message] = warn.mock.calls[0].arguments;
    assert.match(message, /failed to compile signal-event schema \(boom\)/);
    assert.match(message, /write-time validation disabled for this process/);
  });
});
