import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseRetroRunArgs,
  runRetroCli,
} from '../../.agents/scripts/retro-run.js';

describe('parseRetroRunArgs', () => {
  it('parses --epic into a positive integer', () => {
    const out = parseRetroRunArgs(['--epic', '2172']);
    assert.deepEqual(out, { epicId: 2172, fullRetro: false, help: false });
  });

  it('parses --full-retro as a boolean flag', () => {
    const out = parseRetroRunArgs(['--epic', '7', '--full-retro']);
    assert.equal(out.epicId, 7);
    assert.equal(out.fullRetro, true);
  });

  it('returns null epicId for missing / invalid input', () => {
    assert.equal(parseRetroRunArgs([]).epicId, null);
    assert.equal(parseRetroRunArgs(['--epic', 'nope']).epicId, null);
  });

  it('rejects non-positive epic ids', () => {
    assert.equal(parseRetroRunArgs(['--epic', '0']).epicId, null);
    assert.equal(parseRetroRunArgs(['--epic', '-3']).epicId, null);
  });

  it('parses -h as help', () => {
    assert.equal(parseRetroRunArgs(['-h']).help, true);
  });
});

/**
 * Minimal fake bus exposing the LedgerWriter privileged seam
 * (onEmitted/onCompleted/onFailed) plus emit/on. Records every emit so
 * the test can assert that `retro.start` / `retro.end` reached the ledger
 * via the registered writer.
 */
function createFakeBus() {
  const emitted = [];
  const emittedHooks = [];
  const completedHooks = [];
  let seqId = 1;
  return {
    emitted,
    on() {
      return () => {};
    },
    onEmitted(fn) {
      emittedHooks.push(fn);
    },
    onCompleted(fn) {
      completedHooks.push(fn);
    },
    onFailed() {},
    async emit(event, payload) {
      const id = seqId++;
      for (const fn of emittedHooks) fn({ event, seqId: id, payload });
      emitted.push({ event, payload });
      for (const fn of completedHooks) fn({ event, seqId: id });
      return { seqId: id };
    },
  };
}

describe('runRetroCli', () => {
  it('wires a ledger writer onto the bus and returns the result envelope', async () => {
    const registeredBuses = [];
    const runRetroCalls = [];
    const fakeBus = createFakeBus();
    const out = await runRetroCli({
      epicId: 2172,
      fullRetro: false,
      injectedConfig: { project: { paths: { tempRoot: 'temp' } } },
      injectedProvider: { kind: 'fake' },
      busFactory: () => fakeBus,
      ledgerFactory: ({ epicId, tempRoot }) => ({
        ledgerPath: `${tempRoot}/epic-${epicId}/lifecycle.ndjson`,
        register(bus) {
          registeredBuses.push(bus);
        },
      }),
      runRetroFn: async (opts) => {
        runRetroCalls.push(opts);
        // Simulate the real runRetro emitting boundaries through the bus.
        await opts.bus.emit('retro.start', { epicId: opts.epicId });
        await opts.bus.emit('retro.end', {
          epicId: opts.epicId,
          posted: true,
        });
        return { posted: true, compact: true, commentId: 999 };
      },
    });

    assert.deepEqual(out, {
      epicId: 2172,
      posted: true,
      compact: true,
      ledgerPath: 'temp/epic-2172/lifecycle.ndjson',
      commentId: 999,
    });
    // The ledger writer was registered against the same bus runRetro used.
    assert.equal(registeredBuses.length, 1);
    assert.equal(registeredBuses[0], fakeBus);
    // runRetro received the bus + forceFull mapping.
    assert.equal(runRetroCalls.length, 1);
    assert.equal(runRetroCalls[0].bus, fakeBus);
    assert.equal(runRetroCalls[0].forceFull, false);
    assert.equal(runRetroCalls[0].epicId, 2172);
    // retro.start / retro.end reached the (ledger-registered) bus.
    const events = fakeBus.emitted.map((e) => e.event);
    assert.deepEqual(events, ['retro.start', 'retro.end']);
  });

  it('maps --full-retro to runRetro forceFull', async () => {
    let captured = null;
    await runRetroCli({
      epicId: 5,
      fullRetro: true,
      injectedConfig: { project: { paths: { tempRoot: 'temp' } } },
      injectedProvider: {},
      busFactory: () => createFakeBus(),
      ledgerFactory: () => ({ ledgerPath: 'p', register() {} }),
      runRetroFn: async (opts) => {
        captured = opts;
        return { posted: true, compact: false };
      },
    });
    assert.equal(captured.forceFull, true);
  });

  it('omits commentId when runRetro returns none', async () => {
    const out = await runRetroCli({
      epicId: 9,
      injectedConfig: { project: { paths: { tempRoot: 'temp' } } },
      injectedProvider: {},
      busFactory: () => createFakeBus(),
      ledgerFactory: () => ({ ledgerPath: 'p', register() {} }),
      runRetroFn: async () => ({ posted: false, compact: true }),
    });
    assert.equal(Object.hasOwn(out, 'commentId'), false);
    assert.equal(out.posted, false);
  });

  it('rejects a non-positive epicId before touching the bus', async () => {
    await assert.rejects(
      () => runRetroCli({ epicId: 0, injectedProvider: {} }),
      /positive integer/,
    );
  });
});
