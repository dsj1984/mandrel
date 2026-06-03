/**
 * agents-bootstrap-github — GitHub-admin mutations are explicit opt-in
 * (Story #3526, Feature #3515 "consent-first install", Epic #3438).
 *
 * The consent-first install model flips GitHub-admin mutations from opt-out
 * to explicit opt-in: an install must NEVER silently reconfigure branch
 * protection or merge methods. `runBootstrap` enforces that at its own
 * boundary — unless `githubAdminApproved: true` is passed, the run is a
 * verified no-op that touches the provider zero times.
 *
 * These are unit tests: the provider is a hand-rolled mock that counts every
 * call so the suite can assert "issued zero GitHub mutations" precisely. No
 * real network, no filesystem.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runBootstrap } from '../../.agents/scripts/agents-bootstrap-github.js';
import { TARGET_MERGE_METHODS } from '../../.agents/scripts/lib/bootstrap/merge-methods.js';

const ORCHESTRATION = {
  provider: 'github',
  github: { owner: 'acme', repo: 'widgets' },
};

const PR_GATE = {
  checks: [
    { name: 'lint', cmd: ['npm', 'run', 'lint'] },
    { name: 'test', cmd: ['npm', 'test'] },
  ],
  enforceBranchProtection: true,
};

const PROJECT_BLOCK = {
  baseBranch: 'main',
  quality: { prGate: PR_GATE },
};

/**
 * Mock provider that records every method invocation. The counters are the
 * assertion surface: a no-op consent gate means every reads-or-writes count
 * stays at zero (the provider is never even instantiated, but a defensive
 * mock makes the "zero calls" guarantee explicit if that ever changes).
 *
 * `protection` seeds the live branch-protection raw payload; `mergeState`
 * seeds the live merge-method settings. Both default to a drifted state so
 * the "additive change requires approval" scenario has something to apply.
 */
function makeCountingProvider({
  protection = null,
  mergeState = { ...TARGET_MERGE_METHODS, allow_merge_commit: true },
} = {}) {
  const calls = {
    getTicket: 0,
    ensureLabels: 0,
    resolveOrCreateProject: 0,
    ensureStatusField: 0,
    ensureProjectViews: 0,
    ensureProjectFields: 0,
    getBranchProtection: 0,
    setBranchProtection: [],
    getMergeMethods: 0,
    setMergeMethods: [],
  };
  return {
    calls,
    async getTicket() {
      calls.getTicket++;
      throw new Error('404 (issue 1 not found, but API is up)');
    },
    async ensureLabels() {
      calls.ensureLabels++;
      return { created: [], skipped: [] };
    },
    async resolveOrCreateProject() {
      calls.resolveOrCreateProject++;
      return { projectNumber: null, created: false, scopesMissing: true };
    },
    async ensureStatusField() {
      calls.ensureStatusField++;
      return { status: 'skipped', added: [] };
    },
    async ensureProjectViews() {
      calls.ensureProjectViews++;
      return { created: [], skipped: [], unavailable: false };
    },
    async ensureProjectFields() {
      calls.ensureProjectFields++;
      return { created: [], skipped: [] };
    },
    async getBranchProtection() {
      calls.getBranchProtection++;
      return protection
        ? { enabled: true, raw: protection }
        : { enabled: false };
    },
    async setBranchProtection(branch, opts) {
      calls.setBranchProtection.push({ branch, opts });
      const existing = protection?.required_status_checks?.contexts ?? [];
      const merged = [...existing];
      const added = [];
      for (const c of opts.contexts) {
        if (!merged.includes(c)) {
          merged.push(c);
          added.push(c);
        }
      }
      return { created: !protection, added, existing };
    },
    async getMergeMethods() {
      calls.getMergeMethods++;
      return mergeState;
    },
    async setMergeMethods(settings) {
      calls.setMergeMethods.push(settings);
      return { patched: Object.keys(settings) };
    },
  };
}

/** Total count of every provider method the counting mock tracks. */
function totalProviderCalls(calls) {
  return (
    calls.getTicket +
    calls.ensureLabels +
    calls.resolveOrCreateProject +
    calls.ensureStatusField +
    calls.ensureProjectViews +
    calls.ensureProjectFields +
    calls.getBranchProtection +
    calls.setBranchProtection.length +
    calls.getMergeMethods +
    calls.setMergeMethods.length
  );
}

describe('agents-bootstrap-github — explicit github-admin opt-in (#3526)', () => {
  it('with no explicit approval: completes and issues zero GitHub mutations', async () => {
    const provider = makeCountingProvider();
    // No `githubAdminApproved` flag at all — the default-deny path.
    const result = await runBootstrap(ORCHESTRATION, {
      providerOverride: provider,
      project: PROJECT_BLOCK,
      quiet: true,
    });

    // The run completes (no throw) and returns the no-op envelope.
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'github-admin-not-approved');

    // ZERO provider interactions — no reads, no writes, no labels, no
    // branch-protection or merge-method changes.
    assert.equal(totalProviderCalls(provider.calls), 0);
    assert.equal(provider.calls.setBranchProtection.length, 0);
    assert.equal(provider.calls.setMergeMethods.length, 0);
    assert.equal(provider.calls.ensureLabels, 0);
  });

  it('githubAdminApproved: false is treated as not-approved (zero mutations)', async () => {
    const provider = makeCountingProvider();
    const result = await runBootstrap(ORCHESTRATION, {
      providerOverride: provider,
      project: PROJECT_BLOCK,
      quiet: true,
      githubAdminApproved: false,
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'github-admin-not-approved');
    assert.equal(totalProviderCalls(provider.calls), 0);
  });

  it('a non-true truthy value (e.g. "yes") still does NOT approve', async () => {
    const provider = makeCountingProvider();
    const result = await runBootstrap(ORCHESTRATION, {
      providerOverride: provider,
      project: PROJECT_BLOCK,
      quiet: true,
      // Strict identity: only the boolean `true` opts in. A stray truthy
      // value must not silently unlock irreversible remote mutations.
      githubAdminApproved: 'yes',
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'github-admin-not-approved');
    assert.equal(totalProviderCalls(provider.calls), 0);
  });

  it('additive branch-protection + merge-method changes require approval to land', async () => {
    // A live repo whose protection already matches the framework stance on
    // the behavior-shifting fields (enforce_admins=true, 0 approvals) but is
    // MISSING the `test` required check, and whose merge methods drift only
    // additively (merge commits still allowed). Pre-#3526 these additive
    // changes applied without any prompt; now they are part of the
    // `github-admin` group and only land when that group is approved.
    const seed = {
      protection: {
        required_status_checks: { strict: true, contexts: ['lint'] },
        enforce_admins: { enabled: true },
        required_pull_request_reviews: { required_approving_review_count: 0 },
        restrictions: null,
      },
      mergeState: { ...TARGET_MERGE_METHODS, allow_merge_commit: true },
    };

    // (1) Without approval: the additive changes do NOT apply — zero writes.
    const unapproved = makeCountingProvider(seed);
    const skippedResult = await runBootstrap(ORCHESTRATION, {
      providerOverride: unapproved,
      project: PROJECT_BLOCK,
      quiet: true,
    });
    assert.equal(skippedResult.skipped, true);
    assert.equal(unapproved.calls.setBranchProtection.length, 0);
    assert.equal(unapproved.calls.setMergeMethods.length, 0);

    // (2) With approval: the same additive changes now land. The additive
    // branch-protection merge appends the missing `test` context, and the
    // merge-method drift is patched back to the framework stance. `assumeYes`
    // clears the per-field HITL drift confirm (the merge-method drift would
    // otherwise abort on a non-TTY runner) — it is the same signal the
    // orchestrated `--assume-yes` run threads into both the phase-group
    // approval and the per-field confirm.
    const approved = makeCountingProvider(seed);
    const appliedResult = await runBootstrap(ORCHESTRATION, {
      providerOverride: approved,
      project: PROJECT_BLOCK,
      quiet: true,
      githubAdminApproved: true,
      assumeYes: true,
    });
    assert.notEqual(appliedResult.skipped, true);
    assert.equal(approved.calls.setBranchProtection.length, 1);
    assert.deepEqual(approved.calls.setBranchProtection[0].opts.contexts, [
      'lint',
      'test',
    ]);
    assert.equal(appliedResult.branchProtection.status, 'merged');
    assert.deepEqual(appliedResult.branchProtection.added, ['test']);
    assert.equal(approved.calls.setMergeMethods.length, 1);
    assert.equal(appliedResult.mergeMethods.status, 'patched');
  });
});
