/**
 * bootstrap-question-pickers.test — Story #3377, repointed at the collapsed
 * orchestrator by Story #3690.
 *
 * Pins the picker wiring on the bootstrap question list:
 *
 *   1. `buildQuestions` attaches a `picker: { list }` to the `repo` and
 *      `projectNumber` questions. The pre-fetched `lists` (shared with the
 *      summary display) are the fast path; when they are empty the picker
 *      falls back to a live fetch keyed off the owner resolved so far —
 *      and degrades to an empty list (skip) when no owner resolves.
 *   2. Precedence holds: when `--owner`/`--repo` or `GH_OWNER`/`GH_REPO` are
 *      supplied, or `--assume-yes` is set, the picker never runs because the
 *      earlier resolvers (`resolveFromFlag` / `resolveFromEnv` /
 *      `resolveAssumeYes`) win first — the supplied values are used verbatim.
 *
 * The pre-fetched lists are plain in-memory fixtures so no real `gh` child
 * is spawned (unit tier — all I/O is mocked).
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

const PROJECTS = Object.freeze([
  { label: 'Roadmap (#7)', value: '7' },
  { label: 'Bugs (#9)', value: '9' },
]);

function findQuestion(questions, key) {
  const q = questions.find((entry) => entry.key === key);
  assert.ok(q, `expected a "${key}" question`);
  return q;
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
  it('attaches a repo picker that serves the pre-fetched bare repo names', () => {
    const questions = buildQuestions(
      DEFAULTS,
      {},
      {},
      { reposList: ['api', 'web'], projectsList: [] },
    );
    const repo = findQuestion(questions, 'repo');
    assert.equal(typeof repo.picker?.list, 'function');
    assert.deepEqual(repo.picker.list({}), ['api', 'web']);
  });

  it('attaches a project picker that serves the pre-fetched project choices', () => {
    const questions = buildQuestions(
      DEFAULTS,
      {},
      {},
      { reposList: [], projectsList: PROJECTS },
    );
    const project = findQuestion(questions, 'projectNumber');
    assert.equal(typeof project.picker?.list, 'function');
    assert.deepEqual(project.picker.list({}), PROJECTS);
  });

  it('does not attach a picker to the owner / baseBranch questions', () => {
    const questions = buildQuestions(DEFAULTS, {}, {}, {});
    assert.equal(findQuestion(questions, 'owner').picker, undefined);
    assert.equal(findQuestion(questions, 'baseBranch').picker, undefined);
  });

  it('repo picker degrades to an empty list when no owner resolves and no list was pre-fetched', () => {
    const questions = buildQuestions(
      { ...DEFAULTS, owner: null },
      {},
      {},
      { reposList: [], projectsList: [] },
    );
    const repo = findQuestion(questions, 'repo');
    // No owner from defaults/flags/env and none answered yet → [] without
    // any live gh fetch.
    assert.deepEqual(repo.picker.list({}), []);
  });
});

// ---------------------------------------------------------------------------
// buildQuestions — projectNumber default (re-run dedupe, Story #3896)
// ---------------------------------------------------------------------------

describe('buildQuestions projectNumber default', () => {
  it('uses the stored numeric projectNumber as the default when present', () => {
    const questions = buildQuestions(
      { ...DEFAULTS, projectNumber: '42' },
      {},
      {},
      {},
    );
    // An already-provisioned project: --assume-yes resolves "42" (numeric →
    // existing → no duplicate board), not the repo name.
    assert.equal(findQuestion(questions, 'projectNumber').default, '42');
  });

  it('falls back to the repo name when no stored projectNumber exists', () => {
    const questions = buildQuestions(
      { ...DEFAULTS, projectNumber: null },
      {},
      {},
      {},
    );
    // A genuine first run: the default is the repo name (a typed-name path
    // that still creates the board).
    assert.equal(
      findQuestion(questions, 'projectNumber').default,
      'inferred-repo',
    );
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

  function trackedQuestions(flags, env) {
    let pickerCalls = 0;
    const questions = buildQuestions(DEFAULTS, flags, env, {
      reposList: ['should-not'],
      projectsList: PROJECTS,
    });
    for (const q of questions) {
      if (!q.picker) continue;
      const orig = q.picker.list;
      q.picker.list = (answers) => {
        pickerCalls += 1;
        return orig(answers);
      };
    }
    return { questions, count: () => pickerCalls };
  }

  it('uses the --repo flag verbatim and never calls the repo picker', async () => {
    const { questions, count } = trackedQuestions(
      { owner: 'acme', repo: 'flag-repo' },
      {},
    );
    const repo = findQuestion(questions, 'repo');
    const { answers } = await collectAnswers({
      questions: [repo],
      flags: { repo: 'flag-repo' },
      interactive: true,
      assumeYes: false,
      ...noPromptIo,
    });
    assert.equal(answers.repo, 'flag-repo');
    assert.equal(count(), 0, 'picker.list must not be invoked');
  });

  it('uses GH_REPO env verbatim and never calls the repo picker', async () => {
    const env = { GH_OWNER: 'acme', GH_REPO: 'env-repo' };
    const { questions, count } = trackedQuestions({}, env);
    const repo = findQuestion(questions, 'repo');
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
      assert.equal(count(), 0);
    } finally {
      process.env = realEnv;
    }
  });

  it('with --assume-yes accepts defaults and never calls the pickers', async () => {
    const { questions, count } = trackedQuestions({}, {});
    const { answers } = await collectAnswers({
      questions,
      flags: {},
      interactive: false,
      assumeYes: true,
    });
    assert.equal(answers.owner, 'acme');
    assert.equal(answers.repo, 'inferred-repo');
    assert.equal(count(), 0);
  });

  it('renders the repo picker and returns the selected name when interactive', async () => {
    const questions = buildQuestions(
      DEFAULTS,
      {},
      {},
      { reposList: ['api', 'web'], projectsList: [] },
    );
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
    const questions = buildQuestions(
      { ...DEFAULTS, owner: null },
      {},
      {},
      { reposList: [], projectsList: [] },
    );
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
  });
});
