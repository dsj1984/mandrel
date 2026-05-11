import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createGh, GhExecError } from '../../.agents/scripts/lib/gh-exec.js';

/**
 * Build a fake `exec` that records every call and returns a canned value.
 * Tests assert on the recorded `args` array (and `input` for POST bodies) so
 * we cover argv shape without going near a real process.
 */
function makeFakeExec(returnValue = { stdout: '', stderr: '', code: 0 }) {
  const calls = [];
  const fake = ({ args, input, ...rest }) => {
    calls.push({ args, input, rest });
    return Promise.resolve(returnValue);
  };
  return { fake, calls };
}

describe('gh.issue wrappers — argv shape', () => {
  it('issue.view(123, [...]) emits the right argv with --json', async () => {
    const payload = { title: 't', body: 'b', labels: [] };
    const { fake, calls } = makeFakeExec(payload);
    const gh = createGh(fake);

    const result = await gh.issue.view(123, ['title', 'body', 'labels']);
    assert.deepEqual(result, payload);
    assert.deepEqual(calls[0].args, [
      'issue',
      'view',
      '123',
      '--json',
      'title,body,labels',
    ]);
  });

  it('issue.view without fields omits --json (raw text mode)', async () => {
    const { fake, calls } = makeFakeExec({
      stdout: 'free text',
      stderr: '',
      code: 0,
    });
    const gh = createGh(fake);
    await gh.issue.view(7);
    assert.deepEqual(calls[0].args, ['issue', 'view', '7']);
  });

  it('issue.comment streams body via stdin (no shell interpolation)', async () => {
    const { fake, calls } = makeFakeExec({ stdout: '', stderr: '', code: 0 });
    const gh = createGh(fake);
    await gh.issue.comment(42, 'hello $world `pwned`');
    assert.deepEqual(calls[0].args, [
      'issue',
      'comment',
      '42',
      '--body-file',
      '-',
    ]);
    assert.equal(calls[0].input, 'hello $world `pwned`');
  });

  it('issue.list passes flags before --json fields', async () => {
    const { fake, calls } = makeFakeExec([]);
    const gh = createGh(fake);
    await gh.issue.list(
      ['--state', 'open', '--limit', '50'],
      ['number', 'title'],
    );
    assert.deepEqual(calls[0].args, [
      'issue',
      'list',
      '--state',
      'open',
      '--limit',
      '50',
      '--json',
      'number,title',
    ]);
  });
});

describe('gh.api wrapper — REST translation', () => {
  it('POST with body shells to gh api -X POST --input -', async () => {
    const { fake, calls } = makeFakeExec({
      stdout: '{"id":1}',
      stderr: '',
      code: 0,
    });
    const gh = createGh(fake);
    await gh.api({
      method: 'POST',
      endpoint: '/repos/foo/bar/issues',
      body: { title: 'new', body: 'hi' },
    });
    assert.deepEqual(calls[0].args, [
      'api',
      '-X',
      'POST',
      '/repos/foo/bar/issues',
      '--input',
      '-',
    ]);
    assert.equal(calls[0].input, JSON.stringify({ title: 'new', body: 'hi' }));
  });

  it('GET with paginate adds --paginate', async () => {
    const { fake, calls } = makeFakeExec({ stdout: '[]', stderr: '', code: 0 });
    const gh = createGh(fake);
    await gh.api({
      endpoint: '/repos/foo/bar/issues',
      paginate: true,
    });
    assert.deepEqual(calls[0].args, [
      'api',
      '-X',
      'GET',
      '/repos/foo/bar/issues',
      '--paginate',
    ]);
    assert.equal(calls[0].input, undefined);
  });

  it('rejects when endpoint is missing', async () => {
    const { fake } = makeFakeExec();
    const gh = createGh(fake);
    await assert.rejects(
      gh.api({ method: 'GET' }),
      (err) =>
        err instanceof GhExecError && /endpoint.*required/.test(err.message),
    );
  });
});

describe('gh.pr / gh.label / gh.repo wrappers — argv shape', () => {
  it('pr.view(99, fields)', async () => {
    const { fake, calls } = makeFakeExec({});
    const gh = createGh(fake);
    await gh.pr.view(99, ['number', 'state']);
    assert.deepEqual(calls[0].args, [
      'pr',
      'view',
      '99',
      '--json',
      'number,state',
    ]);
  });

  it('pr.create passes flags through', async () => {
    const { fake, calls } = makeFakeExec({});
    const gh = createGh(fake);
    await gh.pr.create(['--title', 'T', '--body', 'B', '--base', 'main']);
    assert.deepEqual(calls[0].args, [
      'pr',
      'create',
      '--title',
      'T',
      '--body',
      'B',
      '--base',
      'main',
    ]);
  });

  it('pr.merge with squash flag', async () => {
    const { fake, calls } = makeFakeExec({});
    const gh = createGh(fake);
    await gh.pr.merge(42, ['--squash', '--delete-branch']);
    assert.deepEqual(calls[0].args, [
      'pr',
      'merge',
      '42',
      '--squash',
      '--delete-branch',
    ]);
  });

  it('label.create with flags', async () => {
    const { fake, calls } = makeFakeExec({});
    const gh = createGh(fake);
    await gh.label.create('bug', [
      '--color',
      'd73a4a',
      '--description',
      'Something broken',
    ]);
    assert.deepEqual(calls[0].args, [
      'label',
      'create',
      'bug',
      '--color',
      'd73a4a',
      '--description',
      'Something broken',
    ]);
  });

  it('repo.view with explicit target + fields', async () => {
    const { fake, calls } = makeFakeExec({});
    const gh = createGh(fake);
    await gh.repo.view('octocat/Hello-World', ['name', 'description']);
    assert.deepEqual(calls[0].args, [
      'repo',
      'view',
      'octocat/Hello-World',
      '--json',
      'name,description',
    ]);
  });

  it('repo.view with no target falls back to current-dir repo', async () => {
    const { fake, calls } = makeFakeExec({});
    const gh = createGh(fake);
    await gh.repo.view(null, ['name']);
    assert.deepEqual(calls[0].args, ['repo', 'view', '--json', 'name']);
  });
});
