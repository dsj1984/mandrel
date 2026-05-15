/**
 * epic-close-preflight.test.js — Unit tests for the new epic-close.js
 * front-door preflight guard.
 *
 * The script delegates preflight to `runPreflight` from
 * `.agents/scripts/lib/preflight-runner.js`. These tests drive
 * `runEpicClose` directly with an inline fixture registry — no disk
 * discovery, no real probes — and assert:
 *
 *   1. A fixture blocker yields `{ status: 'blocked' }` with the blocker
 *      visible in `findings[]` AND the blocker table (`fixCommand`
 *      included) printed to the captured logger.
 *   2. An empty registry / no findings yields `{ status: 'ok' }` and
 *      proceeds normally (the placeholder close-tail message lands).
 *   3. Auto-correctable findings are routed to `fixed[]` and a
 *      `[preflight] auto-fixed N finding(s)` log line is emitted; they
 *      never appear in `findings[]` and never block.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { runEpicClose } from '../.agents/scripts/epic-close.js';

/** Spy logger that captures every level. */
function makeLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    info: (...a) => lines.info.push(a.join(' ')),
    warn: (...a) => lines.warn.push(a.join(' ')),
    error: (...a) => lines.error.push(a.join(' ')),
    _lines: lines,
    _all: () => [...lines.info, ...lines.warn, ...lines.error].join('\n'),
  };
}

/** Inline state probes — always return safe empty projections. */
const noopProbes = {
  git: () => ({ ok: true, stdout: '' }),
  fs: () => false,
  env: () => 'missing',
  lock: () => ({ exists: false }),
  pidLiveness: () => false,
};

describe('runEpicClose preflight', () => {
  beforeEach(() => {
    // Tests use an explicit `registry` parameter so the disk cache is
    // never touched; no clearRegistryCache call needed.
  });

  it('exits blocked with fixCommand visible when a blocker check fires', async () => {
    const logger = makeLogger();
    const blockerCheck = {
      id: 'fixture-epic-close-blocker',
      severity: 'blocker',
      scope: ['epic-close'],
      autoCorrect: 'refuse-and-print',
      detect() {
        return {
          id: 'fixture-epic-close-blocker',
          severity: 'blocker',
          scope: 'epic-close',
          summary: 'fixture epic-close blocker fires',
          fixCommand: 'echo run-this-by-hand',
          autoCorrectable: false,
        };
      },
    };
    const result = await runEpicClose({
      epicId: 1143,
      probes: noopProbes,
      registry: [blockerCheck],
      logger,
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].id, 'fixture-epic-close-blocker');
    // Blocker table must include the fixCommand for operator copy-paste.
    const stderr = logger._lines.error.join('\n');
    assert.match(stderr, /fixture-epic-close-blocker/);
    assert.match(stderr, /echo run-this-by-hand/);
    assert.match(stderr, /exit 2/);
  });

  it('proceeds with status ok when no findings exist (empty registry)', async () => {
    const logger = makeLogger();
    const tailCalls = [];
    const stubTail = async (args) => {
      tailCalls.push(args);
      return {
        planningClose: {
          prd: { id: null, status: 'skipped' },
          techSpec: { id: null, status: 'skipped' },
        },
        epicClose: { status: 'already-closed' },
      };
    };
    const result = await runEpicClose({
      epicId: 1143,
      probes: noopProbes,
      registry: [],
      logger,
      runEpicCloseTailFn: stubTail,
      injectedProvider: {},
      injectedConfig: { orchestration: {} },
    });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.fixed, []);
    // Close-tail ran with the parsed epicId.
    assert.equal(tailCalls.length, 1);
    assert.equal(tailCalls[0].epicId, 1143);
    // Close-tail completion lands on info.
    const info = logger._lines.info.join('\n');
    assert.match(info, /\[epic-close\] complete/);
  });

  it('skips close-tail when --epic is not supplied (preflight-only mode)', async () => {
    const logger = makeLogger();
    let tailCalled = false;
    const result = await runEpicClose({
      probes: noopProbes,
      registry: [],
      logger,
      runEpicCloseTailFn: async () => {
        tailCalled = true;
        return {};
      },
    });
    assert.equal(result.status, 'ok');
    assert.equal(tailCalled, false);
    const warn = logger._lines.warn.join('\n');
    assert.match(warn, /skipping close-tail/);
  });

  it('logs auto-corrected findings via logFixes without blocking', async () => {
    const logger = makeLogger();
    let fixCalls = 0;
    const stubTail = async () => ({
      planningClose: {
        prd: { id: null, status: 'skipped' },
        techSpec: { id: null, status: 'skipped' },
      },
      epicClose: { status: 'already-closed' },
    });
    const autoCheck = {
      id: 'fixture-epic-close-auto',
      severity: 'warning',
      scope: ['epic-close'],
      autoCorrect: 'auto',
      detect() {
        return {
          id: 'fixture-epic-close-auto',
          severity: 'warning',
          scope: 'epic-close',
          summary: 'fixture auto warning',
          fixCommand: 'echo auto',
          autoCorrectable: true,
        };
      },
      fix() {
        fixCalls += 1;
        return { ok: true, message: 'auto-corrected the thing' };
      },
    };
    const result = await runEpicClose({
      epicId: 1143,
      probes: noopProbes,
      registry: [autoCheck],
      logger,
      runEpicCloseTailFn: stubTail,
      injectedProvider: {},
      injectedConfig: { orchestration: {} },
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.findings.length, 0);
    assert.equal(result.fixed.length, 1);
    assert.equal(fixCalls, 1);
    const info = logger._lines.info.join('\n');
    assert.match(info, /auto-fixed 1 finding/);
    assert.match(info, /auto-corrected the thing/);
  });
});
