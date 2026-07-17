/**
 * bootstrap-provisioning-github.test — Story #3691.
 *
 * Covers the GitHub-backed cold-start provisioning paths of the collapsed
 * bootstrap orchestrator that the local-git-only suite
 * (`bootstrap-provisioning.test.js`) deliberately leaves structurally
 * unreachable. These exercise the `gh`-touching branches through the injected
 * `deps.exec` seam — no real `gh` is ever spawned (unit tier; all I/O mocked):
 *
 *   - `repo-provisioned`    — a new repo name routes through `gh repo create`
 *     and the run continues against the created repo.
 *   - `project-provisioned` — a new (typed-name) project routes through
 *     `gh project create`, the assigned number is captured onto
 *     `state.answers.projectNumber`, and `persistProjectNumber` writes it to
 *     `.agentrc.json`.
 *   - `no-duplicate-board`  — the captured project number is the one persisted
 *     into the github block that the downstream GitHub bootstrap reads, so the
 *     provider reuses it instead of creating a second board (the "#8 vs #12"
 *     duplicate-project bug the persist step guards against).
 *   - `dry-run-safe`        — `dryRunPlan` halts before provisioning and the
 *     `provisionResources` skip-github guard mutates nothing on GitHub.
 *   - link + failure surfacing for the create paths.
 *
 * All git I/O happens in a throw-away temp dir (the function's own boundary);
 * every `gh` call is captured by a fake `exec` so the assertions read the
 * exact argv the orchestrator would have spawned.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  dryRunPlan,
  persistProjectNumber,
  provisionResources,
} from '../../.agents/scripts/bootstrap.js';
import { GhNotFoundError } from '../../.agents/scripts/lib/gh-exec.js';

const ANSWERS = Object.freeze({
  owner: 'acme',
  repo: 'widget',
  baseBranch: 'main',
  operatorHandle: 'octo',
  projectNumber: '',
});

const tmpDirs = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-prov-gh-'));
  tmpDirs.push(dir);
  return dir;
}

// Env with every `GIT_*` variable dropped. Under a husky pre-push from a
// linked worktree, git exports GIT_DIR pointing at the shared main gitdir —
// git under that env acts on the MAIN checkout instead of the fixture
// (#4580).
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: CLEAN_ENV });
}

/**
 * Build a fake `exec` seam. `handlers` maps the gh sub-command verb (e.g.
 * `'repo create'`, `'project create'`) to a `(args) => result` responder.
 * Calls are recorded on `fake.calls` so a test can assert the exact argv.
 * An unmapped verb throws — a structural assertion that no surprise gh call
 * leaked through.
 */
function makeExec(handlers) {
  const fake = ({ args }) => {
    fake.calls.push(args);
    // The gh sub-command is the longest leading run of non-flag tokens.
    const verbTokens = [];
    for (const token of args) {
      if (token.startsWith('--')) break;
      verbTokens.push(token);
    }
    const verb = verbTokens.join(' ');
    const handler =
      handlers[verb] ?? handlers[args.slice(0, 2).join(' ')] ?? null;
    if (!handler) {
      throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
    }
    return Promise.resolve(handler(args));
  };
  fake.calls = [];
  return fake;
}

function callsFor(fake, verb) {
  return fake.calls.filter((args) => args.slice(0, 2).join(' ') === verb);
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe('provisionResources — repo provisioning (gh repo create)', () => {
  it('routes a new repo name through `gh repo create` with the resolved visibility', async () => {
    const dir = makeTmpDir();
    const exec = makeExec({
      'repo create': () => ({ stdout: '', stderr: '' }),
    });
    const state = {
      projectRoot: dir,
      gitInitialized: false,
      flags: { visibility: 'public' },
      creation: { newRepo: true, newProject: false },
      answers: { ...ANSWERS },
    };

    const res = await provisionResources(state, { exec });

    assert.equal(res.ok, true);
    const creates = callsFor(exec, 'repo create');
    assert.equal(creates.length, 1, 'gh repo create fired exactly once');
    const args = creates[0];
    assert.ok(args.includes('acme/widget'), 'targets owner/repo slug');
    assert.ok(args.includes('--public'), 'uses the resolved visibility flag');
    assert.ok(args.includes('--source'), 'links the local tree');
    assert.ok(args.includes('--push'), 'pushes the initial commit');
    // No `gh repo view` (repoExists) was needed — newRepo was decided upstream.
    assert.equal(callsFor(exec, 'repo view').length, 0);
  });

  it('defaults to private visibility when no --visibility flag is set', async () => {
    const dir = makeTmpDir();
    const exec = makeExec({ 'repo create': () => ({ stdout: '' }) });
    await provisionResources(
      {
        projectRoot: dir,
        gitInitialized: false,
        flags: {},
        creation: { newRepo: true, newProject: false },
        answers: { ...ANSWERS },
      },
      { exec },
    );
    assert.ok(callsFor(exec, 'repo create')[0].includes('--private'));
  });

  it('surfaces a `gh repo create` failure as exit 1 and skips project create', async () => {
    const dir = makeTmpDir();
    const exec = makeExec({
      'repo create': () => {
        throw new GhNotFoundError('gh blew up', { args: ['repo', 'create'] });
      },
    });
    const res = await provisionResources(
      {
        projectRoot: dir,
        gitInitialized: false,
        flags: {},
        creation: { newRepo: true, newProject: true },
        answers: { ...ANSWERS, projectNumber: 'Roadmap' },
      },
      { exec },
    );
    assert.equal(res.ok, false);
    assert.equal(res.exit, 1);
    // The pipeline halted at repo create — project create never fired.
    assert.equal(callsFor(exec, 'project create').length, 0);
  });
});

describe('provisionResources — project provisioning (gh project create)', () => {
  it('creates a Projects V2 board from the typed name and captures the assigned number', async () => {
    const dir = makeTmpDir();
    // No origin remote and the repo "exists" → ensureGitRemote probes repo
    // view before the project create runs.
    const exec = makeExec({
      'repo view': () => ({ stdout: JSON.stringify({ name: 'widget' }) }),
      'project list': () => ({ stdout: JSON.stringify({ projects: [] }) }),
      'project create': () => ({ stdout: JSON.stringify({ number: 12 }) }),
      'project link': () => ({ stdout: '' }),
    });
    const state = {
      projectRoot: dir,
      gitInitialized: false,
      flags: { 'skip-github': false },
      creation: { newRepo: false, newProject: true },
      answers: { ...ANSWERS, projectNumber: 'Roadmap' },
    };

    const res = await provisionResources(state, { exec });

    assert.equal(res.ok, true);
    // The typed name was rewritten to the assigned numeric id.
    assert.equal(state.answers.projectNumber, '12');
    // newProject was flipped off so downstream treats it as existing.
    assert.equal(state.creation.newProject, false);
    const creates = callsFor(exec, 'project create');
    assert.equal(creates.length, 1);
    assert.ok(creates[0].includes('--title'));
    assert.ok(
      creates[0].includes('Roadmap'),
      'creates the board with the typed title',
    );
  });

  it('throws (exit 1) when `gh project create` returns no numeric number', async () => {
    const dir = makeTmpDir();
    const exec = makeExec({
      'repo view': () => ({ stdout: JSON.stringify({ name: 'widget' }) }),
      'project list': () => ({ stdout: JSON.stringify({ projects: [] }) }),
      'project create': () => ({ stdout: '{}' }),
    });
    const res = await provisionResources(
      {
        projectRoot: dir,
        gitInitialized: false,
        flags: {},
        creation: { newRepo: false, newProject: true },
        answers: { ...ANSWERS, projectNumber: 'Roadmap' },
      },
      { exec },
    );
    assert.equal(res.ok, false);
    assert.equal(res.exit, 1);
  });

  it('links the repo to the board after a successful project create', async () => {
    const dir = makeTmpDir();
    const exec = makeExec({
      'repo view': () => ({ stdout: JSON.stringify({ name: 'widget' }) }),
      'project list': () => ({ stdout: JSON.stringify({ projects: [] }) }),
      'project create': () => ({ stdout: JSON.stringify({ number: 5 }) }),
      'project link': () => ({ stdout: '' }),
    });
    const state = {
      projectRoot: dir,
      gitInitialized: false,
      flags: {},
      creation: { newRepo: false, newProject: true },
      answers: { ...ANSWERS, projectNumber: 'Roadmap' },
    };
    await provisionResources(state, { exec });
    const links = callsFor(exec, 'project link');
    assert.equal(links.length, 1, 'gh project link fired once');
    assert.ok(links[0].includes('5'), 'links the newly assigned number');
    assert.ok(links[0].includes('--repo'));
  });
});

describe('ID threading — created project number reaches the github config (no-duplicate-board)', () => {
  it('threads the created number through provisionResources → persistProjectNumber into .agentrc.json', async () => {
    const dir = makeTmpDir();
    // The persist step reads the .agentrc.json the project-side bootstrap
    // would have written; seed a minimal one with a *different* number to
    // prove the created id overwrites it (the "#8 vs #12" guard).
    fs.writeFileSync(
      path.join(dir, '.agentrc.json'),
      `${JSON.stringify({ github: { owner: 'acme', projectNumber: 8 } }, null, 2)}\n`,
      'utf8',
    );
    const exec = makeExec({
      'repo view': () => ({ stdout: JSON.stringify({ name: 'widget' }) }),
      'project list': () => ({ stdout: JSON.stringify({ projects: [] }) }),
      'project create': () => ({ stdout: JSON.stringify({ number: 12 }) }),
      'project link': () => ({ stdout: '' }),
    });
    const state = {
      projectRoot: dir,
      gitInitialized: false,
      flags: {},
      creation: { newRepo: false, newProject: true },
      answers: { ...ANSWERS, projectNumber: 'Roadmap' },
    };

    // Provision (captures the assigned number) then persist it.
    await provisionResources(state, { exec });
    const persist = persistProjectNumber(state);

    assert.equal(persist.ok, true);
    const written = JSON.parse(
      fs.readFileSync(path.join(dir, '.agentrc.json'), 'utf8'),
    );
    // The created board number (12) is now the stored source of truth the
    // downstream GitHub bootstrap reads — so no second board is created.
    assert.equal(written.github.projectNumber, 12);
    // Exactly one project create fired across the whole run — no duplicate.
    assert.equal(callsFor(exec, 'project create').length, 1);
  });
});

describe('dedupe — typed name matching an existing board adopts it (no duplicate create)', () => {
  it('reuses the existing board number and never calls `gh project create`', async () => {
    const dir = makeTmpDir();
    const exec = makeExec({
      'repo view': () => ({ stdout: JSON.stringify({ name: 'widget' }) }),
      'project list': () => ({
        stdout: JSON.stringify({
          projects: [
            { number: 3, title: 'Other' },
            { number: 7, title: 'Roadmap' },
          ],
        }),
      }),
      'project link': () => ({ stdout: '' }),
    });
    const state = {
      projectRoot: dir,
      gitInitialized: false,
      flags: {},
      creation: { newRepo: false, newProject: true },
      answers: { ...ANSWERS, projectNumber: 'Roadmap' },
    };

    const res = await provisionResources(state, { exec });

    assert.equal(res.ok, true);
    // Adopted the matching board's number instead of minting a new one.
    assert.equal(state.answers.projectNumber, '7');
    assert.equal(state.creation.newProject, false);
    // Zero `gh project create` calls — the dedupe short-circuited it.
    assert.equal(callsFor(exec, 'project create').length, 0);
    // The adopted number flows to link.
    const links = callsFor(exec, 'project link');
    assert.equal(links.length, 1);
    assert.ok(links[0].includes('7'));
  });

  it('matches the title case-insensitively and trimmed', async () => {
    const dir = makeTmpDir();
    const exec = makeExec({
      'repo view': () => ({ stdout: JSON.stringify({ name: 'widget' }) }),
      'project list': () => ({
        stdout: JSON.stringify({ projects: [{ number: 9, title: 'Roadmap' }] }),
      }),
      'project link': () => ({ stdout: '' }),
    });
    const state = {
      projectRoot: dir,
      gitInitialized: false,
      flags: {},
      creation: { newRepo: false, newProject: true },
      answers: { ...ANSWERS, projectNumber: '  roadmap  ' },
    };

    await provisionResources(state, { exec });

    assert.equal(state.answers.projectNumber, '9');
    assert.equal(callsFor(exec, 'project create').length, 0);
  });

  it('still creates when no existing title matches', async () => {
    const dir = makeTmpDir();
    const exec = makeExec({
      'repo view': () => ({ stdout: JSON.stringify({ name: 'widget' }) }),
      'project list': () => ({
        stdout: JSON.stringify({ projects: [{ number: 3, title: 'Other' }] }),
      }),
      'project create': () => ({ stdout: JSON.stringify({ number: 14 }) }),
      'project link': () => ({ stdout: '' }),
    });
    const state = {
      projectRoot: dir,
      gitInitialized: false,
      flags: {},
      creation: { newRepo: false, newProject: true },
      answers: { ...ANSWERS, projectNumber: 'Roadmap' },
    };

    await provisionResources(state, { exec });

    assert.equal(state.answers.projectNumber, '14');
    assert.equal(callsFor(exec, 'project create').length, 1);
  });

  it('falls through to create when the list call throws (degrades to no-match)', async () => {
    const dir = makeTmpDir();
    const exec = makeExec({
      'repo view': () => ({ stdout: JSON.stringify({ name: 'widget' }) }),
      'project list': () => {
        throw new Error('gh exploded');
      },
      'project create': () => ({ stdout: JSON.stringify({ number: 21 }) }),
      'project link': () => ({ stdout: '' }),
    });
    const state = {
      projectRoot: dir,
      gitInitialized: false,
      flags: {},
      creation: { newRepo: false, newProject: true },
      answers: { ...ANSWERS, projectNumber: 'Roadmap' },
    };

    const res = await provisionResources(state, { exec });

    assert.equal(res.ok, true);
    assert.equal(state.answers.projectNumber, '21');
    assert.equal(callsFor(exec, 'project create').length, 1);
  });
});

describe('idempotent re-run — two consecutive --assume-yes provisioning passes create exactly one board', () => {
  it('first pass creates; second pass (same typed name) adopts — single create total', async () => {
    const dir = makeTmpDir();
    // A mutable "owner's projects" store the fake `gh` reads/writes so the
    // second pass sees what the first created — the real-world re-run shape.
    const boards = [];
    let nextNumber = 100;
    const exec = makeExec({
      'repo view': () => ({ stdout: JSON.stringify({ name: 'widget' }) }),
      'project list': () => ({ stdout: JSON.stringify({ projects: boards }) }),
      'project create': (args) => {
        const title = args[args.indexOf('--title') + 1];
        const number = nextNumber++;
        boards.push({ number, title });
        return { stdout: JSON.stringify({ number }) };
      },
      'project link': () => ({ stdout: '' }),
    });

    const makeState = () => ({
      projectRoot: dir,
      gitInitialized: false,
      flags: {},
      creation: { newRepo: false, newProject: true },
      answers: { ...ANSWERS, projectNumber: 'Roadmap' },
    });

    // Pass 1 — board does not exist yet → create.
    const first = makeState();
    await provisionResources(first, { exec });
    assert.equal(first.answers.projectNumber, '100');

    // Pass 2 — same typed name → dedupe adopts the board pass 1 created.
    const second = makeState();
    await provisionResources(second, { exec });
    assert.equal(second.answers.projectNumber, '100');

    // Exactly one board exists and exactly one create ran across both passes.
    assert.equal(boards.length, 1);
    assert.equal(callsFor(exec, 'project create').length, 1);
  });
});

describe('dry-run-safe — no provisioning mutations under --dry-run', () => {
  it('dryRunPlan halts the pipeline before provisionResources runs', () => {
    const state = {
      flags: { 'dry-run': true },
      answers: { ...ANSWERS, projectNumber: 'Roadmap' },
      creation: { newRepo: true, newProject: true },
      gitInitialized: false,
    };
    const res = dryRunPlan(state);
    // A halt (ok:false, exit:0) — provisionResources is never reached in main.
    assert.equal(res.ok, false);
    assert.equal(res.exit, 0);
  });

  it('provisionResources under --skip-github spawns no gh for new repo/project', async () => {
    const dir = makeTmpDir();
    const exec = makeExec({});
    const res = await provisionResources(
      {
        projectRoot: dir,
        gitInitialized: false,
        flags: { 'skip-github': true },
        creation: { newRepo: true, newProject: true },
        answers: { ...ANSWERS, projectNumber: 'Roadmap' },
      },
      { exec },
    );
    assert.equal(res.ok, true);
    // No gh call of any kind reached the fake.
    assert.equal(exec.calls.length, 0);
    // Local git WAS still provisioned (the skip-github guard only blocks gh).
    assert.equal(git(['rev-parse', '--verify', 'HEAD'], dir).status, 0);
  });
});
