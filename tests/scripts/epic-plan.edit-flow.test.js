/**
 * tests/scripts/epic-plan.edit-flow.test.js — Story #1499 / Task #1531.
 *
 * Locks in the Phase 2.5 edit-in-place flow for `/epic-plan`:
 *
 *   (a) Spec absent  → author path runs (`runSpec` + `runDecompose`).
 *   (b) Spec present + non-empty diff → dry-run is rendered, the apply
 *       gate requires explicit operator confirmation, and a declining
 *       operator returns `applied: false`.
 *   (c) Spec present + empty diff → short-circuit to a no-changes
 *       message; the operator is never prompted.
 *   (d) Spec present + non-empty diff + operator confirms → `apply` is
 *       invoked with `yes: true` so the embedded reconciler does not
 *       double-prompt.
 *
 * All tests run end-to-end through `runSprintPlan` and `runEditFlow`
 * with stub providers + injected `reconcileFn`/`confirm`/`isTty` seams.
 * No child processes, no live GH calls.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  detectExistingSpec,
  runEditFlow,
  runSprintPlan,
} from '../../.agents/scripts/epic-plan.js';

const EPIC_ID = 9988;

let sandbox;
let epicsDir;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'epic-plan-edit-flow-'));
  epicsDir = path.join(sandbox, '.agents', 'epics');
  mkdirSync(epicsDir, { recursive: true });
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Minimal stub provider — only `getEpic` is exercised through the
 * spec-presence test paths (the edit flow's reconciler collaborator is
 * stubbed wholesale, so most of the surface is unused here).
 */
function buildStubProvider() {
  return {
    async getEpic(id) {
      return {
        id,
        title: 'Edit-flow Test Epic',
        body: '',
        labels: ['type::epic'],
        state: 'open',
        linkedIssues: { prd: null, techSpec: null },
      };
    },
  };
}

/**
 * Build a custom `detectSpec` that points at the sandbox epicsDir
 * instead of the project's default `.agents/epics/`. Lets the tests
 * stage / unstage the on-disk spec without touching the real tree.
 */
function detectSpecAt(epicsDirOverride) {
  return (epicId) => detectExistingSpec(epicId, { epicsDir: epicsDirOverride });
}

describe('epic-plan edit-flow integration (Story #1499)', () => {
  it('(a) spec absent — author path runs (runSpec + runDecompose)', async () => {
    const calls = { runSpec: 0, runDecompose: 0, runEdit: 0 };
    const result = await runSprintPlan({
      epicId: EPIC_ID,
      provider: buildStubProvider(),
      settings: {},
      config: {},
      artifacts: {
        prdContent: '## PRD',
        techSpecContent: '## Tech Spec',
        tickets: [],
      },
      runSpec: async () => {
        calls.runSpec += 1;
        return { epicId: EPIC_ID, prdId: 1, techSpecId: 2 };
      },
      runDecompose: async () => {
        calls.runDecompose += 1;
        return { epicId: EPIC_ID, persisted: 0 };
      },
      runEdit: async () => {
        calls.runEdit += 1;
        return { mode: 'edit', applied: false };
      },
      detectSpec: detectSpecAt(epicsDir),
    });

    assert.equal(calls.runSpec, 1, 'author path runs runSpec');
    assert.equal(calls.runDecompose, 1, 'author path runs runDecompose');
    assert.equal(calls.runEdit, 0, 'edit flow is not invoked when spec absent');
    assert.equal(result.mode, 'author');
    assert.ok(result.spec, 'spec envelope returned');
    assert.ok(result.decompose, 'decompose envelope returned');
  });

  it('(b) spec present + non-empty diff — dry-run shown, HITL gate triggers', async () => {
    // Stage a spec file so detectExistingSpec routes through the edit
    // flow. The contents are irrelevant — the test stubs the reconciler.
    writeFileSync(
      path.join(epicsDir, `${EPIC_ID}.yaml`),
      'epic:\n  id: 9988\n  title: stub\n',
      { flag: 'w' },
    );

    const stdoutLines = [];
    let confirmCalls = 0;

    const reconcileCalls = [];
    const reconcileFn = async (args) => {
      reconcileCalls.push(args);
      // Dry-run returns a non-empty plan; the apply call should never
      // arrive on this path because the operator declines.
      return {
        exitCode: 0,
        plan: {
          creates: [{ slug: 'task-x' }],
          updates: [],
          closes: [],
          relinks: [],
        },
      };
    };

    const result = await runEditFlow({
      epicId: EPIC_ID,
      provider: buildStubProvider(),
      specFilePath: path.join(epicsDir, `${EPIC_ID}.yaml`),
      apply: true,
      reconcileFn,
      confirm: async () => {
        confirmCalls += 1;
        return false;
      },
      isTty: () => true,
      stdout: (line) => stdoutLines.push(line),
      stderr: () => {},
    });

    assert.equal(reconcileCalls.length, 1, 'only the dry-run call lands');
    assert.equal(reconcileCalls[0].dryRun, true);
    assert.equal(reconcileCalls[0].apply, false);
    assert.equal(confirmCalls, 1, 'operator was prompted');
    assert.equal(result.applied, false, 'declined operator → no apply');
    assert.equal(result.reason, 'declined');
    assert.ok(
      stdoutLines.some((l) => /declined/i.test(l)),
      'operator decline is announced',
    );
  });

  it('(c) spec present + empty diff — short-circuits without prompting', async () => {
    writeFileSync(
      path.join(epicsDir, `${EPIC_ID}.yaml`),
      'epic:\n  id: 9988\n  title: stub\n',
      { flag: 'w' },
    );

    let confirmCalls = 0;
    const reconcileCalls = [];
    const reconcileFn = async (args) => {
      reconcileCalls.push(args);
      return {
        exitCode: 0,
        plan: { creates: [], updates: [], closes: [], relinks: [] },
      };
    };

    const stdoutLines = [];
    const result = await runEditFlow({
      epicId: EPIC_ID,
      provider: buildStubProvider(),
      specFilePath: path.join(epicsDir, `${EPIC_ID}.yaml`),
      apply: true,
      reconcileFn,
      confirm: async () => {
        confirmCalls += 1;
        return true;
      },
      isTty: () => true,
      stdout: (line) => stdoutLines.push(line),
      stderr: () => {},
    });

    assert.equal(reconcileCalls.length, 1, 'only the dry-run call lands');
    assert.equal(confirmCalls, 0, 'no operator prompt on empty diff');
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'empty-diff');
    assert.ok(
      stdoutLines.some((l) => /no structural changes/i.test(l)),
      'no-changes message is rendered',
    );
  });

  it('(d) spec present + non-empty diff + confirm — apply runs with yes:true', async () => {
    writeFileSync(
      path.join(epicsDir, `${EPIC_ID}.yaml`),
      'epic:\n  id: 9988\n  title: stub\n',
      { flag: 'w' },
    );

    const reconcileCalls = [];
    const reconcileFn = async (args) => {
      reconcileCalls.push(args);
      if (args.dryRun) {
        return {
          exitCode: 0,
          plan: {
            creates: [{ slug: 'task-y' }],
            updates: [],
            closes: [],
            relinks: [],
          },
        };
      }
      return {
        exitCode: 0,
        plan: {
          creates: [{ slug: 'task-y' }],
          updates: [],
          closes: [],
          relinks: [],
        },
        applyResult: { created: 1 },
      };
    };

    const result = await runEditFlow({
      epicId: EPIC_ID,
      provider: buildStubProvider(),
      specFilePath: path.join(epicsDir, `${EPIC_ID}.yaml`),
      apply: true,
      reconcileFn,
      confirm: async () => true,
      isTty: () => true,
      stdout: () => {},
      stderr: () => {},
    });

    assert.equal(reconcileCalls.length, 2, 'dry-run + apply both called');
    assert.equal(reconcileCalls[0].dryRun, true);
    assert.equal(reconcileCalls[1].apply, true);
    assert.equal(reconcileCalls[1].yes, true, 'apply call passes yes:true');
    assert.equal(result.applied, true);
    assert.equal(result.reason, 'applied');
    assert.deepEqual(result.applyResult, { created: 1 });
  });

  it('(e) spec present + apply omitted — dry-run only (no prompt, no apply)', async () => {
    writeFileSync(
      path.join(epicsDir, `${EPIC_ID}.yaml`),
      'epic:\n  id: 9988\n  title: stub\n',
      { flag: 'w' },
    );

    let confirmCalls = 0;
    const reconcileCalls = [];
    const reconcileFn = async (args) => {
      reconcileCalls.push(args);
      return {
        exitCode: 0,
        plan: {
          creates: [{ slug: 'task-z' }],
          updates: [],
          closes: [],
          relinks: [],
        },
      };
    };

    const result = await runEditFlow({
      epicId: EPIC_ID,
      provider: buildStubProvider(),
      specFilePath: path.join(epicsDir, `${EPIC_ID}.yaml`),
      apply: false,
      reconcileFn,
      confirm: async () => {
        confirmCalls += 1;
        return true;
      },
      isTty: () => true,
      stdout: () => {},
      stderr: () => {},
    });

    assert.equal(reconcileCalls.length, 1);
    assert.equal(confirmCalls, 0, 'no prompt without --apply');
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'dry-run-only');
  });

  it('(f) detectExistingSpec returns exists:false for missing spec', () => {
    const probe = detectExistingSpec(EPIC_ID, { epicsDir });
    assert.equal(probe.exists, false);
    assert.ok(probe.path.endsWith(`${EPIC_ID}.yaml`));
  });

  it('(g) detectExistingSpec returns exists:true once the file is staged', () => {
    writeFileSync(
      path.join(epicsDir, `${EPIC_ID}.yaml`),
      'epic:\n  id: 9988\n  title: stub\n',
      { flag: 'w' },
    );
    const probe = detectExistingSpec(EPIC_ID, { epicsDir });
    assert.equal(probe.exists, true);
  });
});
