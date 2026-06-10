/**
 * bootstrap-main-phases.test — Story #2459 / Task #2471, repointed at the
 * collapsed orchestrator by Story #3690.
 *
 * Exercises the phase helpers exported by `bootstrap.js` (the single
 * bootstrap orchestrator):
 *
 *   1. parseAndValidate
 *   2. prepareContext
 *   3. collectAndConfirm        (flag/assume-yes resolution; no gh spawned —
 *                                exercised with --skip-github)
 *   4. dryRunPlan               (the --dry-run halt gate)
 *   5. executeGithubBootstrap   (smoke — skip behaviour)
 *   6. runPipeline              (short-circuit semantics that gate the
 *                                fail-before-mutate contract)
 *
 * The driver `main()` is the trivial composer over these phases; its
 * end-to-end behaviour is already covered by `tests/bootstrap.test.js`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseAndValidate,
  prepareContext,
  runPipeline,
} from '../../.agents/scripts/bootstrap.js';

describe('parseAndValidate', () => {
  it('halts with exit 0 and writes HELP when --help is passed', () => {
    const chunks = [];
    const stdout = { write: (chunk) => chunks.push(chunk) };
    const res = parseAndValidate(['--help'], {
      stdout,
      env: {},
      stdin: { isTTY: true },
    });
    assert.deepEqual(res, { ok: false, exit: 0 });
    assert.ok(chunks.some((c) => c.includes('bootstrap.js')));
  });

  it('advances when interactive (stdin.isTTY) regardless of flags', () => {
    const res = parseAndValidate([], {
      stdout: { write: () => {} },
      env: {},
      stdin: { isTTY: true },
    });
    assert.equal(res.ok, true);
    assert.equal(res.payload.interactive, true);
    assert.equal(res.payload.assumeYes, false);
  });

  it('halts with exit 1 in non-TTY mode without --assume-yes when owner/repo are missing', () => {
    const res = parseAndValidate([], {
      stdout: { write: () => {} },
      env: {},
      stdin: { isTTY: false },
    });
    assert.equal(res.ok, false);
    assert.equal(res.exit, 1);
  });

  it('advances in non-TTY mode without --assume-yes when owner+repo flags are supplied', () => {
    const res = parseAndValidate(['--owner', 'acme', '--repo', 'widget'], {
      stdout: { write: () => {} },
      env: {},
      stdin: { isTTY: false },
    });
    assert.equal(res.ok, true);
  });

  it('advances in non-TTY mode when --assume-yes plus owner/repo are present', () => {
    const res = parseAndValidate(
      ['--assume-yes', '--owner', 'acme', '--repo', 'widget'],
      {
        stdout: { write: () => {} },
        env: {},
        stdin: { isTTY: false },
      },
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.assumeYes, true);
    assert.equal(res.payload.interactive, false);
  });

  it('honours GH_OWNER / GH_REPO env vars as a substitute for the flags', () => {
    const res = parseAndValidate(['--assume-yes'], {
      stdout: { write: () => {} },
      env: { GH_OWNER: 'acme', GH_REPO: 'widget' },
      stdin: { isTTY: false },
    });
    assert.equal(res.ok, true);
  });

  it('halts with exit 1 on an unrecognized --visibility value', () => {
    const res = parseAndValidate(
      [
        '--assume-yes',
        '--owner',
        'acme',
        '--repo',
        'widget',
        '--visibility',
        'secret',
      ],
      {
        stdout: { write: () => {} },
        env: {},
        stdin: { isTTY: false },
      },
    );
    assert.equal(res.ok, false);
    assert.equal(res.exit, 1);
  });
});

describe('prepareContext', () => {
  it('returns paths, defaults, and silentAccept', () => {
    const state = {
      flags: {},
      interactive: false,
    };
    const res = prepareContext(state, {
      scriptUrl: import.meta.url,
      projectRoot: process.cwd(),
    });
    assert.equal(res.ok, true);
    assert.equal(typeof res.payload.projectRoot, 'string');
    assert.equal(typeof res.payload.agentRoot, 'string');
    assert.ok('owner' in res.payload.defaults);
    assert.ok(Array.isArray(res.payload.silentAccept));
  });

  it('always advances; never halts', () => {
    const res = prepareContext(
      { flags: { owner: 'override' }, interactive: false },
      { scriptUrl: import.meta.url, projectRoot: process.cwd() },
    );
    assert.equal(res.ok, true);
  });
});

describe('main() pipeline shape', () => {
  it('exports the pipeline phase helpers', async () => {
    const mod = await import('../../.agents/scripts/bootstrap.js');
    assert.equal(typeof mod.parseAndValidate, 'function');
    assert.equal(typeof mod.prepareContext, 'function');
    assert.equal(typeof mod.runPreflightPhase, 'function');
    assert.equal(typeof mod.collectAndConfirm, 'function');
    assert.equal(typeof mod.dryRunPlan, 'function');
    assert.equal(typeof mod.provisionResources, 'function');
    assert.equal(typeof mod.executeBootstrap, 'function');
    assert.equal(typeof mod.persistProjectNumber, 'function');
    assert.equal(typeof mod.executeGithubBootstrap, 'function');
    assert.equal(typeof mod.recordLedger, 'function');
    assert.equal(typeof mod.runPipeline, 'function');
    assert.equal(typeof mod.main, 'function');
  });

  it('main() short-circuits on --help with exit code 0', async () => {
    const { main } = await import('../../.agents/scripts/bootstrap.js');
    // Hijack process.stdout.write so the HELP string doesn't pollute
    // the test runner's output.
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try {
      const code = await main(['--help']);
      assert.equal(code, 0);
    } finally {
      process.stdout.write = origWrite;
    }
  });
});

describe('runPipeline', () => {
  it('threads accumulated payloads through each phase', async () => {
    const seen = [];
    const res = await runPipeline([
      () => ({ ok: true, payload: { a: 1 } }),
      (s) => {
        seen.push(s.a);
        return { ok: true, payload: { b: s.a + 1 } };
      },
    ]);
    assert.equal(res.ok, true);
    assert.deepEqual(seen, [1]);
    assert.equal(res.state.b, 2);
  });

  it('short-circuits on the first halting phase — later phases never run (fail-before-mutate)', async () => {
    let mutated = false;
    const res = await runPipeline([
      () => ({ ok: true, payload: {} }),
      () => ({ ok: false, exit: 1 }),
      () => {
        mutated = true;
        return { ok: true, payload: {} };
      },
    ]);
    assert.equal(res.ok, false);
    assert.equal(res.exit, 1);
    assert.equal(mutated, false, 'phases after the halt must not run');
  });
});

describe('collectAndConfirm', () => {
  it('halts with exit 1 when required answers are missing under --assume-yes', async () => {
    const { collectAndConfirm } = await import(
      '../../.agents/scripts/bootstrap.js'
    );
    const res = await collectAndConfirm({
      flags: { 'assume-yes': true, 'skip-github': true },
      interactive: false,
      assumeYes: true,
      defaults: { owner: null, repo: null, baseBranch: null },
      silentAccept: [],
      gitInitialized: true,
    });
    assert.equal(res.ok, false);
    assert.equal(res.exit, 1);
  });

  it('advances with the resolved answers when flags satisfy every required field', async () => {
    const { collectAndConfirm } = await import(
      '../../.agents/scripts/bootstrap.js'
    );
    const res = await collectAndConfirm({
      flags: {
        owner: 'acme',
        repo: 'widget',
        'base-branch': 'main',
        'skip-github': true,
      },
      interactive: false,
      assumeYes: false,
      defaults: { owner: null, repo: null, baseBranch: null },
      silentAccept: [],
      gitInitialized: true,
    });
    assert.equal(res.ok, true);
    assert.equal(res.payload.answers.owner, 'acme');
    assert.equal(res.payload.answers.repo, 'widget');
    // operatorHandle defaults to the owner when left blank.
    assert.equal(res.payload.answers.operatorHandle, 'acme');
    // --skip-github bypasses creation detection entirely.
    assert.deepEqual(res.payload.creation, {
      newRepo: false,
      newProject: false,
    });
  });
});

describe('dryRunPlan', () => {
  it('halts with exit 0 when --dry-run is set', async () => {
    const { dryRunPlan } = await import('../../.agents/scripts/bootstrap.js');
    const res = dryRunPlan({
      flags: { 'dry-run': true },
      answers: { owner: 'acme', repo: 'widget', baseBranch: 'main' },
      creation: { newRepo: false, newProject: false },
      gitInitialized: true,
    });
    assert.equal(res.ok, false);
    assert.equal(res.exit, 0);
  });

  it('advances (no-op) when --dry-run is not set', async () => {
    const { dryRunPlan } = await import('../../.agents/scripts/bootstrap.js');
    const res = dryRunPlan({ flags: {} });
    assert.equal(res.ok, true);
  });
});

describe('executeGithubBootstrap', () => {
  it('skips github when --skip-github is set, leaving report.github undefined', async () => {
    const { executeGithubBootstrap } = await import(
      '../../.agents/scripts/bootstrap.js'
    );
    const report = {};
    const state = {
      report,
      answers: { owner: 'acme', repo: 'widget', baseBranch: 'main' },
      flags: { 'skip-github': true },
      assumeYes: false,
    };
    const res = await executeGithubBootstrap(state);
    assert.equal(res.ok, true);
    assert.equal(report.github, undefined);
  });
});
