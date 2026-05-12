/**
 * agents-bootstrap-github — Branch Protection Step (Epic #1142 Story #1157)
 *
 * Covers the new `ensureMainBranchProtection` step in the bootstrap
 * pipeline:
 *
 *   1. Create-from-scratch — no existing protection rule on `main`. The
 *      step writes one carrying `prGate.checks` names plus minimal
 *      defaults.
 *   2. Additive merge — an existing protection rule with operator-supplied
 *      contexts. The step preserves every existing context and appends
 *      only the missing prGate names.
 *   3. Opt-out — `enforceBranchProtection: false` skips the step entirely.
 *   4. No-checks — `prGate.checks` empty/absent skips the step (nothing
 *      to enforce).
 *   5. Failure — provider rejects the write. The step logs and returns
 *      a `{ status: 'failed' }` summary; the rest of the bootstrap is
 *      not aborted (verified by inspecting the returned shape).
 *
 * Tests use a stub provider (no GitHub API calls). The runtime AJV
 * schema is exercised via the existing config-settings-schema and
 * config-schema-mirror-drift suites — this file focuses on behaviour.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const { ensureMainBranchProtection } = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'agents-bootstrap-github.js'),
  ).href
);

/** Minimal provider stub — only the two methods the step touches. */
function makeStubProvider({ existing = null, throws = null } = {}) {
  const calls = { setBranchProtection: [] };
  return {
    calls,
    async setBranchProtection(branch, opts) {
      calls.setBranchProtection.push({ branch, opts });
      if (throws) throw throws;
      const existingContexts = existing?.required_status_checks?.contexts ?? [];
      const merged = [...existingContexts];
      const added = [];
      for (const c of opts.contexts) {
        if (!merged.includes(c)) {
          merged.push(c);
          added.push(c);
        }
      }
      return {
        created: existing == null,
        added,
        existing: existingContexts,
      };
    },
  };
}

const SAMPLE_PR_GATE = {
  checks: [
    { name: 'lint', cmd: ['npm', 'run', 'lint'] },
    { name: 'format:check', cmd: ['npm', 'run', 'format:check'] },
    { name: 'test', cmd: ['npm', 'test'] },
  ],
  enforceBranchProtection: true,
};

describe('agents-bootstrap-github — ensureMainBranchProtection', () => {
  it('create-from-scratch: writes a fresh rule with prGate.checks contexts', async () => {
    const log = [];
    const provider = makeStubProvider({ existing: null });
    const result = await ensureMainBranchProtection(
      provider,
      { baseBranch: 'main', prGate: SAMPLE_PR_GATE },
      (m) => log.push(m),
    );
    assert.equal(result.status, 'created');
    assert.deepEqual(result.added, ['lint', 'format:check', 'test']);
    assert.deepEqual(result.existing, []);
    assert.equal(provider.calls.setBranchProtection.length, 1);
    const call = provider.calls.setBranchProtection[0];
    assert.equal(call.branch, 'main');
    assert.deepEqual(call.opts.contexts, ['lint', 'format:check', 'test']);
  });

  it('additive merge: preserves existing operator contexts and appends only missing prGate names', async () => {
    const log = [];
    const provider = makeStubProvider({
      existing: {
        required_status_checks: {
          strict: true,
          contexts: ['lint', 'security/scan', 'license/check'],
        },
      },
    });
    const result = await ensureMainBranchProtection(
      provider,
      { baseBranch: 'main', prGate: SAMPLE_PR_GATE },
      (m) => log.push(m),
    );
    assert.equal(result.status, 'merged');
    // `lint` was already present → not in `added`. `security/scan` and
    // `license/check` were operator-set → preserved in `existing`.
    assert.deepEqual(result.added, ['format:check', 'test']);
    assert.deepEqual(result.existing, [
      'lint',
      'security/scan',
      'license/check',
    ]);
  });

  it('opt-out: enforceBranchProtection=false skips the call entirely', async () => {
    const log = [];
    const provider = makeStubProvider({ existing: null });
    const result = await ensureMainBranchProtection(
      provider,
      {
        baseBranch: 'main',
        prGate: { ...SAMPLE_PR_GATE, enforceBranchProtection: false },
      },
      (m) => log.push(m),
    );
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'opt-out');
    assert.equal(provider.calls.setBranchProtection.length, 0);
    assert.ok(log.some((m) => m.includes('skipped')));
  });

  it('no-checks: empty prGate.checks skips with a clear reason', async () => {
    const log = [];
    const provider = makeStubProvider({ existing: null });
    const result = await ensureMainBranchProtection(
      provider,
      { baseBranch: 'main', prGate: { checks: [] } },
      (m) => log.push(m),
    );
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'no-checks');
    assert.equal(provider.calls.setBranchProtection.length, 0);
  });

  it('absent prGate block: skipped (no-checks)', async () => {
    const log = [];
    const provider = makeStubProvider({ existing: null });
    const result = await ensureMainBranchProtection(
      provider,
      { baseBranch: 'main', prGate: null },
      (m) => log.push(m),
    );
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'no-checks');
  });

  it('failure: provider error returns failed summary without throwing', async () => {
    const log = [];
    const provider = makeStubProvider({
      throws: new Error('403 Forbidden — token missing admin:repo_hook'),
    });
    const result = await ensureMainBranchProtection(
      provider,
      { baseBranch: 'main', prGate: SAMPLE_PR_GATE },
      (m) => log.push(m),
    );
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /403 Forbidden/);
    assert.ok(log.some((m) => m.includes('failed')));
  });

  it('honours a non-default base branch', async () => {
    const log = [];
    const provider = makeStubProvider({ existing: null });
    await ensureMainBranchProtection(
      provider,
      { baseBranch: 'trunk', prGate: SAMPLE_PR_GATE },
      (m) => log.push(m),
    );
    assert.equal(provider.calls.setBranchProtection[0].branch, 'trunk');
  });
});

// Provider-layer behaviour test: the additive merge math used to live in
// `providers/github/branches.setBranchProtection`. After Epic #1179 / Story
// #1363 the algorithm moved onto `GitHubProvider.setBranchProtection`
// (gh-exec-backed) and is exercised directly by
// `tests/providers-github.test.js` under the `setBranchProtection()`
// describe — see the "additively merges contexts when a rule already
// exists" / "preserves operator overrides" cases. The orchestrator-wiring
// tests above remain the responsibility of this file.
