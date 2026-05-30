/**
 * bootstrap-main-phases.test — Story #2459 / Task #2471
 *
 * Exercises the five phase helpers extracted out of `bootstrap.main()`:
 *
 *   1. parseAndValidate
 *   2. prepareContext
 *   3. collectAndValidateAnswers
 *   4. executeBootstrap          (smoke — heavy lifting lives in
 *                                 bootstrap/project-bootstrap.js, which has
 *                                 its own test surface)
 *   5. executeGithubBootstrap    (smoke — capture error / skip behaviour)
 *
 * The driver `main()` is the trivial composer over these phases; its
 * end-to-end behaviour is already covered by `tests/bootstrap.test.js`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseAndValidate,
  prepareContext,
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

  it('advances in non-TTY mode without --assume-yes when owner+repo flags are supplied (parity with pre-refactor)', () => {
    // Original main() validated owner/repo presence ONLY when neither
    // interactive nor assumeYes was set; the flags themselves satisfy
    // the gate. Keeping this contract pins the regression surface.
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
  it('exports the five phase helpers', async () => {
    const mod = await import('../../.agents/scripts/bootstrap.js');
    assert.equal(typeof mod.parseAndValidate, 'function');
    assert.equal(typeof mod.prepareContext, 'function');
    assert.equal(typeof mod.collectAndValidateAnswers, 'function');
    assert.equal(typeof mod.executeBootstrap, 'function');
    assert.equal(typeof mod.executeGithubBootstrap, 'function');
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

describe('collectAndValidateAnswers', () => {
  it('halts with exit 1 when collectAnswers reports missing required fields', async () => {
    const { collectAndValidateAnswers } = await import(
      '../../.agents/scripts/bootstrap.js'
    );
    const res = await collectAndValidateAnswers({
      flags: { 'assume-yes': true },
      interactive: false,
      assumeYes: true,
      defaults: { owner: null, repo: null, baseBranch: null },
      silentAccept: [],
    });
    assert.equal(res.ok, false);
    assert.equal(res.exit, 1);
  });

  it('halts with exit 0 when --dry-run is set', async () => {
    const { collectAndValidateAnswers } = await import(
      '../../.agents/scripts/bootstrap.js'
    );
    const res = await collectAndValidateAnswers({
      flags: {
        'dry-run': true,
        owner: 'acme',
        repo: 'widget',
        'base-branch': 'main',
      },
      interactive: false,
      assumeYes: false,
      defaults: {
        owner: 'acme',
        repo: 'widget',
        baseBranch: 'main',
        operatorHandle: null,
      },
      silentAccept: [],
    });
    assert.equal(res.ok, false);
    assert.equal(res.exit, 0);
  });

  it('advances with the resolved answers when no required field is missing', async () => {
    const { collectAndValidateAnswers } = await import(
      '../../.agents/scripts/bootstrap.js'
    );
    const res = await collectAndValidateAnswers({
      flags: {
        owner: 'acme',
        repo: 'widget',
        'base-branch': 'main',
      },
      interactive: false,
      assumeYes: false,
      defaults: { owner: null, repo: null, baseBranch: null },
      silentAccept: [],
    });
    assert.equal(res.ok, true);
    assert.equal(res.payload.answers.owner, 'acme');
    assert.equal(res.payload.answers.repo, 'widget');
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

describe('main() preflight gating (fail-before-mutate)', () => {
  it('short-circuits with exit 1 when preflight fails, before any mutation phase runs', async () => {
    const { main } = await import('../../.agents/scripts/bootstrap.js');
    // A failing preflight must halt the pipeline at phase 2 — before
    // prepareContext / executeBootstrap / executeGithubBootstrap. We inject
    // a failing preflight runner and assert main returns exit 1. Because the
    // pipeline short-circuits on the first {ok:false}, none of the mutation
    // phases execute (they would otherwise need owner/repo answers and would
    // touch the filesystem). Passing valid flags proves the halt is the
    // preflight, not a missing-answers bail.
    const failingPreflight = async () => ({
      ok: false,
      checks: [{ name: 'gh', ok: false, remedy: 'Install the GitHub CLI.' }],
    });
    const exit = await main(
      ['--owner', 'acme', '--repo', 'widget', '--assume-yes', '--skip-github'],
      { preflightRun: failingPreflight },
    );
    assert.equal(exit, 1);
  });
});
