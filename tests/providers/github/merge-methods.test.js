/**
 * Unit tests for `.agents/scripts/providers/github/merge-methods.js`.
 *
 * Covers the narrow read/write surface for repo merge-method settings.
 * The gateway preserves the contract that `getMergeMethods` returns only
 * the bootstrap-relevant fields and `setMergeMethods` sends a sparse
 * body that touches only what the caller supplied.
 *
 * Story #2462 / Task #2479 — MergeMethodsGateway is the seventh slice of
 * the seven-gateway split.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const mmMod = await import(
  pathToFileURL(
    path.join(
      ROOT,
      '.agents',
      'scripts',
      'providers',
      'github',
      'merge-methods.js',
    ),
  ).href
);
const ghExecMod = await import(
  pathToFileURL(path.join(ROOT, '.agents', 'scripts', 'lib', 'gh-exec.js')).href
);

const { MergeMethodsGateway, MERGE_METHOD_FIELDS } = mmMod;
const { createGh } = ghExecMod;

function makeFakeGh(routes) {
  const calls = [];
  const exec = async ({ args, input }) => {
    calls.push({ args, input });
    const method = args[2] ?? 'GET';
    const endpoint = args[3] ?? '';
    for (const [key, val] of Object.entries(routes)) {
      const [m, ...rest] = key.split(' ');
      if (m === method && endpoint.includes(rest.join(' '))) {
        return { stdout: JSON.stringify(val.json ?? {}), stderr: '', code: 0 };
      }
    }
    return { stdout: '{}', stderr: '', code: 0 };
  };
  exec.calls = calls;
  const gh = createGh(exec);
  gh.__exec = exec;
  return gh;
}

describe('providers/github/merge-methods.js — MergeMethodsGateway', () => {
  it('MERGE_METHOD_FIELDS exposes the bootstrap-relevant field list', () => {
    assert.ok(MERGE_METHOD_FIELDS.includes('allow_squash_merge'));
    assert.ok(MERGE_METHOD_FIELDS.includes('delete_branch_on_merge'));
  });

  it('getMergeMethods: returns only the bootstrap-relevant fields from the repo body', async () => {
    const gh = makeFakeGh({
      'GET /repos/o/r': {
        json: {
          allow_squash_merge: true,
          allow_rebase_merge: false,
          allow_merge_commit: true,
          allow_auto_merge: true,
          delete_branch_on_merge: false,
          // Noise that should be filtered out:
          name: 'r',
          private: false,
        },
      },
    });
    const gw = new MergeMethodsGateway({ gh, owner: 'o', repo: 'r' });
    const out = await gw.getMergeMethods();
    assert.equal(out.allow_squash_merge, true);
    assert.equal(out.allow_rebase_merge, false);
    assert.equal(out.delete_branch_on_merge, false);
    assert.equal(Object.hasOwn(out, 'name'), false);
    assert.equal(Object.hasOwn(out, 'private'), false);
  });

  it('setMergeMethods: PATCHes a sparse body containing only supplied fields', async () => {
    const gh = makeFakeGh({
      'PATCH /repos/o/r': { json: {} },
    });
    const gw = new MergeMethodsGateway({ gh, owner: 'o', repo: 'r' });
    const out = await gw.setMergeMethods({
      allow_merge_commit: false,
      // Unknown fields are silently dropped (sparse contract).
      unrelated_flag: true,
    });
    assert.deepEqual(out.patched, ['allow_merge_commit']);
    const patch = JSON.parse(gh.__exec.calls[0].input);
    assert.deepEqual(patch, { allow_merge_commit: false });
  });

  it('setMergeMethods: empty settings yields an empty patched[] but still PATCHes', async () => {
    const gh = makeFakeGh({
      'PATCH /repos/o/r': { json: {} },
    });
    const gw = new MergeMethodsGateway({ gh, owner: 'o', repo: 'r' });
    const out = await gw.setMergeMethods({});
    assert.deepEqual(out.patched, []);
  });
});
