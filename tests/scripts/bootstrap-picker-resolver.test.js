/**
 * bootstrap-picker-resolver.test — Story #3374
 *
 * Pins the selection substrate for live pickers:
 *
 *   1. `gh-list` providers (`listRepos` / `listProjects`) — shell out via an
 *      injectable `gh` runner, return a flat string array on success, and
 *      degrade to `[]` on any non-zero exit / spawn error / missing owner.
 *   2. `resolveFromPicker` — the resolver inserted between
 *      `resolveFromSilent` and `resolveInteractive` in the `RESOLVERS`
 *      chain. It returns `kind: 'skip'` when not interactive, when the
 *      question carries no picker, or when the provider returns an empty
 *      list (falling through to manual entry); otherwise it renders a
 *      numbered menu and returns the selected value.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  listProjects,
  listRepos,
} from '../../.agents/scripts/lib/bootstrap/gh-list.js';
import {
  normalizePickerChoice,
  RESOLVERS,
  resolveFromPicker,
  resolveFromSilent,
  resolveInteractive,
} from '../../.agents/scripts/lib/bootstrap/prompt.js';

function okRunner(stdout) {
  return () => ({ status: 0, stdout, stderr: '', error: undefined });
}

function failRunner(status = 1, stderr = 'boom') {
  return () => ({ status, stdout: '', stderr, error: undefined });
}

function baseCtx(overrides = {}) {
  return {
    q: { key: 'repo', message: 'Pick a repository', ...(overrides.q ?? {}) },
    flags: {},
    env: {},
    silentSet: new Set(),
    interactive: overrides.interactive ?? true,
    assumeYes: false,
    getRl:
      overrides.getRl ?? (() => Promise.reject(new Error('no rl expected'))),
    output: overrides.output ?? { write: () => {} },
  };
}

// ---------------------------------------------------------------------------
// gh-list providers
// ---------------------------------------------------------------------------

describe('listRepos', () => {
  it('maps nameWithOwner out of the JSON array on success', () => {
    const runner = okRunner(
      JSON.stringify([
        { nameWithOwner: 'acme/api' },
        { nameWithOwner: 'acme/web' },
      ]),
    );
    assert.deepEqual(listRepos({ owner: 'acme', runner }), [
      'acme/api',
      'acme/web',
    ]);
  });

  it('returns [] on a non-zero exit', () => {
    assert.deepEqual(listRepos({ owner: 'acme', runner: failRunner() }), []);
  });

  it('returns [] on a spawn error', () => {
    const runner = () => ({
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    });
    assert.deepEqual(listRepos({ owner: 'acme', runner }), []);
  });

  it('returns [] when owner is missing', () => {
    let called = false;
    const runner = () => {
      called = true;
      return { status: 0, stdout: '[]', stderr: '', error: undefined };
    };
    assert.deepEqual(listRepos({ runner }), []);
    assert.equal(called, false, 'must not shell out without an owner');
  });

  it('returns [] on unparseable stdout', () => {
    assert.deepEqual(
      listRepos({ owner: 'acme', runner: okRunner('not-json') }),
      [],
    );
  });
});

describe('listProjects', () => {
  it('maps { label, value } choices out of the { projects: [...] } envelope', () => {
    const runner = okRunner(
      JSON.stringify({
        projects: [
          { title: 'Roadmap', number: 7 },
          { title: 'Bugs', number: 12 },
        ],
      }),
    );
    assert.deepEqual(listProjects({ owner: 'acme', runner }), [
      { label: 'Roadmap (#7)', value: '7' },
      { label: 'Bugs (#12)', value: '12' },
    ]);
  });

  it('also accepts a bare JSON array of projects', () => {
    const runner = okRunner(JSON.stringify([{ title: 'Roadmap', number: 3 }]));
    assert.deepEqual(listProjects({ owner: 'acme', runner }), [
      { label: 'Roadmap (#3)', value: '3' },
    ]);
  });

  it('drops projects without an integer number', () => {
    const runner = okRunner(
      JSON.stringify({
        projects: [{ title: 'No Number' }, { title: 'Good', number: 5 }],
      }),
    );
    assert.deepEqual(listProjects({ owner: 'acme', runner }), [
      { label: 'Good (#5)', value: '5' },
    ]);
  });

  it('falls back to the number as the label when title is missing', () => {
    const runner = okRunner(JSON.stringify([{ number: 9 }]));
    assert.deepEqual(listProjects({ owner: 'acme', runner }), [
      { label: '9 (#9)', value: '9' },
    ]);
  });

  it('returns [] on a non-zero exit', () => {
    assert.deepEqual(listProjects({ owner: 'acme', runner: failRunner() }), []);
  });

  it('returns [] when owner is missing', () => {
    assert.deepEqual(listProjects({ runner: okRunner('[]') }), []);
  });
});

// ---------------------------------------------------------------------------
// resolveFromPicker
// ---------------------------------------------------------------------------

describe('resolveFromPicker', () => {
  it('is wired into RESOLVERS after resolveFromSilent and before resolveInteractive', () => {
    const silentIdx = RESOLVERS.indexOf(resolveFromSilent);
    const pickerIdx = RESOLVERS.indexOf(resolveFromPicker);
    const interactiveIdx = RESOLVERS.indexOf(resolveInteractive);
    assert.ok(pickerIdx > silentIdx, 'picker must come after silent');
    assert.ok(
      pickerIdx < interactiveIdx,
      'picker must come before interactive',
    );
  });

  it('skips when not interactive', async () => {
    const ctx = baseCtx({
      interactive: false,
      q: { picker: { list: () => ['a', 'b'] } },
    });
    assert.deepEqual(await resolveFromPicker(ctx), { kind: 'skip' });
  });

  it('skips when the question has no picker', async () => {
    const ctx = baseCtx();
    assert.deepEqual(await resolveFromPicker(ctx), { kind: 'skip' });
  });

  it('skips when the provider returns an empty list', async () => {
    const ctx = baseCtx({ q: { picker: { list: () => [] } } });
    assert.deepEqual(await resolveFromPicker(ctx), { kind: 'skip' });
  });

  it('renders a numbered menu and returns the selected value', async () => {
    const lines = [];
    const ctx = baseCtx({
      q: {
        message: 'Pick a repository',
        picker: { list: () => ['acme/api', 'acme/web'] },
      },
      output: { write: (s) => lines.push(s) },
      getRl: () => Promise.resolve({ question: () => Promise.resolve('2') }),
    });
    const outcome = await resolveFromPicker(ctx);
    assert.deepEqual(outcome, { kind: 'value', value: 'acme/web' });
    const rendered = lines.join('');
    assert.match(rendered, /1\) acme\/api/);
    assert.match(rendered, /2\) acme\/web/);
  });

  it('skips (falls through to manual entry) on a blank selection', async () => {
    const ctx = baseCtx({
      q: { picker: { list: () => ['acme/api'] } },
      getRl: () => Promise.resolve({ question: () => Promise.resolve('   ') }),
    });
    assert.deepEqual(await resolveFromPicker(ctx), { kind: 'skip' });
  });

  it('skips on an out-of-range selection', async () => {
    const ctx = baseCtx({
      q: { picker: { list: () => ['acme/api'] } },
      getRl: () => Promise.resolve({ question: () => Promise.resolve('9') }),
    });
    assert.deepEqual(await resolveFromPicker(ctx), { kind: 'skip' });
  });

  it('awaits async picker.list providers', async () => {
    const ctx = baseCtx({
      q: { picker: { list: async () => ['only/one'] } },
      getRl: () => Promise.resolve({ question: () => Promise.resolve('1') }),
    });
    assert.deepEqual(await resolveFromPicker(ctx), {
      kind: 'value',
      value: 'only/one',
    });
  });

  it('renders { label, value } choices by label and resolves the value', async () => {
    const lines = [];
    const ctx = baseCtx({
      q: {
        message: 'Pick a project',
        picker: {
          list: () => [
            { label: 'Roadmap (#7)', value: '7' },
            { label: 'Bugs (#12)', value: '12' },
          ],
        },
      },
      output: { write: (s) => lines.push(s) },
      getRl: () => Promise.resolve({ question: () => Promise.resolve('2') }),
    });
    const outcome = await resolveFromPicker(ctx);
    assert.deepEqual(outcome, { kind: 'value', value: '12' });
    const rendered = lines.join('');
    assert.match(rendered, /1\) Roadmap \(#7\)/);
    assert.match(rendered, /2\) Bugs \(#12\)/);
  });

  it('skips (manual entry) when the selected value fails q.validate', async () => {
    const lines = [];
    const ctx = baseCtx({
      q: {
        key: 'projectNumber',
        message: 'Pick a project',
        // A picker accidentally yielding a non-numeric value must not bypass
        // the numeric validator — it falls through to manual entry instead.
        picker: { list: () => [{ label: 'Roadmap', value: 'Roadmap' }] },
        validate: (v) => (/^\d+$/.test(v) ? null : 'Must be an integer'),
      },
      output: { write: (s) => lines.push(s) },
      getRl: () => Promise.resolve({ question: () => Promise.resolve('1') }),
    });
    assert.deepEqual(await resolveFromPicker(ctx), { kind: 'skip' });
    assert.match(lines.join(''), /Must be an integer/);
  });

  it('returns the value when the selection passes q.validate', async () => {
    const ctx = baseCtx({
      q: {
        key: 'projectNumber',
        message: 'Pick a project',
        picker: { list: () => [{ label: 'Roadmap (#7)', value: '7' }] },
        validate: (v) => (/^\d+$/.test(v) ? null : 'Must be an integer'),
      },
      getRl: () => Promise.resolve({ question: () => Promise.resolve('1') }),
    });
    assert.deepEqual(await resolveFromPicker(ctx), {
      kind: 'value',
      value: '7',
    });
  });
});

describe('normalizePickerChoice', () => {
  it('treats a bare string as both label and value', () => {
    assert.deepEqual(normalizePickerChoice('acme/api'), {
      label: 'acme/api',
      value: 'acme/api',
    });
  });

  it('keeps an explicit label/value pair', () => {
    assert.deepEqual(
      normalizePickerChoice({ label: 'Roadmap (#7)', value: '7' }),
      {
        label: 'Roadmap (#7)',
        value: '7',
      },
    );
  });

  it('falls back to the value as the label when label is absent', () => {
    assert.deepEqual(normalizePickerChoice({ value: '7' }), {
      label: '7',
      value: '7',
    });
  });
});
