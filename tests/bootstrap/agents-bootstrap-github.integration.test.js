/**
 * agents-bootstrap-github — End-to-end integration.
 *
 * Exercises `runBootstrap` against a mocked provider + a scratch
 * filesystem across four canonical scenarios:
 *
 *   (a) Fresh consumer repo            — every step applies cleanly.
 *   (b) Already in target state        — every step is a no-op.
 *   (c) Drifted, no `--assume-yes`     — HITL aborts; no writes.
 *   (d) Drifted with `--assume-yes`    — HITL auto-approves; writes land.
 *
 * No real network. The mocked provider counts every call so the test can
 * assert "did NOT PATCH" on the abort scenario.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  compareSemver,
  ensureCiWorkflow,
  MIN_GH_VERSION,
  parseGhVersion,
  preflightGh,
  runBootstrap,
} from '../../.agents/scripts/agents-bootstrap-github.js';
import {
  CI_WORKFLOW_RELATIVE_PATH,
  renderCiWorkflow,
} from '../../.agents/scripts/lib/bootstrap/ci-workflow-template.js';
import { TARGET_MERGE_METHODS } from '../../.agents/scripts/lib/bootstrap/merge-methods.js';
import {
  GhAuthError,
  GhNotInstalledError,
  GhVersionError,
} from '../../.agents/scripts/lib/errors/index.js';

const PR_GATE = {
  checks: [
    { name: 'lint', cmd: ['npm', 'run', 'lint'] },
    { name: 'test', cmd: ['npm', 'test'] },
  ],
  enforceBranchProtection: true,
};
const AGENT_SETTINGS = {
  baseBranch: 'main',
  quality: { prGate: PR_GATE },
};
const ORCHESTRATION = {
  provider: 'github',
  github: { owner: 'acme', repo: 'widgets' },
};

function makeMockProvider({
  protection = null,
  mergeState = TARGET_MERGE_METHODS,
} = {}) {
  const calls = {
    getTicket: 0,
    ensureLabels: 0,
    resolveOrCreateProject: 0,
    setBranchProtection: [],
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
      return { status: 'skipped', added: [] };
    },
    async ensureProjectViews() {
      return { created: [], skipped: [], unavailable: false };
    },
    async ensureProjectFields() {
      return { created: [], skipped: [] };
    },
    async getBranchProtection() {
      return protection
        ? { enabled: true, raw: protection }
        : { enabled: false };
    },
    async setBranchProtection(branch, opts) {
      calls.setBranchProtection.push({ branch, opts });
      const existingContexts =
        protection?.required_status_checks?.contexts ?? [];
      const merged = [...existingContexts];
      const added = [];
      for (const c of opts.contexts) {
        if (!merged.includes(c)) {
          merged.push(c);
          added.push(c);
        }
      }
      return { created: !protection, added, existing: existingContexts };
    },
    async getMergeMethods() {
      return mergeState;
    },
    async setMergeMethods(settings) {
      calls.setMergeMethods.push(settings);
      return { patched: Object.keys(settings) };
    },
  };
}

describe('agents-bootstrap-github — end-to-end integration', () => {
  it('(a) fresh repo: every step applies; HITL never consulted', async () => {
    const provider = makeMockProvider({
      protection: null,
      mergeState: { ...TARGET_MERGE_METHODS, allow_merge_commit: true },
    });
    const result = await runBootstrap(ORCHESTRATION, {
      providerOverride: provider,
      agentSettings: AGENT_SETTINGS,
      assumeYes: true,
    });
    assert.equal(result.branchProtection.status, 'created');
    assert.equal(result.mergeMethods.status, 'patched');
    assert.equal(provider.calls.setBranchProtection.length, 1);
    assert.equal(provider.calls.setMergeMethods.length, 1);
  });

  it('(b) already-in-target-state: every step is a no-op / merged (no drift)', async () => {
    const provider = makeMockProvider({
      protection: {
        required_status_checks: {
          strict: true,
          contexts: ['lint', 'test'],
        },
        enforce_admins: { enabled: true },
        required_pull_request_reviews: {
          required_approving_review_count: 0,
        },
        restrictions: null,
      },
      mergeState: { ...TARGET_MERGE_METHODS },
    });
    const result = await runBootstrap(ORCHESTRATION, {
      providerOverride: provider,
      agentSettings: AGENT_SETTINGS,
    });
    assert.equal(result.branchProtection.status, 'merged');
    assert.deepEqual(result.branchProtection.added, []);
    assert.equal(result.mergeMethods.status, 'unchanged');
    assert.equal(provider.calls.setMergeMethods.length, 0);
  });

  it('(c) drifted, no --assume-yes → HITL aborts every drifted step; no writes', async () => {
    const provider = makeMockProvider({
      protection: {
        required_status_checks: {
          strict: true,
          contexts: ['lint'],
        },
        enforce_admins: { enabled: false }, // diverges
        required_pull_request_reviews: {
          required_approving_review_count: 2, // diverges
        },
        restrictions: null,
      },
      mergeState: { ...TARGET_MERGE_METHODS, allow_merge_commit: true },
    });

    const result = await runBootstrap(ORCHESTRATION, {
      providerOverride: provider,
      agentSettings: AGENT_SETTINGS,
      hitlConfirm: async () => false,
    });

    assert.equal(result.branchProtection.status, 'skipped');
    assert.equal(result.branchProtection.reason, 'hitl-declined');
    assert.equal(result.mergeMethods.status, 'skipped');
    assert.equal(result.mergeMethods.reason, 'hitl-declined');
    assert.equal(provider.calls.setBranchProtection.length, 0);
    assert.equal(provider.calls.setMergeMethods.length, 0);
  });

  it('(d) drifted with --assume-yes → every step applies', async () => {
    /* placeholder */
  });
});

describe('agents-bootstrap-github — CI workflow template (Story #1401)', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-ci-'));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('renders the workflow without redundant --changed-since args on per-PR jobs', () => {
    const yaml = renderCiWorkflow();
    // The PR-path Maintainability and CRAP invocations must NOT carry an
    // explicit --changed-since (the gate CLIs default to it now). They MAY
    // pass --epic-ref instead.
    const lines = yaml.split('\n');
    const prMaintLines = lines.filter((l) =>
      l.includes('npm run maintainability:check'),
    );
    const prCrapLines = lines.filter((l) => l.includes('npm run crap:check'));
    assert.ok(prMaintLines.length > 0, 'maintainability:check must appear');
    assert.ok(prCrapLines.length > 0, 'crap:check must appear');
    // Only the push-to-main legs should pass --full-scope; nothing should
    // pass --changed-since explicitly.
    for (const line of [...prMaintLines, ...prCrapLines]) {
      assert.ok(
        !line.includes('--changed-since'),
        `redundant --changed-since on: ${line.trim()}`,
      );
    }
    // --full-scope only on the push-to-main legs (count only real invocation
    // lines, not the comment lines that explain the design).
    const fullScopeInvocations = lines.filter(
      (l) =>
        l.includes('--full-scope') &&
        (l.includes('npm run maintainability:check') ||
          l.includes('npm run crap:check')),
    );
    assert.equal(
      fullScopeInvocations.length,
      2,
      'expected exactly two --full-scope invocations (MI + CRAP push-to-main)',
    );
  });

  it('threads --epic-ref through both gates when EPIC_REF is set', () => {
    const yaml = renderCiWorkflow();
    assert.ok(yaml.includes('EPIC_REF:'));
    assert.ok(yaml.includes('--epic-ref "$' + '{EPIC_REF}"'));
    // Both gates must accept --epic-ref — count occurrences.
    const epicRefMatches = yaml.match(/--epic-ref "\$\{EPIC_REF\}"/g) ?? [];
    assert.equal(
      epicRefMatches.length,
      2,
      'expected --epic-ref on both maintainability and crap PR legs',
    );
  });

  it('writes the workflow to .github/workflows/ci.yml and is idempotent', () => {
    const projectRoot = tmpRoot;
    const target = path.join(projectRoot, CI_WORKFLOW_RELATIVE_PATH);

    // First run: file absent → created.
    const first = ensureCiWorkflow({ projectRoot });
    assert.equal(first.action, 'created');
    assert.equal(first.path, target);
    assert.ok(fs.existsSync(target));

    // Second run: byte-identical → unchanged.
    const second = ensureCiWorkflow({ projectRoot });
    assert.equal(second.action, 'unchanged');
  });

  it('preserves an operator-edited workflow as custom-workflow-skip', () => {
    const projectRoot = tmpRoot;
    const target = path.join(projectRoot, CI_WORKFLOW_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '# operator-authored workflow\n', 'utf8');
    const result = ensureCiWorkflow({ projectRoot });
    assert.equal(result.action, 'custom-workflow-skip');
    // The hand-edited workflow is left exactly as the operator wrote it.
    assert.equal(
      fs.readFileSync(target, 'utf8'),
      '# operator-authored workflow\n',
    );
    // And the rendered template is returned so the caller can offer a diff.
    assert.ok(result.rendered.includes('jobs:'));
  });
});

describe('agents-bootstrap-github — gh preflight (Story #1362 / Task #1378)', () => {
  // The runner seam returns the canonical
  //   { status, stdout, stderr, error? }
  // shape that `defaultGhRunner` emits, so the preflight reads from a stub
  // without spawning a real `gh`. Each test composes a per-call script so
  // version vs. auth responses can diverge cleanly.
  function makeRunner(responses) {
    const seen = [];
    const runner = (args) => {
      seen.push(args);
      const handler = responses[seen.length - 1];
      if (!handler) {
        throw new Error(
          `unexpected gh call #${seen.length}: ${JSON.stringify(args)}`,
        );
      }
      return handler(args);
    };
    runner.seen = seen;
    return runner;
  }

  it('parseGhVersion extracts MAJOR.MINOR.PATCH from real gh output', () => {
    const sample =
      'gh version 2.55.0 (2024-08-21)\nhttps://github.com/cli/cli/releases/tag/v2.55.0\n';
    assert.equal(parseGhVersion(sample), '2.55.0');
    assert.equal(parseGhVersion('garbage'), null);
    assert.equal(parseGhVersion(''), null);
  });

  it('compareSemver orders versions numerically (not lexically)', () => {
    assert.ok(compareSemver('2.10.0', '2.9.9') > 0);
    assert.ok(compareSemver('2.40.0', '2.40.0') === 0);
    assert.ok(compareSemver('2.39.5', MIN_GH_VERSION) < 0);
    assert.ok(compareSemver('2.40.0', MIN_GH_VERSION) === 0);
    assert.ok(compareSemver('3.0.0', MIN_GH_VERSION) > 0);
  });

  it('throws GhNotInstalledError when gh is missing (ENOENT)', async () => {
    const enoent = Object.assign(new Error('spawn gh ENOENT'), {
      code: 'ENOENT',
    });
    const runner = makeRunner([
      () => ({ status: null, stdout: '', stderr: '', error: enoent }),
    ]);
    await assert.rejects(
      () => preflightGh({ runner }),
      (err) =>
        err instanceof GhNotInstalledError && /not found/i.test(err.message),
    );
    // The auth step must NOT be reached when the version step already
    // discovered gh is missing.
    assert.equal(runner.seen.length, 1);
  });

  it('throws GhAuthError when gh is installed but unauthenticated', async () => {
    const runner = makeRunner([
      () => ({
        status: 0,
        stdout: 'gh version 2.55.0 (2024-08-21)\n',
        stderr: '',
      }),
      () => ({
        status: 1,
        stdout: '',
        stderr:
          'You are not logged into any GitHub hosts. Run gh auth login.\n',
      }),
    ]);
    await assert.rejects(
      () => preflightGh({ runner }),
      (err) => err instanceof GhAuthError && /gh auth login/i.test(err.message),
    );
    assert.equal(runner.seen.length, 2);
    assert.deepEqual(runner.seen[1], ['auth', 'status']);
  });

  it('throws GhVersionError when gh is older than the minimum', async () => {
    const runner = makeRunner([
      () => ({
        status: 0,
        stdout: 'gh version 2.10.0 (2022-01-01)\n',
        stderr: '',
      }),
    ]);
    await assert.rejects(
      () => preflightGh({ runner }),
      (err) =>
        err instanceof GhVersionError &&
        err.found === '2.10.0' &&
        err.required === MIN_GH_VERSION &&
        /older than required/i.test(err.message),
    );
    // Auth step must be skipped when the version is unacceptable — no
    // point asking a half-broken CLI to introspect its auth.
    assert.equal(runner.seen.length, 1);
  });

  it('returns { version } when gh is installed, ≥ minimum, and authenticated', async () => {
    const runner = makeRunner([
      () => ({
        status: 0,
        stdout: 'gh version 2.55.0 (2024-08-21)\n',
        stderr: '',
      }),
      () => ({
        status: 0,
        stdout:
          'github.com\n  ✓ Logged in to github.com as someone (oauth_token)\n',
        stderr: '',
      }),
    ]);
    const result = await preflightGh({ runner });
    assert.deepEqual(result, { version: '2.55.0' });
    assert.equal(runner.seen.length, 2);
  });

  it('treats `gh --version` non-zero exit as GhNotInstalledError', async () => {
    const runner = makeRunner([
      () => ({
        status: 127,
        stdout: '',
        stderr: 'gh: command not found\n',
      }),
    ]);
    await assert.rejects(
      () => preflightGh({ runner }),
      (err) => err instanceof GhNotInstalledError,
    );
  });
});

describe('agents-bootstrap-github — drifted-yes scenario (legacy)', () => {
  it('(d) drifted with --assume-yes → every step applies', async () => {
    const provider = makeMockProvider({
      protection: {
        required_status_checks: {
          strict: true,
          contexts: ['lint'],
        },
        enforce_admins: { enabled: false },
        required_pull_request_reviews: {
          required_approving_review_count: 2,
        },
        restrictions: null,
      },
      mergeState: { ...TARGET_MERGE_METHODS, allow_merge_commit: true },
    });

    const result = await runBootstrap(ORCHESTRATION, {
      providerOverride: provider,
      agentSettings: AGENT_SETTINGS,
      assumeYes: true,
    });

    assert.equal(result.branchProtection.status, 'merged');
    assert.equal(result.mergeMethods.status, 'patched');
    assert.equal(provider.calls.setBranchProtection.length, 1);
    assert.equal(provider.calls.setMergeMethods.length, 1);
  });
});
