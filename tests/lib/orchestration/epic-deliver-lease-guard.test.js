import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runEpicDeliverPrepare } from '../../../.agents/scripts/epic-deliver-prepare.js';
import { LEASE_TTL_MS_DEFAULT } from '../../../.agents/scripts/lib/config/limits.js';
import {
  acquireEpicLease,
  checkCheckoutSafety,
  renderCheckoutRefusal,
  resolveOperator,
  runPrepareGuards,
} from '../../../.agents/scripts/lib/orchestration/epic-deliver-lease-guard.js';
import { ensureStoryBranchSeed } from '../../../.agents/scripts/story-init.js';

// ---------------------------------------------------------------------------
// Fakes — mock all I/O (testing-standards § Unit). No real git, no GitHub.
// ---------------------------------------------------------------------------

/** In-memory ticketing provider recording assignees writes. */
function makeProvider(initialAssignees = []) {
  const state = { assignees: [...initialAssignees] };
  const updateCalls = [];
  return {
    state,
    updateCalls,
    async getTicket(id) {
      return { id, assignees: [...state.assignees] };
    },
    async updateTicket(id, mutations) {
      updateCalls.push({ id, mutations });
      if (Array.isArray(mutations?.assignees)) {
        state.assignees = [...mutations.assignees];
      }
    },
  };
}

/** Injectable git shim for the checkout-safety guard. */
function makeGit({ dirty = false, entries = '', branch = 'main' } = {}) {
  return {
    statusPorcelain: () => ({ dirty, entries }),
    currentBranch: () => branch,
  };
}

const NOW = 1_000_000_000_000;
const FRESH = NOW - 1000; // within TTL — live
const STALE = NOW - (LEASE_TTL_MS_DEFAULT + 1000); // older than TTL

const EPIC_ID = 3457;
const EPIC_BRANCH = `epic/${EPIC_ID}`;
const SILENT_LOGGER = { info: () => {}, warn: () => {} };

// ---------------------------------------------------------------------------
// resolveOperator — identity precedence
// ---------------------------------------------------------------------------

describe('epic-deliver-lease-guard — resolveOperator', () => {
  it('prefers the explicit --as flag over config and git email', () => {
    const op = resolveOperator({
      asFlag: 'alice',
      config: { github: { operatorHandle: 'bob' } },
      gitUserEmail: 'carol@example.com',
    });
    assert.equal(op, 'alice');
  });

  it('falls back to github.operatorHandle and strips a leading @', () => {
    const op = resolveOperator({
      config: { github: { operatorHandle: '@bob' } },
      gitUserEmail: 'carol@example.com',
    });
    assert.equal(op, 'bob');
  });

  it('falls back to git user.email last', () => {
    const op = resolveOperator({ gitUserEmail: 'carol@example.com' });
    assert.equal(op, 'carol@example.com');
  });

  it('returns null when no identity can be resolved', () => {
    assert.equal(resolveOperator({}), null);
    assert.equal(resolveOperator({ asFlag: '   ' }), null);
  });
});

// ---------------------------------------------------------------------------
// checkCheckoutSafety — dirty tree / wrong branch refusal (AC2)
// ---------------------------------------------------------------------------

describe('epic-deliver-lease-guard — checkCheckoutSafety', () => {
  it('passes on a clean tree sitting on an expected branch', () => {
    const result = checkCheckoutSafety({
      git: makeGit({ branch: EPIC_BRANCH }),
      expectedBranch: [EPIC_BRANCH, 'main'],
    });
    assert.equal(result.safe, true);
    assert.equal(result.reason, 'clean');
    assert.equal(result.currentBranch, EPIC_BRANCH);
  });

  it('refuses when the working tree is dirty', () => {
    const result = checkCheckoutSafety({
      git: makeGit({ dirty: true, entries: ' M src/x.js', branch: 'main' }),
      expectedBranch: ['main'],
    });
    assert.equal(result.safe, false);
    assert.equal(result.reason, 'dirty');
    assert.match(result.dirtyEntries, /src\/x\.js/);
  });

  it('refuses when HEAD is on a branch other than the expected one', () => {
    const result = checkCheckoutSafety({
      git: makeGit({ branch: 'feature/unrelated' }),
      expectedBranch: [EPIC_BRANCH, 'main'],
    });
    assert.equal(result.safe, false);
    assert.equal(result.reason, 'wrong-branch');
    assert.equal(result.currentBranch, 'feature/unrelated');
  });

  it('refuses in detached-HEAD state', () => {
    const result = checkCheckoutSafety({
      git: makeGit({ branch: null }),
      expectedBranch: ['main'],
    });
    assert.equal(result.safe, false);
    assert.equal(result.reason, 'detached-head');
  });

  it('renders a refusal that names the offending and expected branches', () => {
    const result = checkCheckoutSafety({
      git: makeGit({ branch: 'feature/unrelated' }),
      expectedBranch: [EPIC_BRANCH, 'main'],
    });
    const msg = renderCheckoutRefusal(result);
    assert.match(msg, /feature\/unrelated/);
    assert.match(msg, new RegExp(EPIC_BRANCH.replace('/', '\\/')));
    assert.match(msg, /Refusing to start/);
  });
});

// ---------------------------------------------------------------------------
// acquireEpicLease — fail closed on a live foreign claim (AC1)
// ---------------------------------------------------------------------------

describe('epic-deliver-lease-guard — acquireEpicLease', () => {
  it('throws naming the current owner on a live foreign claim', async () => {
    const provider = makeProvider(['bob']);
    await assert.rejects(
      () =>
        acquireEpicLease({
          provider,
          epicId: EPIC_ID,
          operator: 'alice',
          heartbeatAt: FRESH,
          now: NOW,
        }),
      (err) => {
        assert.match(err.message, /already claimed by 'bob'/);
        assert.match(err.message, new RegExp(`#${EPIC_ID}`));
        return true;
      },
    );
    // Fail closed: no assignees write happened.
    assert.equal(provider.updateCalls.length, 0);
  });

  it('reclaims a stale foreign claim and returns acquired:true', async () => {
    const provider = makeProvider(['bob']);
    const result = await acquireEpicLease({
      provider,
      epicId: EPIC_ID,
      operator: 'alice',
      heartbeatAt: STALE,
      now: NOW,
    });
    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'reclaimed');
    assert.deepEqual(provider.state.assignees, ['alice']);
  });

  it('steals a live foreign claim when steal:true', async () => {
    const provider = makeProvider(['bob']);
    const result = await acquireEpicLease({
      provider,
      epicId: EPIC_ID,
      operator: 'alice',
      heartbeatAt: FRESH,
      steal: true,
      now: NOW,
    });
    assert.equal(result.acquired, true);
    assert.equal(result.reason, 'stolen');
    assert.deepEqual(provider.state.assignees, ['alice']);
  });
});

// ---------------------------------------------------------------------------
// runPrepareGuards — composition order and fail-closed behaviour
// ---------------------------------------------------------------------------

describe('epic-deliver-lease-guard — runPrepareGuards', () => {
  it('throws on a dirty tree BEFORE touching the lease provider', async () => {
    const provider = makeProvider([]);
    await assert.rejects(
      () =>
        runPrepareGuards({
          epicId: EPIC_ID,
          expectedBranch: [EPIC_BRANCH, 'main'],
          git: makeGit({ dirty: true, entries: ' M a.js' }),
          provider,
          operator: 'alice',
          now: NOW,
          logger: SILENT_LOGGER,
        }),
      /working tree is dirty/,
    );
    // Checkout guard runs first, so the lease provider is never written.
    assert.equal(provider.updateCalls.length, 0);
  });

  it('acquires the lease after the checkout guard passes', async () => {
    const provider = makeProvider([]);
    const { checkout, lease } = await runPrepareGuards({
      epicId: EPIC_ID,
      expectedBranch: [EPIC_BRANCH, 'main'],
      git: makeGit({ branch: EPIC_BRANCH }),
      provider,
      operator: 'alice',
      now: NOW,
      logger: SILENT_LOGGER,
    });
    assert.equal(checkout.safe, true);
    assert.equal(lease.acquired, true);
    assert.deepEqual(provider.state.assignees, ['alice']);
  });

  it('fails closed (throws) when no operator identity resolves', async () => {
    const provider = makeProvider([]);
    await assert.rejects(
      runPrepareGuards({
        epicId: EPIC_ID,
        expectedBranch: [EPIC_BRANCH, 'main'],
        git: makeGit({ branch: 'main' }),
        provider,
        operator: null,
        now: NOW,
        logger: SILENT_LOGGER,
      }),
      /no operator identity could be resolved/,
    );
    // checkout-safety runs first (cheap, local); the lease never writes an
    // assignee because the run is refused before the GitHub round-trip.
    assert.equal(provider.updateCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// runEpicDeliverPrepare — end-to-end fail-closed on a live foreign claim (AC1)
// ---------------------------------------------------------------------------

describe('runEpicDeliverPrepare — lease/checkout preflight', () => {
  const baseConfig = {
    github: { owner: 'o', repo: 'r', operatorHandle: 'alice' },
    project: { baseBranch: 'main' },
    orchestration: {
      runners: { deliverRunner: { enabled: true, concurrencyCap: 3 } },
    },
  };

  it('exits non-zero naming the owner when the Epic has a live foreign claim', async () => {
    const provider = makeProvider(['bob']);
    await assert.rejects(
      () =>
        runEpicDeliverPrepare({
          epicId: EPIC_ID,
          injectedProvider: provider,
          injectedConfig: baseConfig,
          injectedGit: makeGit({ branch: EPIC_BRANCH }),
          leaseHeartbeatAt: FRESH,
          leaseNow: NOW,
        }),
      (err) => {
        assert.match(err.message, /already claimed by 'bob'/);
        return true;
      },
    );
    // Fail closed: never reached the snapshot/checkpoint phase.
    assert.equal(provider.updateCalls.length, 0);
  });

  it('refuses to start when the working tree is dirty', async () => {
    const provider = makeProvider([]);
    await assert.rejects(
      () =>
        runEpicDeliverPrepare({
          epicId: EPIC_ID,
          injectedProvider: provider,
          injectedConfig: baseConfig,
          injectedGit: makeGit({ dirty: true, entries: ' M a.js' }),
        }),
      /working tree is dirty/,
    );
  });

  it('refuses to start when HEAD is on an unexpected branch', async () => {
    const provider = makeProvider([]);
    await assert.rejects(
      () =>
        runEpicDeliverPrepare({
          epicId: EPIC_ID,
          injectedProvider: provider,
          injectedConfig: baseConfig,
          injectedGit: makeGit({ branch: 'feature/unrelated' }),
        }),
      /not the expected/,
    );
  });
});

// ---------------------------------------------------------------------------
// runEpicDeliverPrepare — production liveness wiring (audit #3513).
// Proves the /epic-deliver path REFUSES a live foreign claim WITHOUT injecting
// heartbeatAt directly: a fresh story.heartbeat for the foreign owner is seeded
// into a tmpdir Epic ledger and the prepare resolves it via the shared
// latestHeartbeatForOwner. Before the fix this was inert — heartbeatAt
// defaulted to null, every foreign claim looked stale, and the refusal was
// unreachable.
// ---------------------------------------------------------------------------

describe('runEpicDeliverPrepare — heartbeat liveness wiring (#3513)', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'epic-deliver-hb-'));
  });
  afterEach(() => {
    tempRoot = null;
  });

  /** Config whose tempRoot points at the per-test tmpdir ledger location. */
  function configWithTempRoot() {
    return {
      github: { owner: 'o', repo: 'r', operatorHandle: 'alice' },
      project: { baseBranch: 'main', paths: { tempRoot } },
      orchestration: {
        runners: { deliverRunner: { enabled: true, concurrencyCap: 3 } },
      },
    };
  }

  /** Seed a story.heartbeat for `owner` at `tsMs` into the Epic ledger. */
  function seedHeartbeat({ epicId, owner, tsMs }) {
    const dir = path.join(tempRoot, `epic-${epicId}`);
    mkdirSync(dir, { recursive: true });
    const timestamp = new Date(tsMs).toISOString();
    const record = {
      kind: 'emitted',
      ts: timestamp,
      event: 'story.heartbeat',
      payload: { event: 'story.heartbeat', timestamp, operator: owner },
    };
    writeFileSync(
      path.join(dir, 'lifecycle.ndjson'),
      `${JSON.stringify(record)}\n`,
    );
  }

  it('refuses a live foreign claim resolved from the Epic ledger (no injected heartbeat)', async () => {
    const provider = makeProvider(['bob']);
    // Foreign owner bob has a FRESH heartbeat in the ledger → live → refuse.
    seedHeartbeat({ epicId: EPIC_ID, owner: 'bob', tsMs: FRESH });

    await assert.rejects(
      () =>
        runEpicDeliverPrepare({
          epicId: EPIC_ID,
          injectedProvider: provider,
          injectedConfig: configWithTempRoot(),
          injectedGit: makeGit({ branch: EPIC_BRANCH }),
          // NB: leaseHeartbeatAt is NOT passed — liveness comes from the ledger.
          leaseNow: NOW,
        }),
      (err) => {
        assert.match(err.message, /already claimed by 'bob'/);
        return true;
      },
    );
    // Fail closed: no assignee write, never reached snapshot/checkpoint.
    assert.equal(provider.updateCalls.length, 0);
  });

  it('reclaims a foreign claim whose ledger heartbeat is stale', async () => {
    const provider = makeProvider(['bob']);
    // bob's heartbeat is older than the TTL → stale → reclaimable.
    seedHeartbeat({ epicId: EPIC_ID, owner: 'bob', tsMs: STALE });

    // The prepare proceeds past the lease step; it later reads the preflight
    // cache / snapshot which our in-memory provider does not fully model, so
    // we only assert the lease was acquired (assignees flipped to alice).
    await assert.rejects(
      () =>
        runEpicDeliverPrepare({
          epicId: EPIC_ID,
          injectedProvider: provider,
          injectedConfig: configWithTempRoot(),
          injectedGit: makeGit({ branch: EPIC_BRANCH }),
          leaseNow: NOW,
        }),
      // Past the lease, the bare in-memory provider lacks the snapshot surface,
      // so prepare throws downstream — but the lease was reclaimed first.
      () => true,
    );
    assert.deepEqual(provider.state.assignees, ['alice']);
  });
});

// ---------------------------------------------------------------------------
// ensureStoryBranchSeed — reuse existing branch instead of throwing (AC3)
// ---------------------------------------------------------------------------

describe('story-init branch reuse — ensureStoryBranchSeed', () => {
  /** Recording git seam for the branch-seed stage. */
  function makeSeedGit({ localHas, remoteHas, branchStatus = 0, stderr = '' }) {
    const calls = [];
    return {
      calls,
      existsLocally: () => localHas,
      existsRemotely: () => remoteHas,
      spawn: (...args) => {
        calls.push(args);
        if (args[0] === 'branch') {
          return { status: branchStatus, stdout: '', stderr };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    };
  }

  it('reuses a pre-existing local branch without re-seeding (no git branch call)', () => {
    const git = makeSeedGit({ localHas: true, remoteHas: false });
    assert.doesNotThrow(() =>
      ensureStoryBranchSeed({
        storyBranch: 'story-3482',
        epicBranch: EPIC_BRANCH,
        mainCwd: '/repo',
        git,
      }),
    );
    // 'none' action → no git mutation at all.
    assert.equal(git.calls.length, 0);
  });

  it('creates the branch from the epic branch when it does not exist', () => {
    const git = makeSeedGit({ localHas: false, remoteHas: false });
    ensureStoryBranchSeed({
      storyBranch: 'story-3482',
      epicBranch: EPIC_BRANCH,
      mainCwd: '/repo',
      git,
    });
    assert.deepEqual(git.calls[0], ['branch', 'story-3482', EPIC_BRANCH]);
  });

  it('swallows the "already exists" race and reuses instead of throwing', () => {
    // Probe reported absent, but `git branch` lost the race and exits non-zero.
    const git = makeSeedGit({
      localHas: false,
      remoteHas: false,
      branchStatus: 128,
      stderr: "fatal: a branch named 'story-3482' already exists.",
    });
    assert.doesNotThrow(() =>
      ensureStoryBranchSeed({
        storyBranch: 'story-3482',
        epicBranch: EPIC_BRANCH,
        mainCwd: '/repo',
        git,
      }),
    );
  });

  it('still throws on a genuine create failure that is not "already exists"', () => {
    const git = makeSeedGit({
      localHas: false,
      remoteHas: false,
      branchStatus: 128,
      stderr: 'fatal: not a valid object name: epic/3457',
    });
    assert.throws(
      () =>
        ensureStoryBranchSeed({
          storyBranch: 'story-3482',
          epicBranch: EPIC_BRANCH,
          mainCwd: '/repo',
          git,
        }),
      /failed to create/,
    );
  });
});
