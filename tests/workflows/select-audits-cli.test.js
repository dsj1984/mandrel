/**
 * tests/workflows/select-audits-cli.test.js — unit tests for the
 * extracted `runSelectAuditsCli` (orchestration body of `main`).
 *
 * Covers two structural paths without spawning a process:
 *   - happy path: `selectAudits` runner returns a normal envelope; CLI
 *     wrapper returns `{ exitCode: 0, result.kind: 'envelope' }`.
 *   - validation-failure path: missing `--ticket` / `--gate` short-circuit
 *     before any provider construction with `exitCode: 2`.
 *
 * The runner / provider / config are injected via the deps bag so the
 * tests never reach `resolveConfig` or the real GitHub provider.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runSelectAuditsCli } from '../../.agents/scripts/select-audits.js';

const RESOLVE_CONFIG = () => ({ orchestration: { provider: 'github' } });
const STUB_PROVIDER = { id: 'stub' };
const STUB_CREATE_PROVIDER = () => STUB_PROVIDER;

describe('runSelectAuditsCli', () => {
  it('happy path: returns exitCode 0 with kind=envelope', async () => {
    const observed = [];
    const fakeSelect = async (args) => {
      observed.push(args);
      return {
        selectedAudits: ['security'],
        ticketId: args.ticketId,
        gate: args.gate,
        context: { changedFilesCount: 0, ticketTitle: 'Test' },
      };
    };

    const out = await runSelectAuditsCli(
      {
        ticketId: 42,
        gate: 'gate1',
        baseBranch: 'main',
        gateMode: false,
      },
      {
        resolveConfig: RESOLVE_CONFIG,
        createProvider: STUB_CREATE_PROVIDER,
        selectAudits: fakeSelect,
        env: { CI: '1' },
      },
    );

    assert.equal(out.exitCode, 0);
    assert.equal(out.result.kind, 'envelope');
    assert.deepEqual(out.result.envelope.selectedAudits, ['security']);
    // The wrapper hands the runner the resolved provider + gateModeOpts.
    assert.equal(observed.length, 1);
    assert.equal(observed[0].provider, STUB_PROVIDER);
    assert.equal(observed[0].baseBranch, 'main');
    assert.deepEqual(observed[0].gateModeOpts.argv, []);
  });

  it('happy path: degraded envelope yields exitCode 1', async () => {
    const out = await runSelectAuditsCli(
      { ticketId: 42, gate: 'gate1', baseBranch: 'main' },
      {
        resolveConfig: RESOLVE_CONFIG,
        createProvider: STUB_CREATE_PROVIDER,
        selectAudits: async () => ({
          ok: false,
          degraded: true,
          reason: 'SOFT_FAIL',
          detail: 'simulated soft fail for test',
        }),
      },
    );
    assert.equal(out.exitCode, 1);
    assert.equal(out.result.kind, 'envelope');
    assert.equal(out.result.envelope.degraded, true);
  });

  it('happy path: gateMode propagates --gate-mode to the runner argv', async () => {
    let captured;
    await runSelectAuditsCli(
      { ticketId: 1, gate: 'gate2', baseBranch: 'main', gateMode: true },
      {
        resolveConfig: RESOLVE_CONFIG,
        createProvider: STUB_CREATE_PROVIDER,
        selectAudits: async (args) => {
          captured = args;
          return { selectedAudits: [], ticketId: 1, gate: 'gate2' };
        },
      },
    );
    assert.deepEqual(captured.gateModeOpts.argv, ['--gate-mode']);
  });

  it('help flag short-circuits with exitCode 0 and kind=help', async () => {
    const out = await runSelectAuditsCli(
      { help: true },
      {
        resolveConfig: () => {
          throw new Error('resolveConfig must not run when --help is set');
        },
      },
    );
    assert.equal(out.exitCode, 0);
    assert.equal(out.result.kind, 'help');
    assert.match(out.result.text, /Usage:/);
  });

  it('validation-failure: missing ticketId returns exitCode 2', async () => {
    const out = await runSelectAuditsCli(
      { ticketId: undefined, gate: 'gate1', baseBranch: 'main' },
      {
        resolveConfig: () => {
          throw new Error('resolveConfig must not run before validation');
        },
        selectAudits: () => {
          throw new Error('runner must not run before validation');
        },
      },
    );
    assert.equal(out.exitCode, 2);
    assert.equal(out.result.kind, 'validation-error');
    assert.match(out.result.message, /--ticket <id> is required/);
  });

  it('validation-failure: ticketId 0 is rejected (must be > 0)', async () => {
    const out = await runSelectAuditsCli(
      { ticketId: 0, gate: 'gate1', baseBranch: 'main' },
      { resolveConfig: () => ({ orchestration: {} }) },
    );
    assert.equal(out.exitCode, 2);
    assert.equal(out.result.kind, 'validation-error');
    assert.match(out.result.message, /--ticket/);
  });

  it('validation-failure: missing gate returns exitCode 2', async () => {
    const out = await runSelectAuditsCli(
      { ticketId: 42, gate: undefined, baseBranch: 'main' },
      { resolveConfig: () => ({ orchestration: {} }) },
    );
    assert.equal(out.exitCode, 2);
    assert.equal(out.result.kind, 'validation-error');
    assert.match(out.result.message, /--gate <gate> is required/);
  });
});
