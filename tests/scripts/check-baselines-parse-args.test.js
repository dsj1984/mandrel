import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ALL_KINDS } from '../../.agents/scripts/lib/audit-baselines/kinds.js';
import {
  KNOWN_KINDS,
  parseArgs,
} from '../../.agents/scripts/lib/orchestration/check-baselines/phases/parse-args.js';

const RATCHET_KINDS = ALL_KINDS.filter((k) => !KNOWN_KINDS.includes(k));

describe('check-baselines parseArgs — --gate kinds', () => {
  it('rejects an unknown kind, naming every valid kind', () => {
    assert.throws(
      () => parseArgs(['--gate', 'cyclomatic']),
      (err) =>
        /unknown --gate kind "cyclomatic"/.test(err.message) &&
        KNOWN_KINDS.every((k) => err.message.includes(k)) &&
        /check-cyclomatic\.js/.test(err.message),
    );
  });

  it('rejects an unknown kind mixed with valid ones', () => {
    assert.throws(
      () => parseArgs(['--gate', 'coverage,dead-exports']),
      /unknown --gate kind "dead-exports"/,
    );
  });

  it('derives a non-empty ratchet set from the audit surface', () => {
    assert.ok(RATCHET_KINDS.includes('dead-exports-production'));
  });

  for (const kind of RATCHET_KINDS) {
    it(`points ratchet kind ${kind} at its standalone checker`, () => {
      assert.throws(
        () => parseArgs(['--gate', kind]),
        new RegExp(`${kind} \\(node \\.agents/scripts/check-[a-z-]+\\.js`),
      );
    });
  }

  it('names the --production form for dead-exports-production', () => {
    assert.throws(
      () => parseArgs(['--gate', 'dead-exports-production']),
      /dead-exports-production \(node \.agents\/scripts\/check-dead-exports\.js --production\)/,
    );
  });

  it('accepts every known kind', () => {
    assert.deepEqual(parseArgs(['--gate', KNOWN_KINDS.join(',')]).gates, [
      ...KNOWN_KINDS,
    ]);
  });
});
