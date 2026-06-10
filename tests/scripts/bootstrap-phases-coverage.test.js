/**
 * bootstrap-phases-coverage.test — Story #3699.
 *
 * Story #3687 shipped the streamlined bootstrap orchestrator (then
 * `bootstrap-new.js`) WITHOUT unit tests, and Story #3690 promoted it to the
 * sole `bootstrap.js`. The phase-level coverage was partially backfilled by
 * the repointed `bootstrap-main-phases` / `bootstrap-preflight` /
 * `bootstrap-provisioning` suites, but several exported pipeline phases and
 * helpers still had only an export-shape assertion (or none at all):
 *
 *   - `persistProjectNumber`  — numeric-only persistence, merge-into-existing,
 *                               no-op on blank/non-numeric, read-failure path.
 *   - `executeBootstrap`      — approves every phase group; threads
 *                               `--skip-quality`.
 *   - `executeGithubBootstrap`— the `GhExecError` stderr/stdout/args surfacing
 *                               path (catch branch).
 *   - `recordLedger` /        — applied-group filtering and the
 *     `resolveAppliedGroups`    no-mutations-applied branch.
 *   - `collectAndConfirm`     — the `operatorHandle ⇐ owner` fallback and the
 *                               creation-approval branch.
 *   - `dryRunPlan`            — the plan is actually rendered (not just the
 *                               halt code).
 *   - `provisionResources`    — the `--skip-github` new-resource note and the
 *                               gh-backed repo/project creation paths
 *                               (the phase the Story body calls
 *                               `maybeCreateResources`; on post-#3690 `main`
 *                               it is the real provisioning phase, no longer
 *                               the hard-fail stub).
 *   - `resolveRepoVisibility` /
 *     `REPO_VISIBILITIES`     — flag resolution + the unrecognized-value
 *                               rejection.
 *
 * Every test drives the injected fs / spawnSync / gh seams — no real GitHub
 * call and no real filesystem mutation outside an isolated `os.tmpdir()`
 * scratch directory.
 */

import assert from 'node:assert/strict';
import * as realChildProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  dryRunPlan,
  executeGithubBootstrap,
  persistProjectNumber,
  REPO_VISIBILITIES,
  recordLedger,
  resolveRepoVisibility,
} from '../../.agents/scripts/bootstrap.js';
import { LEDGER_RELATIVE_PATH } from '../../.agents/scripts/lib/bootstrap/install-ledger.js';
import { PHASE_GROUPS } from '../../.agents/scripts/lib/bootstrap/manifest.js';
import { Logger } from '../../.agents/scripts/lib/Logger.js';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const SUT_URL = pathToFileURL(
  path.resolve(ROOT, '.agents/scripts/bootstrap.js'),
).href;
const GH_EXEC_PATH = path.resolve(ROOT, '.agents/scripts/lib/gh-exec.js');
const GH_EXEC_URL = pathToFileURL(GH_EXEC_PATH).href;
const GH_LIST_PATH = path.resolve(
  ROOT,
  '.agents/scripts/lib/bootstrap/gh-list.js',
);
const GH_LIST_URL = pathToFileURL(GH_LIST_PATH).href;
const PROJECT_BOOTSTRAP_PATH = path.resolve(
  ROOT,
  '.agents/scripts/lib/bootstrap/project-bootstrap.js',
);
const PROJECT_BOOTSTRAP_URL = pathToFileURL(PROJECT_BOOTSTRAP_PATH).href;
const GH_BOOTSTRAP_PATH = path.resolve(
  ROOT,
  '.agents/scripts/agents-bootstrap-github.js',
);
const GH_BOOTSTRAP_URL = pathToFileURL(GH_BOOTSTRAP_PATH).href;
const CONFIG_RESOLVER_PATH = path.resolve(
  ROOT,
  '.agents/scripts/lib/config-resolver.js',
);
const CONFIG_RESOLVER_URL = pathToFileURL(CONFIG_RESOLVER_PATH).href;

/** Track scratch dirs so afterEach can reap them. */
const scratchDirs = [];

function makeScratchDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-phases-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Capture Logger.info output through a test-context method spy. */
function captureInfo(t) {
  const lines = [];
  t.mock.method(Logger, 'info', (msg) => {
    lines.push(String(msg));
  });
  return lines;
}

/** Capture Logger.error output through a test-context method spy. */
function captureError(t) {
  const lines = [];
  t.mock.method(Logger, 'error', (msg) => {
    lines.push(String(msg));
  });
  return lines;
}

/**
 * Spread a real ESM module's named exports while dropping the `default`
 * binding. `mock.module`'s `namedExports` cannot carry a key named `default`
 * (it would generate an illegal `export default` *named* export and fail
 * module compilation with `SyntaxError: Unexpected token 'default'`), so the
 * spread of any module that has a default export (e.g. `node:child_process`,
 * `gh-exec.js`) MUST strip it. The SUT under test imports these seams by their
 * named bindings, so the default is never needed by the mock.
 *
 * @param {Record<string, unknown>} mod — a `import * as mod` namespace object.
 * @returns {Record<string, unknown>} the named exports minus `default`.
 */
function namedOnly(mod) {
  const { default: _default, ...named } = mod;
  return named;
}

/**
 * Mock `node:child_process.spawnSync` (the seam bootstrap.js#runGit shells
 * git through) so `provisionResources` never touches a real repo. Spreads the
 * real module so every other child_process export the graph imports survives.
 *
 * @param {import('node:test').TestContext} t
 * @param {(cmd: string, args: string[]) => { status?: number, stdout?: string,
 *   stderr?: string, error?: Error } | void} handler
 */
function fakeGitSpawnViaModule(t, handler) {
  t.mock.module('node:child_process', {
    namedExports: {
      ...namedOnly(realChildProcess),
      spawnSync: (cmd, args) => {
        const r = handler(cmd, args) ?? {};
        return {
          status: r.status ?? 0,
          stdout: r.stdout ?? '',
          stderr: r.stderr ?? '',
          error: r.error,
        };
      },
    },
  });
}

// ---------------------------------------------------------------------------
// resolveRepoVisibility + REPO_VISIBILITIES
// ---------------------------------------------------------------------------
describe('resolveRepoVisibility', () => {
  it('defaults to private when --visibility is absent', () => {
    assert.equal(resolveRepoVisibility({}), 'private');
    assert.equal(resolveRepoVisibility({ visibility: '' }), 'private');
  });

  it('accepts each of the three known visibilities, case-insensitively', () => {
    assert.equal(resolveRepoVisibility({ visibility: 'PUBLIC' }), 'public');
    assert.equal(resolveRepoVisibility({ visibility: 'Internal' }), 'internal');
    assert.equal(resolveRepoVisibility({ visibility: ' private ' }), 'private');
  });

  it('returns null for an unrecognized value', () => {
    assert.equal(resolveRepoVisibility({ visibility: 'secret' }), null);
  });

  it('exposes the three accepted visibilities as a frozen list', () => {
    assert.deepEqual([...REPO_VISIBILITIES], ['private', 'public', 'internal']);
    assert.ok(Object.isFrozen(REPO_VISIBILITIES));
  });
});

// ---------------------------------------------------------------------------
// persistProjectNumber — fs seam, no network
// ---------------------------------------------------------------------------
describe('persistProjectNumber', () => {
  it('writes a numeric github.projectNumber into an existing .agentrc.json', () => {
    const dir = makeScratchDir();
    fs.writeFileSync(
      path.join(dir, '.agentrc.json'),
      `${JSON.stringify({ project: { paths: {} } }, null, 2)}\n`,
    );
    const res = persistProjectNumber({
      projectRoot: dir,
      answers: { projectNumber: '42' },
    });
    assert.equal(res.ok, true);
    const written = JSON.parse(
      fs.readFileSync(path.join(dir, '.agentrc.json'), 'utf8'),
    );
    assert.equal(written.github.projectNumber, 42);
    // Persisted as an integer, not the string answer.
    assert.equal(typeof written.github.projectNumber, 'number');
    // Pre-existing keys are preserved (merge, not overwrite).
    assert.ok(written.project);
  });

  it('merges into an existing github block without clobbering sibling keys', () => {
    const dir = makeScratchDir();
    fs.writeFileSync(
      path.join(dir, '.agentrc.json'),
      `${JSON.stringify({ github: { owner: 'acme', repo: 'widget' } }, null, 2)}\n`,
    );
    persistProjectNumber({
      projectRoot: dir,
      answers: { projectNumber: '7' },
    });
    const written = JSON.parse(
      fs.readFileSync(path.join(dir, '.agentrc.json'), 'utf8'),
    );
    assert.equal(written.github.projectNumber, 7);
    assert.equal(written.github.owner, 'acme');
    assert.equal(written.github.repo, 'widget');
  });

  it('is a no-op (no write) when the project answer is blank', () => {
    const dir = makeScratchDir();
    // No .agentrc.json on disk — a write would throw ENOENT.
    const res = persistProjectNumber({
      projectRoot: dir,
      answers: { projectNumber: '' },
    });
    assert.equal(res.ok, true);
    assert.equal(fs.existsSync(path.join(dir, '.agentrc.json')), false);
  });

  it('is a no-op when the project answer is a non-numeric (new-project) name', () => {
    const dir = makeScratchDir();
    const res = persistProjectNumber({
      projectRoot: dir,
      answers: { projectNumber: 'My New Board' },
    });
    assert.equal(res.ok, true);
    assert.equal(fs.existsSync(path.join(dir, '.agentrc.json')), false);
  });

  it('skips the write when the stored value already matches (idempotent)', () => {
    const dir = makeScratchDir();
    const target = path.join(dir, '.agentrc.json');
    fs.writeFileSync(
      target,
      `${JSON.stringify({ github: { projectNumber: 9 } }, null, 2)}\n`,
    );
    const before = fs.statSync(target).mtimeMs;
    const res = persistProjectNumber({
      projectRoot: dir,
      answers: { projectNumber: '9' },
    });
    assert.equal(res.ok, true);
    // Value unchanged; the branch that writes is skipped.
    const written = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(written.github.projectNumber, 9);
    assert.ok(fs.statSync(target).mtimeMs >= before);
  });

  it('does not throw (advances) when .agentrc.json cannot be read', (t) => {
    const dir = makeScratchDir();
    const errors = captureError(t);
    // No file present → readFileSync throws ENOENT → caught, logged, advance.
    const res = persistProjectNumber({
      projectRoot: dir,
      answers: { projectNumber: '5' },
    });
    assert.equal(res.ok, true);
    assert.ok(errors.some((l) => l.includes('Could not read')));
  });
});

// ---------------------------------------------------------------------------
// recordLedger + resolveAppliedGroups (exercised through recordLedger)
// ---------------------------------------------------------------------------
describe('recordLedger / resolveAppliedGroups', () => {
  function ledgerState(dir, overrides = {}) {
    return {
      projectRoot: dir,
      answers: { owner: 'acme', repo: 'widget' },
      flags: {},
      approvedGroups: new Set(Object.values(PHASE_GROUPS)),
      report: {},
      ...overrides,
    };
  }

  it('writes a ledger filtered to the applied phase groups', (t) => {
    const dir = makeScratchDir();
    captureInfo(t);
    const state = ledgerState(dir, {
      // GitHub admin succeeded → it should be among the applied groups.
      report: { github: {} },
    });
    const res = recordLedger(state);
    assert.equal(res.ok, true);
    assert.equal(state.report.ledger.written, true);
    const ledger = JSON.parse(
      fs.readFileSync(path.join(dir, LEDGER_RELATIVE_PATH), 'utf8'),
    );
    assert.ok(ledger.entries.length > 0);
    assert.ok(ledger.approvedGroups.includes(PHASE_GROUPS.GITHUB_ADMIN));
  });

  it('drops github-admin from applied groups when a sub-mutation failed', (t) => {
    const dir = makeScratchDir();
    captureInfo(t);
    const state = ledgerState(dir, {
      report: { github: { branchProtection: { status: 'failed' } } },
    });
    recordLedger(state);
    assert.ok(
      !state.report.ledger.approvedGroups.includes(PHASE_GROUPS.GITHUB_ADMIN),
      'a failed github sub-mutation must drop the github-admin group',
    );
    // Local groups (repo-config, ide-wiring) still applied.
    assert.ok(
      state.report.ledger.approvedGroups.includes(PHASE_GROUPS.REPO_CONFIG),
    );
  });

  it('drops github-admin when the github report carries an error', (t) => {
    const dir = makeScratchDir();
    captureInfo(t);
    const state = ledgerState(dir, {
      report: { github: { error: 'gh exited with code 1' } },
    });
    recordLedger(state);
    assert.ok(
      !state.report.ledger.approvedGroups.includes(PHASE_GROUPS.GITHUB_ADMIN),
    );
  });

  it('records the no-mutations-applied branch when the manifest is empty', () => {
    const dir = makeScratchDir();
    const state = ledgerState(dir, {
      // No approved groups → buildMutationManifest filters to zero entries.
      approvedGroups: new Set(),
    });
    const res = recordLedger(state);
    assert.equal(res.ok, true);
    assert.deepEqual(state.report.ledger, {
      written: false,
      reason: 'no-mutations-applied',
    });
    // Nothing written to disk.
    assert.equal(fs.existsSync(path.join(dir, LEDGER_RELATIVE_PATH)), false);
  });
});

// ---------------------------------------------------------------------------
// dryRunPlan — renders the plan, mutates nothing, halts with exit 0
// ---------------------------------------------------------------------------
describe('dryRunPlan — plan rendering', () => {
  it('renders the resolved values + creation plan and halts with exit 0', (t) => {
    const lines = captureInfo(t);
    const res = dryRunPlan({
      flags: { 'dry-run': true, 'skip-github': true },
      answers: {
        owner: 'acme',
        operatorHandle: 'octo',
        repo: 'widget',
        baseBranch: 'trunk',
        projectNumber: '12',
      },
      creation: { newRepo: true, newProject: false },
      gitInitialized: false,
    });
    assert.equal(res.ok, false);
    assert.equal(res.exit, 0);
    const out = lines.join('\n');
    assert.match(out, /Dry run — nothing will be changed/);
    assert.match(out, /acme/);
    assert.match(out, /widget/);
    assert.match(out, /trunk/);
    // git init is rendered "yes" when not yet initialized.
    assert.match(out, /git init\s+yes/);
    // new repo rendered "yes (<visibility>)".
    assert.match(out, /new repo\s+yes \(private\)/);
  });
});

// ---------------------------------------------------------------------------
// collectAndConfirm — operatorHandle fallback + creation-approval branch
// ---------------------------------------------------------------------------
describe('collectAndConfirm — creation approval (gh seams mocked)', () => {
  /** Stub gh-list so the owner repo/project pickers never hit the network. */
  function mockGhList(t) {
    t.mock.module(GH_LIST_URL, {
      namedExports: {
        listRepos: () => [],
        listProjects: () => [],
      },
    });
  }

  it('proceeds past creation approval when a new repo is auto-approved (non-interactive)', async (t) => {
    const realGh = await import(GH_EXEC_URL);
    // `repoExists` → exec(repo view) throws GhNotFoundError → repo is "new".
    t.mock.module(GH_EXEC_URL, {
      namedExports: {
        ...namedOnly(realGh),
        exec: async () => {
          const err = new realGh.GhNotFoundError('not found', { args: [] });
          throw err;
        },
      },
    });
    mockGhList(t);
    captureInfo(t);
    const mod = await import(`${SUT_URL}?t=cac-newrepo`);
    const res = await mod.collectAndConfirm({
      flags: { owner: 'acme', repo: 'fresh-repo', 'base-branch': 'main' },
      interactive: false,
      assumeYes: false,
      defaults: { owner: 'acme', repo: null, baseBranch: 'main' },
      silentAccept: [],
      gitInitialized: true,
    });
    assert.equal(res.ok, true);
    assert.equal(res.payload.creation.newRepo, true);
    // Non-interactive confirmYesNo auto-accepts the creation prompt.
  });

  it('defaults operatorHandle to the owner when the handle answer is blank', async (t) => {
    const realGh = await import(GH_EXEC_URL);
    // Repo already exists → not a new repo, so no creation prompt at all.
    t.mock.module(GH_EXEC_URL, {
      namedExports: {
        ...namedOnly(realGh),
        exec: async () => ({ stdout: '{"name":"widget"}' }),
      },
    });
    mockGhList(t);
    captureInfo(t);
    const mod = await import(`${SUT_URL}?t=cac-handle`);
    const res = await mod.collectAndConfirm({
      flags: { owner: 'acme', repo: 'widget', 'base-branch': 'main' },
      interactive: false,
      assumeYes: false,
      defaults: { owner: 'acme', repo: 'widget', baseBranch: 'main' },
      silentAccept: [],
      gitInitialized: true,
    });
    assert.equal(res.ok, true);
    assert.equal(res.payload.answers.operatorHandle, 'acme');
    assert.equal(res.payload.creation.newRepo, false);
  });
});

// ---------------------------------------------------------------------------
// executeBootstrap — approves every phase group; threads --skip-quality
// ---------------------------------------------------------------------------
describe('executeBootstrap — project-side bootstrap (lib seam mocked)', () => {
  it('approves every phase group and returns the report from applyProjectBootstrap', async (t) => {
    const realPb = await import(PROJECT_BOOTSTRAP_URL);
    let received = null;
    t.mock.module(PROJECT_BOOTSTRAP_URL, {
      namedExports: {
        ...namedOnly(realPb),
        applyProjectBootstrap: async (ctx) => {
          received = ctx;
          return { applied: true };
        },
      },
    });
    captureInfo(t);
    const mod = await import(`${SUT_URL}?t=eb-approve`);
    const state = {
      projectRoot: '/proj',
      agentRoot: '/proj/.agents',
      answers: { owner: 'acme', repo: 'widget', baseBranch: 'main' },
      flags: {},
    };
    const res = await mod.executeBootstrap(state);
    assert.equal(res.ok, true);
    assert.deepEqual(res.payload.report, { applied: true });
    // Every phase group is approved (phased approval was removed in #3690).
    assert.deepEqual(
      [...res.payload.approvedGroups].sort(),
      [...Object.values(PHASE_GROUPS)].sort(),
    );
    assert.equal(received.skipQuality, false);
  });

  it('threads --skip-quality into applyProjectBootstrap', async (t) => {
    const realPb = await import(PROJECT_BOOTSTRAP_URL);
    let received = null;
    t.mock.module(PROJECT_BOOTSTRAP_URL, {
      namedExports: {
        ...namedOnly(realPb),
        applyProjectBootstrap: async (ctx) => {
          received = ctx;
          return { applied: true };
        },
      },
    });
    captureInfo(t);
    const mod = await import(`${SUT_URL}?t=eb-skipq`);
    const res = await mod.executeBootstrap({
      projectRoot: '/proj',
      agentRoot: '/proj/.agents',
      answers: { owner: 'acme', repo: 'widget', baseBranch: 'main' },
      flags: { 'skip-quality': true },
    });
    assert.equal(res.ok, true);
    assert.equal(received.skipQuality, true);
  });
});

// ---------------------------------------------------------------------------
// executeGithubBootstrap — GhExecError stderr/stdout/args surfacing
// ---------------------------------------------------------------------------
describe('executeGithubBootstrap — GhExecError surfacing', () => {
  it('catches a GhExecError and surfaces its stderr/stdout/args; records report.github.error', async (t) => {
    const realGhBootstrap = await import(GH_BOOTSTRAP_URL);
    const realGhExec = await import(GH_EXEC_URL);
    // The first call inside runGithubBootstrap is `preflightGh()` — make it
    // throw a fully-populated GhExecError so the catch block's logGhError
    // surfaces every diagnostic field.
    t.mock.module(GH_BOOTSTRAP_URL, {
      namedExports: {
        ...namedOnly(realGhBootstrap),
        preflightGh: async () => {
          throw new realGhExec.GhExecError('gh exited with code 1', {
            args: ['repo', 'view', 'acme/widget'],
            stdout: 'some-stdout',
            stderr: 'HTTP 403: forbidden',
            code: 1,
          });
        },
      },
    });
    const errors = captureError(t);
    const mod = await import(`${SUT_URL}?t=egb-err`);
    const report = {};
    const res = await mod.executeGithubBootstrap({
      report,
      answers: { owner: 'acme', repo: 'widget', baseBranch: 'main' },
      flags: {},
      assumeYes: true,
    });
    // The phase never halts the pipeline; it records the error on the report.
    assert.equal(res.ok, true);
    assert.equal(report.github.error, 'gh exited with code 1');
    const out = errors.join('\n');
    assert.match(out, /GitHub bootstrap failed: gh exited with code 1/);
    assert.match(out, /gh stderr: HTTP 403: forbidden/);
    assert.match(out, /gh stdout: some-stdout/);
    assert.match(out, /gh args: repo view acme\/widget/);
  });

  it('skips the GitHub bootstrap entirely when --skip-github is set', async (t) => {
    captureInfo(t);
    const report = {};
    const res = await executeGithubBootstrap({
      report,
      answers: { owner: 'acme', repo: 'widget', baseBranch: 'main' },
      flags: { 'skip-github': true },
      assumeYes: false,
    });
    assert.equal(res.ok, true);
    assert.equal(report.github, undefined);
  });

  // -------------------------------------------------------------------------
  // Story #3897 — the consent signal (no longer a hardcoded `true`) is threaded
  // verbatim into the boundary gate. Mock every seam runGithubBootstrap pulls
  // in so we capture the exact `githubAdminApproved` opt the orchestrator
  // forwards to `runBootstrap` — no real gh call, no real config read.
  // -------------------------------------------------------------------------
  async function loadSutWithCapturedRunBootstrap(t, tag) {
    const realGhBootstrap = await import(GH_BOOTSTRAP_URL);
    const realResolver = await import(CONFIG_RESOLVER_URL);
    const captured = {};
    t.mock.module(GH_BOOTSTRAP_URL, {
      namedExports: {
        ...namedOnly(realGhBootstrap),
        preflightGh: async () => {},
        preflightRuntimeDeps: async () => {},
        runBootstrap: async (_config, opts) => {
          captured.opts = opts;
          return { skipped: opts.githubAdminApproved !== true };
        },
      },
    });
    t.mock.module(CONFIG_RESOLVER_URL, {
      namedExports: {
        ...namedOnly(realResolver),
        resolveConfig: () => ({ project: {}, github: {} }),
        validateOrchestrationConfig: () => {},
      },
    });
    const mod = await import(`${SUT_URL}?t=${tag}`);
    return { mod, captured };
  }

  it('threads githubAdminApproved=true into runBootstrap when consent is present (Story #3897)', async (t) => {
    captureInfo(t);
    const { mod, captured } = await loadSutWithCapturedRunBootstrap(
      t,
      'egb-consent-yes',
    );
    const report = {};
    const res = await mod.executeGithubBootstrap({
      report,
      answers: { owner: 'acme', repo: 'widget', baseBranch: 'main' },
      flags: {},
      assumeYes: true,
      githubAdminApproved: true,
    });
    assert.equal(res.ok, true);
    assert.equal(captured.opts.githubAdminApproved, true);
    assert.equal(report.github.skipped, false);
  });

  it('threads githubAdminApproved=false into runBootstrap so the GitHub-admin phase is a verified no-op without consent (Story #3897)', async (t) => {
    captureInfo(t);
    const { mod, captured } = await loadSutWithCapturedRunBootstrap(
      t,
      'egb-consent-no',
    );
    const report = {};
    const res = await mod.executeGithubBootstrap({
      report,
      answers: { owner: 'acme', repo: 'widget', baseBranch: 'main' },
      flags: {},
      assumeYes: false,
      // No consent signal computed by parseAndValidate → not approved.
      githubAdminApproved: false,
    });
    assert.equal(res.ok, true);
    // The boundary received a strict `false`, never a hardcoded `true`.
    assert.equal(captured.opts.githubAdminApproved, false);
    assert.equal(report.github.skipped, true);
  });
});

// ---------------------------------------------------------------------------
// provisionResources — the phase the Story body names "maybeCreateResources".
// On post-#3690 `main` it is the real cold-start provisioning phase (no longer
// the hard-fail stub the Story body described pre-cutover). gh + git seams are
// mocked; no real network or repo mutation.
// ---------------------------------------------------------------------------
describe('provisionResources — gh-backed creation (seams mocked)', () => {
  it('emits the skip note and does not call gh when --skip-github + new resources', async (t) => {
    const realGhExec = await import(GH_EXEC_URL);
    let execCalled = false;
    t.mock.module(GH_EXEC_URL, {
      namedExports: {
        ...namedOnly(realGhExec),
        exec: async () => {
          execCalled = true;
          return { stdout: '' };
        },
      },
    });
    fakeGitSpawnViaModule(t, (_cmd, args) => {
      // HEAD resolves → no commit attempted; git already initialized.
      if (args.includes('rev-parse')) return { status: 0, stdout: 'abc' };
      return { status: 0 };
    });
    const infos = captureInfo(t);
    const mod = await import(`${SUT_URL}?t=pr-skip`);
    const res = await mod.provisionResources({
      flags: { 'skip-github': true },
      projectRoot: '/proj',
      agentRoot: '/proj/.agents',
      answers: { owner: 'acme', repo: 'widget', baseBranch: 'main' },
      creation: { newRepo: true, newProject: true },
      gitInitialized: true,
    });
    assert.equal(res.ok, true);
    assert.equal(execCalled, false, 'gh must not run under --skip-github');
    assert.ok(
      infos.some((l) => l.includes('not creating the GitHub repo/project')),
    );
  });

  it('creates the repo via gh repo create on the new-repo path', async (t) => {
    const realGhExec = await import(GH_EXEC_URL);
    const execArgs = [];
    t.mock.module(GH_EXEC_URL, {
      namedExports: {
        ...namedOnly(realGhExec),
        exec: async ({ args }) => {
          execArgs.push(args);
          return { stdout: '' };
        },
      },
    });
    fakeGitSpawnViaModule(t, (_cmd, args) => {
      if (args.includes('rev-parse')) return { status: 0, stdout: 'abc' };
      if (args.includes('get-url')) return { status: 0, stdout: 'has-origin' };
      return { status: 0 };
    });
    captureInfo(t);
    const mod = await import(`${SUT_URL}?t=pr-newrepo`);
    const res = await mod.provisionResources({
      flags: {},
      projectRoot: '/proj',
      agentRoot: '/proj/.agents',
      answers: {
        owner: 'acme',
        repo: 'widget',
        baseBranch: 'main',
        operatorHandle: 'acme',
        projectNumber: '',
      },
      creation: { newRepo: true, newProject: false },
      gitInitialized: true,
    });
    assert.equal(res.ok, true);
    assert.ok(
      execArgs.some((a) => a[0] === 'repo' && a[1] === 'create'),
      'expected gh repo create',
    );
  });

  it('halts with exit 1 and surfaces the gh error when repo create fails', async (t) => {
    const realGhExec = await import(GH_EXEC_URL);
    t.mock.module(GH_EXEC_URL, {
      namedExports: {
        ...namedOnly(realGhExec),
        exec: async ({ args }) => {
          if (args[0] === 'repo' && args[1] === 'create') {
            throw new realGhExec.GhExecError('repo create blew up', {
              args,
              stderr: 'name already exists',
              code: 1,
            });
          }
          return { stdout: '' };
        },
      },
    });
    fakeGitSpawnViaModule(t, (_cmd, args) => {
      if (args.includes('rev-parse')) return { status: 0, stdout: 'abc' };
      return { status: 0 };
    });
    const errors = captureError(t);
    const mod = await import(`${SUT_URL}?t=pr-newrepo-fail`);
    const res = await mod.provisionResources({
      flags: {},
      projectRoot: '/proj',
      agentRoot: '/proj/.agents',
      answers: {
        owner: 'acme',
        repo: 'widget',
        baseBranch: 'main',
        operatorHandle: 'acme',
      },
      creation: { newRepo: true, newProject: false },
      gitInitialized: true,
    });
    assert.equal(res.ok, false);
    assert.equal(res.exit, 1);
    assert.ok(
      errors.some((l) => l.includes('repo create failed: repo create blew up')),
    );
  });
});
