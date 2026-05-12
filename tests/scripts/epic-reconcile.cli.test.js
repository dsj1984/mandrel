/**
 * tests/scripts/epic-reconcile.cli.test.js — contract tests for the
 * epic-reconcile.js CLI surface (Story #1496 / Task #1523).
 *
 * Pins the CLI's flag-combination behaviour, exit-code contract, and
 * argument-parsing rules against the AC in Story #1496:
 *
 *   - Default (no flags) runs the diff and prints the plan without
 *     mutating (dry-run default).
 *   - `--apply` without `--yes` in a non-TTY context aborts with exit 1.
 *   - `--apply --explicit-delete --yes` proceeds without prompting.
 *   - Exit 0 on a clean apply or empty diff.
 *   - Exit 1 on schema validation failure (message names the JSON path).
 *   - Exit 2 on a Close operation that requires `--explicit-delete`.
 *
 * The CLI exposes `runReconcile(args, deps)` and `parseCli(argv)`
 * specifically so these contract tests can drive it without touching
 * the network, the file system, or a real TTY. Every external
 * collaborator is injected: loaders, provider, diff/apply, formatter,
 * confirm prompt, log sinks. The harness style mirrors the existing
 * `dispatcher-fromspec.test.js` suite — `node:test` describe/it blocks
 * with strict assertions on the returned envelope.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EXIT_CODES,
  parseCli,
  planHasCloses,
  renderExplicitDeleteMessage,
  runReconcile,
} from '../../.agents/scripts/epic-reconcile.js';
import {
  closeOp,
  createOp,
  emptyPlan,
} from '../../.agents/scripts/lib/orchestration/epic-spec-reconciler-ops.js';
import { SpecValidationError } from '../../.agents/scripts/lib/spec/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a deps bag for `runReconcile` with deterministic stubs. Every
 * collaborator is overridable so each test installs exactly what it needs.
 */
function buildDeps(overrides = {}) {
  const stdout = [];
  const stderr = [];
  const calls = {
    apply: 0,
    diff: 0,
    fetchGhState: 0,
    formatPlan: 0,
    confirm: 0,
  };
  const deps = {
    provider: {
      // Test-only stub provider — passes the truthiness check; fetchGhState
      // is itself stubbed so no provider methods get called.
      __stub: true,
    },
    loadSpec: () => ({
      epic: { id: 1000, title: 'Test Epic' },
      features: [],
    }),
    loadState: () => ({ epicId: 1000, mapping: {} }),
    fetchGhState: () => {
      calls.fetchGhState += 1;
      return Promise.resolve({});
    },
    diff: () => {
      calls.diff += 1;
      return emptyPlan();
    },
    formatPlan: (plan) => {
      calls.formatPlan += 1;
      return `[formatted plan: ${plan.creates.length}C ${plan.updates.length}U ${plan.closes.length}X ${plan.relinks.length}R]`;
    },
    apply: () => {
      calls.apply += 1;
      return Promise.resolve({
        dryRun: false,
        created: [],
        updated: [],
        closed: [],
        relinked: [],
        slugToIssue: {},
      });
    },
    confirm: () => {
      calls.confirm += 1;
      return Promise.resolve(true);
    },
    isTty: () => true,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    ...overrides,
  };
  return { deps, stdout, stderr, calls };
}

function args(partial = {}) {
  return {
    epicId: 1000,
    dryRun: true,
    apply: false,
    explicitDelete: false,
    yes: false,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// EXIT_CODES constant pinning
// ---------------------------------------------------------------------------

describe('epic-reconcile CLI — exit-code constants', () => {
  it('pins exit codes to 0 / 1 / 2', () => {
    assert.equal(EXIT_CODES.OK, 0);
    assert.equal(EXIT_CODES.VALIDATION_ERROR, 1);
    assert.equal(EXIT_CODES.EXPLICIT_DELETE_REQUIRED, 2);
  });
});

// ---------------------------------------------------------------------------
// parseCli — flag-matrix coverage
// ---------------------------------------------------------------------------

describe('parseCli — flag-matrix', () => {
  it('default (no flags) → dryRun=true, apply=false', () => {
    const parsed = parseCli(['1182']);
    assert.equal(parsed.epicId, 1182);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.apply, false);
    assert.equal(parsed.explicitDelete, false);
    assert.equal(parsed.yes, false);
  });

  it('--dry-run explicit → dryRun=true', () => {
    const parsed = parseCli(['1182', '--dry-run']);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.apply, false);
  });

  it('--apply → apply=true, dryRun=false', () => {
    const parsed = parseCli(['1182', '--apply']);
    assert.equal(parsed.apply, true);
    assert.equal(parsed.dryRun, false);
  });

  it('--apply --yes → carries --yes', () => {
    const parsed = parseCli(['1182', '--apply', '--yes']);
    assert.equal(parsed.apply, true);
    assert.equal(parsed.yes, true);
  });

  it('--apply --explicit-delete --yes → all three set', () => {
    const parsed = parseCli(['1182', '--apply', '--explicit-delete', '--yes']);
    assert.equal(parsed.apply, true);
    assert.equal(parsed.explicitDelete, true);
    assert.equal(parsed.yes, true);
  });

  it('--dry-run --apply (both) → dry-run wins (safety)', () => {
    const parsed = parseCli(['1182', '--apply', '--dry-run']);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.apply, false);
  });

  it('non-numeric positional → epicId=null', () => {
    const parsed = parseCli(['not-a-number']);
    assert.equal(parsed.epicId, null);
  });

  it('missing positional → epicId=null', () => {
    const parsed = parseCli([]);
    assert.equal(parsed.epicId, null);
  });
});

// ---------------------------------------------------------------------------
// Default dry-run path (AC: "no flags runs the diff and prints the plan")
// ---------------------------------------------------------------------------

describe('runReconcile — default dry-run path', () => {
  it('renders the plan and exits 0 without applying', async () => {
    const { deps, stdout, calls } = buildDeps();
    const result = await runReconcile(args({ dryRun: true }), deps);
    assert.equal(result.exitCode, EXIT_CODES.OK);
    assert.equal(calls.diff, 1);
    assert.equal(calls.formatPlan, 1);
    assert.equal(calls.apply, 0);
    assert.ok(
      stdout.some((line) => line.includes('[formatted plan:')),
      'stdout should carry the formatted plan',
    );
  });

  it('dry-run with non-empty plan does not gate on --explicit-delete', async () => {
    const { deps, calls } = buildDeps({
      diff: () => ({
        ...emptyPlan(),
        closes: [
          closeOp({
            slug: 'orphan',
            entity: 'story',
            issueNumber: 5555,
          }),
        ],
      }),
    });
    const result = await runReconcile(args({ dryRun: true }), deps);
    // Dry-run path is read-only — closes in the plan are rendered, not
    // gated. Exit code must stay 0.
    assert.equal(result.exitCode, EXIT_CODES.OK);
    assert.equal(calls.apply, 0);
  });
});

// ---------------------------------------------------------------------------
// --apply gating behaviour (TTY / --yes / explicit-delete)
// ---------------------------------------------------------------------------

describe('runReconcile — apply gates', () => {
  it('empty plan + --apply → exit 0 without prompting or applying', async () => {
    const { deps, calls } = buildDeps();
    const result = await runReconcile(
      args({ dryRun: false, apply: true }),
      deps,
    );
    assert.equal(result.exitCode, EXIT_CODES.OK);
    assert.equal(calls.confirm, 0);
    assert.equal(calls.apply, 0);
  });

  it('non-empty plan + --apply in non-TTY without --yes → exit 1', async () => {
    const { deps, stderr, calls } = buildDeps({
      isTty: () => false,
      diff: () => ({
        ...emptyPlan(),
        creates: [
          createOp({
            slug: 'feature-a',
            entity: 'feature',
            title: 'Feature A',
          }),
        ],
      }),
    });
    const result = await runReconcile(
      args({ dryRun: false, apply: true }),
      deps,
    );
    assert.equal(result.exitCode, EXIT_CODES.VALIDATION_ERROR);
    assert.equal(calls.apply, 0);
    assert.ok(
      stderr.some((line) => line.includes('--yes')),
      'stderr should mention --yes requirement',
    );
  });

  it('non-empty plan + --apply --yes → bypasses prompt and applies', async () => {
    const { deps, calls } = buildDeps({
      diff: () => ({
        ...emptyPlan(),
        creates: [
          createOp({
            slug: 'feature-a',
            entity: 'feature',
            title: 'Feature A',
          }),
        ],
      }),
    });
    const result = await runReconcile(
      args({ dryRun: false, apply: true, yes: true }),
      deps,
    );
    assert.equal(result.exitCode, EXIT_CODES.OK);
    assert.equal(calls.confirm, 0, '--yes must suppress the prompt');
    assert.equal(calls.apply, 1);
  });

  it('non-empty plan + --apply in TTY without --yes → prompts; "no" aborts cleanly', async () => {
    const { deps, calls } = buildDeps({
      isTty: () => true,
      confirm: () => {
        return Promise.resolve(false);
      },
      diff: () => ({
        ...emptyPlan(),
        creates: [
          createOp({
            slug: 'feature-a',
            entity: 'feature',
            title: 'Feature A',
          }),
        ],
      }),
    });
    const result = await runReconcile(
      args({ dryRun: false, apply: true }),
      deps,
    );
    assert.equal(result.exitCode, EXIT_CODES.OK);
    assert.equal(calls.apply, 0, '"no" answer must skip apply');
  });

  it('apply --yes --explicit-delete proceeds without prompting through close ops', async () => {
    const { deps, calls } = buildDeps({
      diff: () => ({
        ...emptyPlan(),
        closes: [
          closeOp({
            slug: 'orphan',
            entity: 'story',
            issueNumber: 5555,
          }),
        ],
      }),
    });
    const result = await runReconcile(
      args({
        dryRun: false,
        apply: true,
        yes: true,
        explicitDelete: true,
      }),
      deps,
    );
    assert.equal(result.exitCode, EXIT_CODES.OK);
    assert.equal(calls.confirm, 0);
    assert.equal(calls.apply, 1);
  });
});

// ---------------------------------------------------------------------------
// Exit-code contract (Task #1521)
// ---------------------------------------------------------------------------

describe('exit-code contract — 0 / 1 / 2', () => {
  it('exit 0 — clean apply (no diff)', async () => {
    const { deps } = buildDeps();
    const result = await runReconcile(
      args({ dryRun: false, apply: true }),
      deps,
    );
    assert.equal(result.exitCode, EXIT_CODES.OK);
  });

  it('exit 0 — successful apply with --yes on a creates-only plan', async () => {
    const { deps } = buildDeps({
      diff: () => ({
        ...emptyPlan(),
        creates: [
          createOp({
            slug: 'feature-a',
            entity: 'feature',
            title: 'Feature A',
          }),
        ],
      }),
    });
    const result = await runReconcile(
      args({ dryRun: false, apply: true, yes: true }),
      deps,
    );
    assert.equal(result.exitCode, EXIT_CODES.OK);
  });

  it('exit 1 — SpecValidationError; stderr names the JSON path', async () => {
    const { deps, stderr } = buildDeps({
      loadSpec: () => {
        throw new SpecValidationError('1000', [
          { path: '/epic/id', message: 'must be integer' },
        ]);
      },
    });
    const result = await runReconcile(args(), deps);
    assert.equal(result.exitCode, EXIT_CODES.VALIDATION_ERROR);
    assert.ok(
      stderr.some((line) => line.includes('/epic/id')),
      'stderr should name the failing JSON Pointer path',
    );
    assert.ok(
      stderr.some((line) => line.includes('must be integer')),
      'stderr should carry the schema-validation message',
    );
  });

  it('exit 1 — missing epic id positional', async () => {
    const { deps, stderr } = buildDeps();
    const result = await runReconcile(args({ epicId: null }), deps);
    assert.equal(result.exitCode, EXIT_CODES.VALIDATION_ERROR);
    assert.ok(
      stderr.some((line) => line.toLowerCase().includes('epic id')),
      'stderr should explain the missing epic id',
    );
  });

  it('exit 2 — Close requires --explicit-delete; flag absent', async () => {
    const { deps, stderr, calls } = buildDeps({
      diff: () => ({
        ...emptyPlan(),
        closes: [
          closeOp({
            slug: 'orphan',
            entity: 'story',
            issueNumber: 5555,
          }),
        ],
      }),
    });
    const result = await runReconcile(
      args({ dryRun: false, apply: true, yes: true }),
      deps,
    );
    assert.equal(result.exitCode, EXIT_CODES.EXPLICIT_DELETE_REQUIRED);
    assert.equal(calls.apply, 0, 'apply must not run when exit-2 fires');
    assert.ok(
      stderr.some((line) => line.includes('--explicit-delete')),
      'stderr should mention --explicit-delete on the exit-2 path',
    );
  });

  it('exit 2 — close gate fires even when --yes is set', async () => {
    const { deps, calls } = buildDeps({
      diff: () => ({
        ...emptyPlan(),
        closes: [
          closeOp({
            slug: 'orphan',
            entity: 'story',
            issueNumber: 5555,
          }),
        ],
      }),
    });
    const result = await runReconcile(
      args({ dryRun: false, apply: true, yes: true }),
      deps,
    );
    assert.equal(result.exitCode, EXIT_CODES.EXPLICIT_DELETE_REQUIRED);
    assert.equal(calls.apply, 0);
  });
});

// ---------------------------------------------------------------------------
// Helper predicates / renderers
// ---------------------------------------------------------------------------

describe('helper predicates', () => {
  it('planHasCloses true when plan.closes.length > 0', () => {
    assert.equal(
      planHasCloses({
        ...emptyPlan(),
        closes: [closeOp({ slug: 'a', entity: 'story', issueNumber: 1 })],
      }),
      true,
    );
  });

  it('planHasCloses false on empty plan', () => {
    assert.equal(planHasCloses(emptyPlan()), false);
  });

  it('planHasCloses false on undefined / non-object', () => {
    assert.equal(planHasCloses(undefined), false);
    assert.equal(planHasCloses(null), false);
    assert.equal(planHasCloses(42), false);
  });

  it('renderExplicitDeleteMessage names every close-op slug', () => {
    const plan = {
      ...emptyPlan(),
      closes: [
        closeOp({ slug: 'orphan-a', entity: 'story', issueNumber: 10 }),
        closeOp({ slug: 'orphan-b', entity: 'story', issueNumber: 11 }),
      ],
    };
    const msg = renderExplicitDeleteMessage(plan);
    assert.match(msg, /#10 \(orphan-a\)/);
    assert.match(msg, /#11 \(orphan-b\)/);
    assert.match(msg, /--explicit-delete/);
    assert.match(msg, /2 close operation/);
  });
});
