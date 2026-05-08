/**
 * tests/workflows/epic-planner-cli.test.js — unit tests for the
 * extracted `runEpicPlannerCli` (orchestration body of `main`).
 *
 * Covers two structural paths without spawning a process:
 *   - happy path: --emit-context routes to `buildAuthoringContext` and
 *     returns `{ exitCode: 0, kind: 'emit-context' }` with the envelope
 *     that `main` will JSON-stringify; default mode reads PRD/Tech Spec
 *     and routes to `planEpic`.
 *   - validation-failure path: missing/invalid `--epic` and missing
 *     `--prd`/`--techspec` (in default mode) short-circuit with
 *     `exitCode: 1` and `kind: 'validation-error'`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runEpicPlannerCli } from '../../.agents/scripts/epic-planner.js';

const FAKE_CONFIG = {
  orchestration: { provider: 'github' },
  settings: { quality: {} },
};
const FAKE_RESOLVE_CONFIG = () => FAKE_CONFIG;
const FAKE_PROVIDER = { id: 'stub' };
const FAKE_CREATE_PROVIDER = () => FAKE_PROVIDER;

describe('runEpicPlannerCli', () => {
  it('happy path: --emit-context returns kind=emit-context with the built context', async () => {
    let captured;
    const fakeBuild = async (epicId, provider, settings, opts) => {
      captured = { epicId, provider, settings, opts };
      return { epic: { id: epicId, body: 'Body' }, docs: [] };
    };

    const out = await runEpicPlannerCli(
      {
        epic: '42',
        'emit-context': true,
        pretty: true,
        'full-context': true,
      },
      {
        resolveConfig: FAKE_RESOLVE_CONFIG,
        createProvider: FAKE_CREATE_PROVIDER,
        buildAuthoringContext: fakeBuild,
        planEpic: () => {
          throw new Error('planEpic must not run for --emit-context');
        },
      },
    );

    assert.equal(out.exitCode, 0);
    assert.equal(out.result.kind, 'emit-context');
    assert.equal(out.result.pretty, true);
    assert.equal(out.result.context.epic.id, 42);
    assert.equal(captured.epicId, 42);
    assert.equal(captured.provider, FAKE_PROVIDER);
    assert.equal(captured.opts.fullContext, true);
  });

  it('happy path: default mode reads PRD/Tech Spec and routes to planEpic', async () => {
    const reads = [];
    const fakeRead = async (path) => {
      reads.push(path);
      return path === '/tmp/prd.md' ? 'PRD body' : 'TS body';
    };
    let planArgs;
    const fakePlan = async (epicId, provider, content, settings, opts) => {
      planArgs = { epicId, provider, content, settings, opts };
    };

    const out = await runEpicPlannerCli(
      {
        epic: '777',
        prd: '/tmp/prd.md',
        techspec: '/tmp/ts.md',
        force: true,
      },
      {
        resolveConfig: FAKE_RESOLVE_CONFIG,
        createProvider: FAKE_CREATE_PROVIDER,
        readFile: fakeRead,
        planEpic: fakePlan,
        buildAuthoringContext: () => {
          throw new Error('buildAuthoringContext must not run in plan mode');
        },
      },
    );

    assert.equal(out.exitCode, 0);
    assert.equal(out.result.kind, 'plan');
    assert.equal(out.result.epicId, 777);
    assert.deepEqual(reads, ['/tmp/prd.md', '/tmp/ts.md']);
    assert.equal(planArgs.epicId, 777);
    assert.equal(planArgs.content.prdContent, 'PRD body');
    assert.equal(planArgs.content.techSpecContent, 'TS body');
    assert.equal(planArgs.opts.force, true);
  });

  it('validation-failure: missing --epic returns exitCode 1', async () => {
    const out = await runEpicPlannerCli(
      { epic: undefined },
      {
        resolveConfig: () => {
          throw new Error('resolveConfig must not run before validation');
        },
        buildAuthoringContext: () => {
          throw new Error('buildAuthoringContext must not run');
        },
        planEpic: () => {
          throw new Error('planEpic must not run');
        },
      },
    );
    assert.equal(out.exitCode, 1);
    assert.equal(out.result.kind, 'validation-error');
    assert.match(out.result.message, /Usage: epic-planner.js --epic/);
  });

  it('validation-failure: non-numeric --epic returns exitCode 1', async () => {
    const out = await runEpicPlannerCli(
      { epic: 'abc' },
      { resolveConfig: () => FAKE_CONFIG },
    );
    assert.equal(out.exitCode, 1);
    assert.equal(out.result.kind, 'validation-error');
    assert.match(out.result.message, /Invalid epic ID: "abc"/);
  });

  it('validation-failure: default mode without --prd/--techspec returns exitCode 1', async () => {
    const out = await runEpicPlannerCli(
      { epic: '42' },
      {
        resolveConfig: FAKE_RESOLVE_CONFIG,
        createProvider: FAKE_CREATE_PROVIDER,
        readFile: () => {
          throw new Error('readFile must not run before validation');
        },
        planEpic: () => {
          throw new Error('planEpic must not run before validation');
        },
      },
    );
    assert.equal(out.exitCode, 1);
    assert.equal(out.result.kind, 'validation-error');
    assert.match(out.result.message, /Missing --prd and\/or --techspec/);
  });

  it('validation-failure: missing only --techspec triggers the same error', async () => {
    const out = await runEpicPlannerCli(
      { epic: '42', prd: '/tmp/prd.md' },
      {
        resolveConfig: FAKE_RESOLVE_CONFIG,
        createProvider: FAKE_CREATE_PROVIDER,
      },
    );
    assert.equal(out.exitCode, 1);
    assert.match(out.result.message, /Missing --prd and\/or --techspec/);
  });
});
