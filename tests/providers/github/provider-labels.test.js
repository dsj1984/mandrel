/**
 * GitHubProvider facade — labels surface.
 *
 * Tests GitHubProvider.ensureLabels() — per-def `gh label create` with the
 * "already exists" swallow path plus the Story #2018 (Bug 2) post-loop
 * verification — using purpose-built per-call gh-exec mocks (no live API
 * calls). Split from the former root monolith
 * `tests/providers-github.test.js` (Story #4084).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGh, createTestProvider } from './_helpers.js';

// ---------------------------------------------------------------------------
// ensureLabels — Task #1373
//
// Story #1359 (Task #1373) rewrote `ensureLabels` to iterate per def and
// shell to `gh label create`, swallowing the "already exists" stderr as
// the idempotent skip path. We assert both the argv shape per create and
// the swallow-on-exists path. The mock allows a custom `error` field so a
// route can simulate the CLI's exit-non-zero-with-stderr behaviour for
// the duplicate-name case.
// ---------------------------------------------------------------------------
describe('GitHubProvider — ensureLabels()', () => {
  // Local exec that exposes per-call control via a routes Map. Unlike
  // makeGh's createGhExec we want to differentiate per labelDef so this
  // suite carries a tiny purpose-built mock.
  function makeLabelGh(perCallResponses) {
    const calls = [];
    let i = 0;
    const exec = async ({ args }) => {
      calls.push({ args });
      const response = perCallResponses[i++] ?? { ok: true };
      if (response.error) {
        const err = new Error(response.error.message ?? 'gh-exec failure');
        err.stderr = response.error.stderr ?? '';
        throw err;
      }
      return { stdout: '', stderr: '', code: 0 };
    };
    exec.calls = calls;
    const gh = createGh(exec);
    gh.__exec = exec;
    return gh;
  }

  it('creates missing labels and skips ones that already exist', async () => {
    const gh = makeLabelGh([
      { ok: true }, // type::epic — pretend GitHub side has no rule yet
      {
        error: {
          message: 'gh-exec: gh exited with code 422',
          stderr: '! Label "type::task" already exists',
        },
      },
    ]);
    const provider = createTestProvider({ gh });
    const result = await provider.ensureLabels([
      { name: 'type::epic', color: '#7057FF', description: 'Epic' },
      { name: 'type::task', color: '#7057FF', description: 'Task' },
    ]);

    assert.deepEqual(result.created, ['type::epic']);
    assert.deepEqual(result.skipped, ['type::task']);
    // Post-loop verification was unable to read live labels (test mock
    // returns empty stdout), so the missing-reconcile is best-effort and
    // returns []. Story #2018 (Bug 2) added this envelope key.
    assert.deepEqual(result.missing, []);

    // Two `gh label create` calls plus the post-loop `gh label list`
    // verification (Story #2018, Bug 2).
    assert.equal(gh.__exec.calls.length, 3);
    assert.deepEqual(gh.__exec.calls[0].args, [
      'label',
      'create',
      'type::epic',
      '--color',
      '7057FF',
      '--description',
      'Epic',
    ]);
    assert.equal(gh.__exec.calls[1].args[2], 'type::task');
    assert.equal(gh.__exec.calls[2].args[0], 'label');
    assert.equal(gh.__exec.calls[2].args[1], 'list');
  });

  it('strips # from color code when shelling to gh label create', async () => {
    const gh = makeLabelGh([{ ok: true }]);
    const provider = createTestProvider({ gh });
    await provider.ensureLabels([
      { name: 'new-label', color: '#FF0000', description: '' },
    ]);
    const args = gh.__exec.calls[0].args;
    assert.equal(args[args.indexOf('--color') + 1], 'FF0000'); // No # prefix
  });

  it('propagates non-already-exists errors so transport faults stay loud', async () => {
    const gh = makeLabelGh([
      {
        error: {
          message: 'gh-exec: gh exited with code 401',
          stderr: 'requires authentication',
        },
      },
    ]);
    const provider = createTestProvider({ gh });
    await assert.rejects(
      provider.ensureLabels([
        { name: 'bug', color: '#D93F0B', description: '' },
      ]),
      /code 401/,
    );
  });

  // -------------------------------------------------------------------------
  // Story #2018 (Bug 2) — post-loop verification + tightened matcher.
  //
  // The fresh-repo bootstrap regression report showed `ensureLabels` reporting
  // `skipped: 23` when zero labels were actually present on the remote. Two
  // safety nets keep that from happening silently: a tightened
  // `isLabelAlreadyExistsError` regex that requires the label-create lexicon,
  // and a post-loop reconcile that lists live labels and surfaces any
  // already-counted name that isn't actually present via the `missing[]`
  // envelope. The bootstrap caller then renders a loud warning.
  // -------------------------------------------------------------------------
  describe('Story #2018 (Bug 2) — post-loop verification', () => {
    function makeReconcileGh({ createResponses, listStdout }) {
      const calls = [];
      let i = 0;
      const exec = async ({ args }) => {
        calls.push({ args });
        if (args[0] === 'label' && args[1] === 'list') {
          return { stdout: listStdout, stderr: '', code: 0 };
        }
        const response = createResponses[i++] ?? { ok: true };
        if (response.error) {
          const err = new Error(response.error.message ?? 'gh-exec failure');
          err.stderr = response.error.stderr ?? '';
          throw err;
        }
        return { stdout: '', stderr: '', code: 0 };
      };
      exec.calls = calls;
      const gh = createGh(exec);
      gh.__exec = exec;
      return gh;
    }

    it('surfaces labels missing from the live set even when create reported success', async () => {
      // Two creates return ok=true (no error thrown), so the loop tallies
      // both as `created`. But the post-loop list only shows the first —
      // the second must end up in `missing[]` and be stripped from `created`.
      const gh = makeReconcileGh({
        createResponses: [{ ok: true }, { ok: true }],
        listStdout: JSON.stringify([{ name: 'type::epic' }]),
      });
      const provider = createTestProvider({ gh });
      const result = await provider.ensureLabels([
        { name: 'type::epic', color: '#7057FF', description: 'Epic' },
        { name: 'type::task', color: '#7057FF', description: 'Task' },
      ]);
      assert.deepEqual(result.created, ['type::epic']);
      assert.deepEqual(result.skipped, []);
      assert.deepEqual(result.missing, ['type::task']);
    });

    it('surfaces labels misclassified as skipped that are not actually present', async () => {
      // Both creates fail with an already-exists shape (idempotent skip),
      // but the live label set contains only one of them. The other was
      // misclassified — `missing[]` must call it out.
      const gh = makeReconcileGh({
        createResponses: [
          {
            error: {
              message: 'gh-exec: gh exited with code 422',
              stderr: '! Label "type::epic" already exists',
            },
          },
          {
            error: {
              message: 'gh-exec: gh exited with code 422',
              stderr: '! Label "type::task" already exists',
            },
          },
        ],
        listStdout: JSON.stringify([{ name: 'type::epic' }]),
      });
      const provider = createTestProvider({ gh });
      const result = await provider.ensureLabels([
        { name: 'type::epic', color: '#7057FF', description: 'Epic' },
        { name: 'type::task', color: '#7057FF', description: 'Task' },
      ]);
      assert.deepEqual(result.skipped, ['type::epic']);
      assert.deepEqual(result.missing, ['type::task']);
    });

    it('returns empty missing[] when listing fails (best-effort verification)', async () => {
      // The verification path swallows list failures so a transient
      // post-loop probe doesn't fail an otherwise-clean bootstrap.
      const calls = [];
      let createIdx = 0;
      const exec = async ({ args }) => {
        calls.push({ args });
        if (args[0] === 'label' && args[1] === 'list') {
          const err = new Error('gh-exec: gh exited with code 500');
          err.stderr = 'transient';
          throw err;
        }
        createIdx += 1;
        return { stdout: '', stderr: '', code: 0 };
      };
      exec.calls = calls;
      const gh = createGh(exec);
      gh.__exec = exec;
      const provider = createTestProvider({ gh });
      const result = await provider.ensureLabels([
        { name: 'type::epic', color: '#7057FF', description: 'Epic' },
      ]);
      assert.deepEqual(result.created, ['type::epic']);
      assert.deepEqual(result.missing, []);
      assert.equal(createIdx, 1);
    });

    it('tightened matcher rejects stderr that mentions "already exists" outside the label lexicon', async () => {
      // A spurious stderr ("file already exists") must NOT be classified as
      // an idempotent label skip — the create should propagate as a real
      // failure rather than getting filed under `skipped` and dropped.
      const gh = makeReconcileGh({
        createResponses: [
          {
            error: {
              message: 'gh-exec: gh exited with code 500',
              stderr: 'database error: file already exists at /tmp/foo',
            },
          },
        ],
        listStdout: '[]',
      });
      const provider = createTestProvider({ gh });
      await assert.rejects(
        provider.ensureLabels([
          { name: 'type::epic', color: '#7057FF', description: 'Epic' },
        ]),
        /code 500/,
      );
    });
  });
});
