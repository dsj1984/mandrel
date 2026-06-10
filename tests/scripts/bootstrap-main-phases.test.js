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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  collectAndConfirm,
  normalizeHandleAnswer,
  parseAndValidate,
  persistProjectNumber,
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

describe('main() — GitHub-side failure exit code (Story #3898)', () => {
  // A GitHub-side bootstrap failure is recorded as `report.github.error`
  // (not thrown) so the install ledger can still record the project-side
  // mutations that already landed. `main()` must detect that recorded error
  // after the pipeline and exit non-zero — never `Done.` + exit 0.

  /**
   * Build a minimal injected pipeline whose `executeGithubBootstrap`
   * stand-in records (rather than throws) a GitHub-side error, and whose
   * `recordLedger` stand-in proves it still runs after the failure.
   */
  function phasesWithGithubError(state, recorded) {
    return [
      () => ({
        ok: true,
        payload: { report: state.report, answers: {}, flags: {} },
      }),
      // executeGithubBootstrap stand-in: catch + record (mirrors source).
      (s) => {
        s.report.github = { error: 'gh: project scope missing (exit 1)' };
        return { ok: true, payload: {} };
      },
      // recordLedger stand-in: project-side mutations are still recorded.
      () => {
        recorded.ledgerRan = true;
        return { ok: true, payload: {} };
      },
    ];
  }

  let origError;
  let errChunks;
  beforeEach(() => {
    errChunks = [];
    origError = console.error;
    console.error = (...args) => errChunks.push(args.join(' '));
  });
  afterEach(() => {
    console.error = origError;
  });

  it('returns a non-zero exit code when the GitHub bootstrap step records an error', async () => {
    const { main } = await import('../../.agents/scripts/bootstrap.js');
    const report = {};
    const recorded = {};
    const code = await main([], {
      phases: phasesWithGithubError({ report }, recorded),
    });
    assert.equal(code, 1, 'a recorded GitHub error must exit non-zero');
  });

  it('prints a distinct GitHub-failure status line naming remediation (not "Done.")', async () => {
    const { main } = await import('../../.agents/scripts/bootstrap.js');
    const report = {};
    const recorded = {};
    await main([], { phases: phasesWithGithubError({ report }, recorded) });
    const joined = errChunks.join('\n');
    assert.match(joined, /GitHub bootstrap failed/);
    assert.match(joined, /re-run/);
    assert.doesNotMatch(joined, /\[bootstrap\] Done\./);
  });

  it('still runs the ledger phase (project-side mutations surfaced, not rolled back)', async () => {
    const { main } = await import('../../.agents/scripts/bootstrap.js');
    const report = {};
    const recorded = {};
    await main([], { phases: phasesWithGithubError({ report }, recorded) });
    assert.equal(
      recorded.ledgerRan,
      true,
      'the ledger phase must run after a GitHub-side failure',
    );
  });

  it('returns exit 0 when no GitHub error is recorded', async () => {
    const { main } = await import('../../.agents/scripts/bootstrap.js');
    const code = await main([], {
      phases: [() => ({ ok: true, payload: { report: {} } })],
    });
    assert.equal(code, 0);
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

// ---------------------------------------------------------------------------
// Story #3700 — bootstrap hardening
// ---------------------------------------------------------------------------

describe('normalizeHandleAnswer (Story #3700 — @-handle normalization)', () => {
  it('strips a single leading @ so the template never doubles it', () => {
    assert.equal(normalizeHandleAnswer('@foo'), 'foo');
  });

  it('leaves a bare handle untouched (idempotent)', () => {
    assert.equal(normalizeHandleAnswer('foo'), 'foo');
    assert.equal(normalizeHandleAnswer(normalizeHandleAnswer('@foo')), 'foo');
  });

  it('strips only ONE leading @ (does not collapse @@)', () => {
    // A double-@ collapses by exactly one; the result is what the starter
    // template re-prepends, so a single round-trip stays single-@.
    assert.equal(normalizeHandleAnswer('@@foo'), '@foo');
  });

  it('passes non-string values through unchanged', () => {
    assert.equal(normalizeHandleAnswer(undefined), undefined);
    assert.equal(normalizeHandleAnswer(null), null);
  });
});

describe('collectAndConfirm — @-handle normalization (Story #3700)', () => {
  it('strips a leading @ from --operator-handle so it persists bare', async () => {
    const res = await collectAndConfirm({
      flags: {
        owner: 'acme',
        repo: 'widget',
        'base-branch': 'main',
        'operator-handle': '@foo',
        'skip-github': true,
      },
      interactive: false,
      assumeYes: false,
      defaults: { owner: null, repo: null, baseBranch: null },
      silentAccept: [],
      gitInitialized: true,
    });
    assert.equal(res.ok, true);
    // The starter template carries "@[USERNAME]"; substituting a bare handle
    // yields "@foo", not "@@foo".
    assert.equal(res.payload.answers.operatorHandle, 'foo');
  });

  it('strips a leading @ from GH_OPERATOR_HANDLE env (flag/env bypass the validator)', async () => {
    const prev = process.env.GH_OPERATOR_HANDLE;
    process.env.GH_OPERATOR_HANDLE = '@bar';
    try {
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
      assert.equal(res.payload.answers.operatorHandle, 'bar');
    } finally {
      if (prev === undefined) delete process.env.GH_OPERATOR_HANDLE;
      else process.env.GH_OPERATOR_HANDLE = prev;
    }
  });
});

describe('persistProjectNumber — minimal write (Story #3700)', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-persist-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not rewrite .agentrc.json when the number is already set', () => {
    const target = path.join(dir, '.agentrc.json');
    // A hand-formatted file with tabs + trailing spacing the writer would churn.
    const original = '{\n\t"github": {\n\t\t"projectNumber": 7\n\t}\n}\n';
    fs.writeFileSync(target, original, 'utf8');
    const before = fs.statSync(target).mtimeMs;

    const res = persistProjectNumber({
      projectRoot: dir,
      answers: { projectNumber: '7' },
    });
    assert.equal(res.ok, true);
    // Byte-for-byte identical — no reformatting churn.
    assert.equal(fs.readFileSync(target, 'utf8'), original);
    assert.equal(fs.statSync(target).mtimeMs, before);
  });

  it('writes the number when it differs (and is a clean re-run no-op after)', () => {
    const target = path.join(dir, '.agentrc.json');
    fs.writeFileSync(target, '{\n  "github": {}\n}\n', 'utf8');

    persistProjectNumber({
      projectRoot: dir,
      answers: { projectNumber: '12' },
    });
    const afterFirst = fs.readFileSync(target, 'utf8');
    assert.match(afterFirst, /"projectNumber": 12/);

    // Second run with the same number must not mutate the file again.
    persistProjectNumber({
      projectRoot: dir,
      answers: { projectNumber: '12' },
    });
    assert.equal(fs.readFileSync(target, 'utf8'), afterFirst);
  });

  it('no-ops for a blank/non-numeric (new-project) answer', () => {
    const target = path.join(dir, '.agentrc.json');
    const original = '{\n  "github": {}\n}\n';
    fs.writeFileSync(target, original, 'utf8');
    persistProjectNumber({ projectRoot: dir, answers: { projectNumber: '' } });
    assert.equal(fs.readFileSync(target, 'utf8'), original);
  });
});
