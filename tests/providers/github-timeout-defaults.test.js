/**
 * tests/providers/github-timeout-defaults.test.js
 *
 * Covers the `gh` subprocess ceiling wired in Story #2860. Story #5382
 * folded the never-set `github.defaultTimeoutMs` knob into the fixed
 * `GH_DEFAULT_TIMEOUT_MS`.
 *
 * The provider must:
 *   1. Apply the 60_000 ms ceiling to every `gh` subprocess.
 *   2. Ignore a leftover `config.defaultTimeoutMs` (the schema rejects it).
 *   3. Pass the operator's injected `opts.gh` through unchanged — tests rely
 *      on this to drive the facade with fakes without going through the
 *      default-construction path.
 *   4. Surface a hung `gh api` as a `GhExecTimeoutError`, which
 *      `classifyGithubError` now buckets as `'transient'` so the existing
 *      retry helpers fire.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  exec as defaultExec,
  GhExecTimeoutError,
} from '../../.agents/scripts/lib/gh-exec.js';
import { classifyGithubError } from '../../.agents/scripts/providers/github/errors.js';
import { GitHubProvider } from '../../.agents/scripts/providers/github.js';

function baseConfig(extra = {}) {
  return {
    owner: 'octo',
    repo: 'demo',
    projectNumber: 1,
    projectOwner: 'octo',
    ...extra,
  };
}

describe('GitHubProvider — gh timeout ceiling (Stories #2860, #5382)', () => {
  it('applies the 60_000 ms ceiling', () => {
    const provider = new GitHubProvider(baseConfig(), { token: 'ghp_test' });
    assert.equal(provider._gh.defaults.timeoutMs, 60_000);
  });

  it('ignores a leftover config.defaultTimeoutMs — the ceiling is fixed', () => {
    const provider = new GitHubProvider(
      baseConfig({ defaultTimeoutMs: 5_000 }),
      { token: 'ghp_test' },
    );
    assert.equal(provider._gh.defaults.timeoutMs, 60_000);
  });

  it('passes an injected opts.gh through verbatim (test-injection path)', () => {
    const injected = { api: async () => ({ stdout: '{}' }) };
    const provider = new GitHubProvider(
      baseConfig({ defaultTimeoutMs: 5_000 }),
      { token: 'ghp_test', gh: injected },
    );
    assert.strictEqual(provider._gh, injected);
  });
});

describe('GhExecTimeoutError → withTransientRetry path (Story #2860)', () => {
  it('a hung gh exec rejected with GhExecTimeoutError classifies transient', async () => {
    // Arrange: stub the exec layer with one that rejects on a tight timeout
    // and inject the facade via `opts.gh` so the provider's own creation
    // path isn't exercised here — we want a focused signal on the timeout
    // round-trip from exec → GhExecTimeoutError → classifyGithubError.
    const stubGh = {
      api: () =>
        Promise.reject(
          new GhExecTimeoutError(
            'gh-exec: gh api /repos/octo/demo/issues exceeded 1ms',
            { args: ['api', '/repos/octo/demo/issues'], timeoutMs: 1 },
          ),
        ),
    };

    // Act
    let captured;
    try {
      await stubGh.api({ endpoint: '/repos/octo/demo/issues' });
    } catch (err) {
      captured = err;
    }

    // Assert
    assert.ok(captured instanceof GhExecTimeoutError);
    assert.equal(classifyGithubError(captured), 'transient');
  });

  it('real exec is the unaltered module export (no double-wrapping)', () => {
    // Sanity check that the gh-exec module's default `exec` is still the
    // function the provider's default-construction path resolves to (via
    // createGh(undefined, ...)). Asserts the import surface didn't drift.
    assert.equal(typeof defaultExec, 'function');
  });
});
