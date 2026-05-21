import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseArgv,
  validateRequiredArgs,
} from '../.agents/scripts/resync-status-column.js';

describe('resync-status-column CLI', () => {
  it('accepts --ticket', () => {
    const v = parseArgv(['--ticket', '2813']);
    const { ticketId, errors } = validateRequiredArgs(v);
    assert.equal(ticketId, 2813);
    assert.deepEqual(errors, []);
  });

  it('accepts --story as an alias for --ticket', () => {
    const v = parseArgv(['--story', '2813']);
    const { ticketId, errors } = validateRequiredArgs(v);
    assert.equal(ticketId, 2813);
    assert.deepEqual(errors, []);
  });

  it('rejects missing id with a clear message', () => {
    const { errors } = validateRequiredArgs(parseArgv([]));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /--ticket <id> .* --story <id>.* required/);
  });

  it('rejects non-positive ids', () => {
    const { errors } = validateRequiredArgs(parseArgv(['--ticket', '0']));
    assert.equal(errors.length, 1);
  });

  it('rejects non-numeric ids', () => {
    const { errors } = validateRequiredArgs(
      parseArgv(['--ticket', 'not-a-number']),
    );
    assert.equal(errors.length, 1);
  });
});
