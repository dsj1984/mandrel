/**
 * handoff.test.js — `delivery.handoff.postSeatChecks` (Story #5960): the
 * schema accepts `{ cmd, args }` entries and rejects an unknown key, and the
 * getter drops malformed entries.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getPostSeatChecks } from '../../../.agents/scripts/lib/config/handoff.js';
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
