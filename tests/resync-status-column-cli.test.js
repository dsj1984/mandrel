import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildReassertOptions,
  parseArgv,
  resolveEffectiveConfig,
  validateRequiredArgs,
  writeUsageErrors,
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

  it('overrides the provider only when --provider is supplied', () => {
    const baseConfig = { provider: 'github', github: { owner: 'dsj1984' } };

    assert.equal(resolveEffectiveConfig(baseConfig), baseConfig);
    assert.deepEqual(resolveEffectiveConfig(baseConfig, 'mock'), {
      provider: 'mock',
      github: { owner: 'dsj1984' },
    });
  });

  it('builds reassert options with optional polling settings only when present', () => {
    const provider = {};
    const logger = {};

    assert.deepEqual(
      buildReassertOptions({ provider, ticketId: 2813, logger }),
      { provider, ticketId: 2813, logger },
    );
    assert.deepEqual(
      buildReassertOptions({
        provider,
        ticketId: 2813,
        logger,
        pollAttempts: 2,
        pollDelayMs: 0,
      }),
      { provider, ticketId: 2813, logger, pollAttempts: 2, pollDelayMs: 0 },
    );
  });

  it('writes validation errors with the usage text', () => {
    let stderr = '';
    writeUsageErrors(['bad ticket'], {
      write(chunk) {
        stderr += chunk;
      },
    });

    assert.match(stderr, /\[resync-status-column\] bad ticket/);
    assert.match(
      stderr,
      /Usage: node \.agents\/scripts\/resync-status-column\.js/,
    );
  });
});
