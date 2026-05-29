import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  Logger,
  NOOP_LOGGER,
  resolveLevel,
  setLevel,
} from '../../.agents/scripts/lib/Logger.js';

describe('Logger', () => {
  beforeEach(() => {
    mock.method(console, 'log', () => {});
    mock.method(console, 'warn', () => {});
    mock.method(console, 'error', () => {});
    mock.method(process, 'exit', () => {});
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it('logs info', () => {
    Logger.info('test info');
    assert.strictEqual(console.log.mock.calls.length, 1);
    assert.strictEqual(
      console.log.mock.calls[0].arguments[0],
      '[Orchestrator] ℹ️ test info',
    );
  });

  it('logs warn', () => {
    Logger.warn('test warn');
    assert.strictEqual(console.warn.mock.calls.length, 1);
    assert.strictEqual(
      console.warn.mock.calls[0].arguments[0],
      '[Orchestrator] ⚠️ test warn',
    );
  });

  it('logs error', () => {
    Logger.error('test error');
    assert.strictEqual(console.error.mock.calls.length, 1);
    assert.strictEqual(
      console.error.mock.calls[0].arguments[0],
      '[Orchestrator] ❌ test error',
    );
  });

  it('logs fatal and exits', () => {
    Logger.fatal('test fatal');
    assert.strictEqual(console.error.mock.calls.length, 1);
    assert.strictEqual(
      console.error.mock.calls[0].arguments[0],
      '[Orchestrator] ❌ test fatal',
    );
    assert.strictEqual(process.exit.mock.calls.length, 1);
    assert.strictEqual(process.exit.mock.calls[0].arguments[0], 1);
  });

  it('debug does not log at default info level', () => {
    Logger.debug('test debug');
    assert.strictEqual(console.error.mock.calls.length, 0);
  });

  it('createProgress defaults to stderr', () => {
    const progress = Logger.createProgress('MyScript');
    progress('phase', 'message');
    assert.strictEqual(console.error.mock.calls.length, 1);
    assert.strictEqual(
      console.error.mock.calls[0].arguments[0],
      '▶ [MyScript] [phase] message',
    );
    assert.strictEqual(console.log.mock.calls.length, 0);
  });

  it('createProgress uses stdout if stderr is false', () => {
    const progress = Logger.createProgress('MyScript', { stderr: false });
    progress('phase', 'message');
    assert.strictEqual(console.log.mock.calls.length, 1);
    assert.strictEqual(
      console.log.mock.calls[0].arguments[0],
      '▶ [MyScript] [phase] message',
    );
    assert.strictEqual(console.error.mock.calls.length, 0);
  });
});

describe('Logger lazy level resolution (Story #3329)', () => {
  // The level seam lets every branch be exercised in-process — no child
  // process per level, unlike the load-time `LEVEL` constant it replaced.
  beforeEach(() => {
    mock.method(console, 'log', () => {});
    mock.method(console, 'warn', () => {});
    mock.method(console, 'error', () => {});
  });

  afterEach(() => {
    setLevel(null);
    mock.restoreAll();
  });

  it('resolveLevel reads AGENT_LOG_LEVEL on every call (env-driven)', () => {
    const prior = process.env.AGENT_LOG_LEVEL;
    try {
      process.env.AGENT_LOG_LEVEL = 'verbose';
      assert.equal(resolveLevel(), 'verbose');
      process.env.AGENT_LOG_LEVEL = 'silent';
      assert.equal(resolveLevel(), 'silent');
      process.env.AGENT_LOG_LEVEL = 'gibberish';
      assert.equal(resolveLevel(), 'info', 'unrecognized → info');
    } finally {
      if (prior === undefined) delete process.env.AGENT_LOG_LEVEL;
      else process.env.AGENT_LOG_LEVEL = prior;
    }
  });

  it('setLevel pins the level and Logger.level reflects it', () => {
    setLevel('verbose');
    assert.equal(Logger.level, 'verbose');
    setLevel('silent');
    assert.equal(Logger.level, 'silent');
  });

  it('setLevel(null) clears the override and restores env resolution', () => {
    const prior = process.env.AGENT_LOG_LEVEL;
    try {
      process.env.AGENT_LOG_LEVEL = 'info';
      setLevel('verbose');
      assert.equal(Logger.level, 'verbose');
      setLevel(null);
      assert.equal(Logger.level, 'info');
    } finally {
      if (prior === undefined) delete process.env.AGENT_LOG_LEVEL;
      else process.env.AGENT_LOG_LEVEL = prior;
    }
  });

  it('setLevel throws RangeError for an unrecognized non-null level', () => {
    assert.throws(() => setLevel('loud'), RangeError);
    assert.throws(() => setLevel(42), RangeError);
  });

  it('silent suppresses every method except fatal (in-process)', () => {
    setLevel('silent');
    Logger.debug('D');
    Logger.info('I');
    Logger.warn('W');
    Logger.error('E');
    assert.equal(console.log.mock.calls.length, 0);
    assert.equal(console.warn.mock.calls.length, 0);
    assert.equal(console.error.mock.calls.length, 0);
  });

  it('verbose enables debug plus every higher level (in-process)', () => {
    setLevel('verbose');
    Logger.debug('D');
    Logger.info('I');
    Logger.warn('W');
    Logger.error('E');
    assert.equal(console.log.mock.calls.length, 1, 'info → stdout');
    assert.equal(console.warn.mock.calls.length, 1, 'warn → console.warn');
    // debug + error both route to stderr → 2 entries.
    assert.equal(console.error.mock.calls.length, 2);
  });

  it('debug level behaves identically to verbose (alias)', () => {
    setLevel('debug');
    Logger.debug('D');
    Logger.error('E');
    assert.equal(console.error.mock.calls.length, 2);
  });

  it('info suppresses debug but emits info/warn/error (in-process)', () => {
    setLevel('info');
    Logger.debug('D');
    Logger.info('I');
    Logger.warn('W');
    Logger.error('E');
    assert.equal(console.log.mock.calls.length, 1);
    assert.equal(console.warn.mock.calls.length, 1);
    assert.equal(console.error.mock.calls.length, 1, 'only error on stderr');
  });

  it('createProgress respects the level resolved at call time', () => {
    setLevel('silent');
    const progress = Logger.createProgress('S');
    progress('phase', 'msg');
    assert.equal(console.error.mock.calls.length, 0);

    setLevel('info');
    progress('phase', 'msg');
    assert.equal(console.error.mock.calls.length, 1);
  });
});

describe('NOOP_LOGGER', () => {
  it('exposes the documented method surface (debug/info/warn/error) but no fatal', () => {
    assert.equal(typeof NOOP_LOGGER.debug, 'function');
    assert.equal(typeof NOOP_LOGGER.info, 'function');
    assert.equal(typeof NOOP_LOGGER.warn, 'function');
    assert.equal(typeof NOOP_LOGGER.error, 'function');
    // fatal is intentionally absent — silencing process-exit is a footgun.
    assert.equal('fatal' in NOOP_LOGGER, false);
  });

  it('every method is a no-op that returns undefined and never throws', () => {
    assert.equal(NOOP_LOGGER.debug('any payload'), undefined);
    assert.equal(NOOP_LOGGER.info('any payload'), undefined);
    assert.equal(NOOP_LOGGER.warn('any payload'), undefined);
    assert.equal(NOOP_LOGGER.error('any payload'), undefined);
  });

  it('is frozen so consumers cannot mutate the shared instance', () => {
    assert.equal(Object.isFrozen(NOOP_LOGGER), true);
    assert.throws(() => {
      NOOP_LOGGER.warn = () => {
        throw new Error('mutated');
      };
    });
  });

  it('carries a `silent` discriminator for callers that branch on it', () => {
    assert.equal(NOOP_LOGGER.silent, true);
  });
});
