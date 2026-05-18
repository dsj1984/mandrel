/**
 * Unit tests for `.agents/scripts/providers/github/labels.js`.
 *
 * Covers idempotent label creation (created/skipped split), the
 * already-exists detector across CLI / API / test-mock shapes, and the
 * post-loop reconcile path that promotes silently-missing labels into
 * the `missing[]` envelope.
 *
 * Story #2462 / Task #2478 — LabelGateway is the fourth slice of the
 * seven-gateway split.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const labelsMod = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'providers', 'github', 'labels.js'),
  ).href
);

const { LabelGateway, isLabelAlreadyExistsError } = labelsMod;

/**
 * Minimal gh-exec stand-in exposing only the surfaces `LabelGateway`
 * reaches for: `gh.label.create(name, args)` and `gh.label.list(args, jsonFields)`.
 */
function makeFakeGh({ onCreate, listResult }) {
  return {
    label: {
      create: async (name, args) => onCreate?.(name, args),
      list: async () => listResult ?? { stdout: '[]' },
    },
  };
}

describe('providers/github/labels.js — isLabelAlreadyExistsError', () => {
  it('matches the CLI stderr shape', () => {
    const err = new Error('cli failed');
    err.stderr = '! Label "type::task" already exists';
    assert.equal(isLabelAlreadyExistsError(err), true);
  });

  it('matches the REST 422 already_exists body', () => {
    const err = new Error('label create failed: already_exists');
    assert.equal(isLabelAlreadyExistsError(err), true);
  });

  it('matches the test-mock legacy code-422 shape', () => {
    const err = new Error('label create failed code 422 already exists');
    assert.equal(isLabelAlreadyExistsError(err), true);
  });

  it('does not match unrelated stderr lines that happen to say already exists', () => {
    const err = new Error('unrelated');
    err.stderr = 'protection: webhook already exists';
    assert.equal(isLabelAlreadyExistsError(err), false);
  });

  it('returns false on null', () => {
    assert.equal(isLabelAlreadyExistsError(null), false);
  });
});

describe('providers/github/labels.js — LabelGateway', () => {
  it('ensureLabels: creates net-new labels and reports them in created[]', async () => {
    const createCalls = [];
    const gh = makeFakeGh({
      onCreate: (name, args) => {
        createCalls.push({ name, args });
      },
      listResult: {
        stdout: JSON.stringify([
          { name: 'type::task' },
          { name: 'type::epic' },
        ]),
      },
    });
    const gw = new LabelGateway({ gh, owner: 'o', repo: 'r' });
    const out = await gw.ensureLabels([
      { name: 'type::task', color: '#abcdef', description: 'task' },
      { name: 'type::epic', color: 'fedcba', description: 'epic' },
    ]);
    assert.deepEqual(out.created.sort(), ['type::epic', 'type::task']);
    assert.deepEqual(out.skipped, []);
    assert.deepEqual(out.missing, []);
    assert.equal(createCalls.length, 2);
    // Hex prefix is stripped before passing to the CLI.
    assert.equal(createCalls[0].args[1], 'abcdef');
  });

  it('ensureLabels: classifies "already exists" errors as skipped', async () => {
    const gh = makeFakeGh({
      onCreate: (name) => {
        if (name === 'type::task') {
          const err = new Error('already_exists');
          err.stderr = 'Label "type::task" already exists';
          throw err;
        }
      },
      listResult: {
        stdout: JSON.stringify([
          { name: 'type::task' },
          { name: 'type::epic' },
        ]),
      },
    });
    const gw = new LabelGateway({ gh, owner: 'o', repo: 'r' });
    const out = await gw.ensureLabels([
      { name: 'type::task', color: '#aaaaaa' },
      { name: 'type::epic', color: '#bbbbbb' },
    ]);
    assert.deepEqual(out.created, ['type::epic']);
    assert.deepEqual(out.skipped, ['type::task']);
    assert.deepEqual(out.missing, []);
  });

  it('ensureLabels: promotes silently-missing labels to missing[]', async () => {
    const gh = makeFakeGh({
      onCreate: () => {
        // Claims success but the live label set proves otherwise.
      },
      listResult: { stdout: JSON.stringify([{ name: 'type::epic' }]) },
    });
    const gw = new LabelGateway({ gh, owner: 'o', repo: 'r' });
    const out = await gw.ensureLabels([
      { name: 'type::task', color: '#aaaaaa' },
      { name: 'type::epic', color: '#bbbbbb' },
    ]);
    // The honest math: task isn't on the remote, so it leaves created[]
    // and lands in missing[].
    assert.deepEqual(out.created, ['type::epic']);
    assert.deepEqual(out.skipped, []);
    assert.deepEqual(out.missing, ['type::task']);
  });

  it('ensureLabels: returns missing=[] when list-call fails (verification unavailable)', async () => {
    const gh = {
      label: {
        create: async () => {},
        list: async () => {
          throw new Error('list failed');
        },
      },
    };
    const gw = new LabelGateway({ gh, owner: 'o', repo: 'r' });
    const out = await gw.ensureLabels([
      { name: 'type::task', color: '#aaaaaa' },
    ]);
    assert.deepEqual(out.created, ['type::task']);
    assert.deepEqual(out.missing, []);
  });

  it('ensureLabels: rethrows non-"already exists" errors', async () => {
    const gh = makeFakeGh({
      onCreate: () => {
        throw new Error('rate limited');
      },
    });
    const gw = new LabelGateway({ gh, owner: 'o', repo: 'r' });
    await assert.rejects(
      () => gw.ensureLabels([{ name: 'x', color: '#fff' }]),
      /rate limited/,
    );
  });

  it('_normalizeLabelListResult: handles Array, stdout-string, and garbage shapes', () => {
    const gw = new LabelGateway({
      gh: makeFakeGh({}),
      owner: 'o',
      repo: 'r',
    });
    assert.deepEqual(gw._normalizeLabelListResult([{ name: 'a' }]), [
      { name: 'a' },
    ]);
    assert.deepEqual(
      gw._normalizeLabelListResult({ stdout: '[{"name":"b"}]' }),
      [{ name: 'b' }],
    );
    assert.deepEqual(gw._normalizeLabelListResult({ stdout: 'not-json' }), []);
    assert.deepEqual(gw._normalizeLabelListResult(null), []);
  });
});
