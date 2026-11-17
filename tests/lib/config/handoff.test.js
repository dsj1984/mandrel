/**
 * handoff.test.js — `delivery.handoff.postSeatChecks` (Story #5960): the
 * schema accepts `{ cmd, args }` entries and rejects an unknown key, and the
 * getter drops malformed entries.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getFirstChecks,
  getPostSeatChecks,
} from '../../../.agents/scripts/lib/config/handoff.js';
import { getAgentrcValidator } from '../../../.agents/scripts/lib/config-settings-schema.js';

const validate = getAgentrcValidator();
const docWith = (handoff) => ({
  project: {
    paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
  },
  delivery: { handoff },
});

describe('delivery.handoff schema (AC-10)', () => {
  it('accepts postSeatChecks as an array of { cmd, args }', () => {
    const ok = validate(
      docWith({
        postSeatChecks: [
          { cmd: 'node', args: ['scripts/rows.js'] },
          { cmd: 'make' },
        ],
      }),
    );
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('rejects an unknown key under delivery.handoff and inside an entry', () => {
    assert.equal(validate(docWith({ postSeatCheck: [] })), false);
    assert.equal(
      validate(docWith({ postSeatChecks: [{ cmd: 'x', shell: true }] })),
      false,
    );
  });
});

describe('getPostSeatChecks', () => {
  it('defaults to [] and drops malformed entries', () => {
    assert.deepEqual(getPostSeatChecks({}), []);
    assert.deepEqual(
      getPostSeatChecks({
        delivery: {
          handoff: {
            postSeatChecks: [
              { cmd: 'node', args: ['a.js'] },
              { cmd: '' },
              { cmd: 'x', args: [1] },
              null,
              { cmd: 'make' },
            ],
          },
        },
      }),
      [
        { cmd: 'node', args: ['a.js'] },
        { cmd: 'make', args: [] },
      ],
    );
  });
});

describe('delivery.handoff.firstChecks (Story #6099 AC-9)', () => {
  it('validates as an optional array of { cmd, args? }', () => {
    assert.equal(validate(docWith({})), true, JSON.stringify(validate.errors));
    const ok = validate(
      docWith({ firstChecks: [{ cmd: 'node', args: ['a.js'] }, { cmd: 'x' }] }),
    );
    assert.equal(ok, true, JSON.stringify(validate.errors));
    for (const bad of [
      [{ args: ['a'] }],
      [{ cmd: 'x', args: [1] }],
      [{ cmd: 'x', shell: true }],
      'node a.js',
    ]) {
      assert.equal(validate(docWith({ firstChecks: bad })), false);
    }
  });

  it('the getter defaults to [] and drops a malformed entry', () => {
    assert.deepEqual(getFirstChecks({}), []);
    assert.deepEqual(
      getFirstChecks({
        delivery: {
          handoff: {
            firstChecks: [
              { cmd: 'a' },
              { args: ['x'] },
              { cmd: 'b', args: [2] },
            ],
          },
        },
      }),
      [{ cmd: 'a', args: [] }],
    );
  });
});
