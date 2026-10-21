import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  KNOWN_KINDS,
  parseArgs,
} from '../../.agents/scripts/lib/orchestration/check-baselines/phases/parse-args.js';

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

  it('accepts every known kind', () => {
    assert.deepEqual(parseArgs(['--gate', KNOWN_KINDS.join(',')]).gates, [
      ...KNOWN_KINDS,
    ]);
  });
});
