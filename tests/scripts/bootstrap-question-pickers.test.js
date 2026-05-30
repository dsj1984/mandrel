/**
 * bootstrap-question-pickers.test — Story #3377
 *
 * Pins the picker wiring on the bootstrap question list:
 *
 *   1. `buildQuestions` attaches a `picker: { list }` to the `repo` question
 *      (backed by `listRepos`, mapping each `owner/name` slug to its bare
 *      repo name) and to the `projectNumber` question (backed by
 *      `listProjects`, returning project titles). The owner is resolved up
 *      front via the same flag → env → inferred-default precedence the
 *      `owner` question walks, so the pickers scope their `gh` queries to the
 *      right owner.
 *   2. Precedence holds: when `--owner`/`--repo` or `GH_OWNER`/`GH_REPO` are
 *      supplied, or `--assume-yes` is set, the picker never runs because the
 *      earlier resolvers (`resolveFromFlag` / `resolveFromEnv` /
 *      `resolveAssumeYes`) win first — the supplied values are used verbatim.
 *
 * The `gh-list` providers are injected as stubs so no real `gh` child is
 * spawned (unit tier — all I/O is mocked).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildQuestions,
  resolveOwnerForPicker,
} from '../../.agents/scripts/bootstrap.js';
import {
  collectAnswers,
  resolveFromPicker,
} from '../../.agents/scripts/lib/bootstrap/prompt.js';

const DEFAULTS = Object.freeze({
  owner: 'acme',
  repo: 'inferred-repo',
  baseBranch: 'main',
  operatorHandle: 'octo',
});

function findQuestion(questions, key) {
  const q = questions.find((entry) => entry.key === key);
  assert.ok(q, `expected a "${key}" question`);
  return q;
}

function stubProviders({ repos = [], projects = [] } = {}) {
  const calls = { listRepos: [], listProjects: [] };
  return {
    calls,
    providers: {
      listRepos: (opts) => {
        calls.listRepos.push(opts);
        return repos;
      },
      listProjects: (opts) => {
        calls.listProjects.push(opts);
        return projects;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// resolveOwnerForPicker
// ---------------------------------------------------------------------------

describe('resolveOwnerForPicker', () => {
  it('prefers the --owner flag over env and default', () => {
    assert.equal(
      resolveOwnerForPicker(
        DEFAULTS,
        { owner: 'flagged' },
        { GH_OWNER: 'env' },
      ),
      'flagged',
    );
  });

  it('falls back to GH_OWNER env when no flag is present', () => {
    assert.equal(
      resolveOwnerForPicker(DEFAULTS, {}, { GH_OWNER: 'env-owner' }),
      'env-owner',
    );
  });

  it('falls back to the inferred default when no flag/env is present', () => {
    assert.equal(resolveOwnerForPicker(DEFAULTS, {}, {}), 'acme');
  });

  it('returns null when nothing resolves an owner', () => {
    assert.equal(resolveOwnerForPicker({ owner: null }, {}, {}), null);
  });
});

// ---------------------------------------------------------------------------
// buildQuestions — picker attachment
// ---------------------------------------------------------------------------

describe('buildQuestions picker attachment', () => {
  it('attaches a repo picker that lists bare repo names for the owner', () => {
    const { calls, providers } = stubProviders({
      repos: ['acme/api', 'acme/web'],
    });
    const questions = buildQuestions(DEFAULTS, {
      flags: {},
      env: {},
      providers,
    });
    const repo = findQuestion(questions, 'repo');
    assert.equal(typeof repo.picker?.list, 'function');
    assert.deepEqual(repo.picker.list(), ['api', 'web']);
    // owner was scoped from the inferred default
    assert.deepEqual(calls.listRepos[0], { owner: 'acme' });
  });

  it('leaves a slug without a slash untouched in the repo picker', () => {
    const { providers } = stubProviders({ repos: ['solo'] });
    const questions = buildQuestions(DEFAULTS, {
      flags: {},
      env: {},
      providers,
    });
    assert.deepEqual(findQuestion(questions, 'repo').picker.list(), ['solo']);
  });

  it('attaches a project picker that lists project titles for the owner', () => {
    const { calls, providers } = stubProviders({
      projects: ['Roadmap', 'Bugs'],
    });
    const questions = buildQuestions(DEFAULTS, {
      flags: {},
      env: {},
      providers,
    });
    const project = findQuestion(questions, 'projectNumber');
    assert.equal(typeof project.picker?.list, 'function');
    assert.deepEqual(project.picker.list(), ['Roadmap', 'Bugs']);
    assert.deepEqual(calls.listProjects[0], { owner: 'acme' });
  });

  it('scopes the repo picker to the --owner flag when supplied', () => {
    const { calls, providers } = stubProviders({ repos: ['other/x'] });
    const questions = buildQuestions(DEFAULTS, {
      flags: { owner: 'other' },
      env: {},
      providers,
    });
    findQuestion(questions, 'repo').picker.list();
    assert.deepEqual(calls.listRepos[0], { owner: 'other' });
  });

  it('does not attach a picker to the owner / baseBranch questions', () => {
    const questions = buildQuestions(DEFAULTS, { flags: {}, env: {} });
    assert.equal(findQuestion(questions, 'owner').picker, undefined);
    assert.equal(findQuestion(questions, 'baseBranch').picker, undefined);
  });
});

// ---------------------------------------------------------------------------
// Precedence — pickers do not run when values are supplied
// ---------------------------------------------------------------------------

describe('picker precedence in collectAnswers', () => {
  // A readline stub that fails loudly if any resolver tries to prompt — these
  // precedence tests must resolve via flag/env before any interactive read.
  const noPromptIo = Object.freeze({
    input: {},
    output: { write: () => {} },
  });

  it('uses the --repo flag verbatim and never calls the repo picker', async () => {
    const { calls, providers } = stubProviders({ repos: ['acme/should-not'] });
    const questions = buildQuestions(DEFAULTS, {
      flags: { owner: 'acme', repo: 'flag-repo' },
      env: {},
      providers,
    });
    const repo = questions.find((q) => q.key === 'repo');
    const { answers } = await collectAnswers({
      questions: [repo],
      flags: { repo: 'flag-repo' },
      interactive: true,
      assumeYes: false,
      ...noPromptIo,
    });
    assert.equal(answers.repo, 'flag-repo');
    assert.equal(calls.listRepos.length, 0, 'picker.list must not be invoked');
  });

  it('uses GH_REPO env verbatim and never calls the repo picker', async () => {
    const { calls, providers } = stubProviders({ repos: ['acme/should-not'] });
    const env = { GH_OWNER: 'acme', GH_REPO: 'env-repo' };
    const questions = buildQuestions(DEFAULTS, { flags: {}, env, providers });
    const repo = questions.find((q) => q.key === 'repo');
    const realEnv = process.env;
    process.env = { ...realEnv, ...env };
    try {
      const { answers } = await collectAnswers({
        questions: [repo],
        flags: {},
        interactive: true,
        assumeYes: false,
        ...noPromptIo,
      });
      assert.equal(answers.repo, 'env-repo');
      assert.equal(calls.listRepos.length, 0);
    } finally {
      process.env = realEnv;
    }
  });

  it('with --assume-yes accepts defaults and never calls the pickers', async () => {
    const { calls, providers } = stubProviders({
      repos: ['acme/should-not'],
      projects: ['Should Not'],
    });
    const questions = buildQuestions(DEFAULTS, {
      flags: {},
      env: {},
      providers,
    });
    const { answers } = await collectAnswers({
      questions,
      flags: {},
      interactive: false,
      assumeYes: true,
    });
    assert.equal(answers.owner, 'acme');
    assert.equal(answers.repo, 'inferred-repo');
    assert.equal(calls.listRepos.length, 0);
    assert.equal(calls.listProjects.length, 0);
  });

  it('renders the repo picker and returns the selected bare name when interactive', async () => {
    const { providers } = stubProviders({ repos: ['acme/api', 'acme/web'] });
    const questions = buildQuestions(DEFAULTS, {
      flags: {},
      env: {},
      providers,
    });
    const repo = findQuestion(questions, 'repo');
    const lines = [];
    const ctx = {
      q: repo,
      flags: {},
      env: {},
      silentSet: new Set(),
      interactive: true,
      assumeYes: false,
      getRl: () => Promise.resolve({ question: () => Promise.resolve('2') }),
      output: { write: (s) => lines.push(s) },
    };
    const outcome = await resolveFromPicker(ctx);
    assert.deepEqual(outcome, { kind: 'value', value: 'web' });
    const rendered = lines.join('');
    assert.match(rendered, /1\) api/);
    assert.match(rendered, /2\) web/);
  });

  it('skips the repo picker when no owner can be resolved (empty list)', async () => {
    const { calls, providers } = stubProviders({ repos: [] });
    const defaults = { ...DEFAULTS, owner: null };
    const questions = buildQuestions(defaults, {
      flags: {},
      env: {},
      providers,
    });
    const repo = findQuestion(questions, 'repo');
    const ctx = {
      q: repo,
      flags: {},
      env: {},
      silentSet: new Set(),
      interactive: true,
      assumeYes: false,
      getRl: () => Promise.reject(new Error('no rl expected')),
      output: { write: () => {} },
    };
    assert.deepEqual(await resolveFromPicker(ctx), { kind: 'skip' });
    // owner is null, listRepos stub returns [] → no menu rendered.
    assert.equal(calls.listRepos.length, 1);
    assert.deepEqual(calls.listRepos[0], { owner: null });
  });
});
