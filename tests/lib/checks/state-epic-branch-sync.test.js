import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  assembleState,
  clearStateCache,
} from '../../../.agents/scripts/lib/checks/state.js';

/**
 * Spy/benchmark coverage for Story #2463 — the `epicBranchSync` probe must
 * issue O(1) spawnSync calls for the sync surface itself (one batched
 * `for-each-ref` covering every local branch), independent of how many
 * `epic/<id>` branches the working tree carries. The pre-batch
 * implementation issued two `rev-parse --verify` calls per epic branch
 * (local + origin), which scaled linearly with branch count and dominated
 * preflight latency on long-running consumer repos.
 *
 * Companion file: state.test.js. That suite exercises shape correctness
 * and per-branch field semantics; this file isolates the call-count
 * invariant and the byte-identical return-shape snapshot.
 */

/**
 * Build a counting git probe that emits a synthetic for-each-ref payload
 * matching the new `--format='%(refname:short) %(objectname) %(upstream:short) %(upstream:objectname)'`
 * contract. Returns `{ probes, counts, perCommand }` so each assertion can
 * read the slice it cares about.
 */
function makeCountingProbes(branches) {
  const counts = { git: 0 };
  const perCommand = { 'for-each-ref': 0, 'rev-parse': 0, config: 0 };
  const probes = {
    git: (_cwd, ...args) => {
      counts.git += 1;
      const cmd = args[0];
      perCommand[cmd] = (perCommand[cmd] ?? 0) + 1;
      if (cmd === 'rev-parse' && args[1] === '--abbrev-ref') {
        return { ok: true, stdout: 'story-spy' };
      }
      if (cmd === 'rev-parse' && args[1] === '--git-common-dir') {
        return { ok: true, stdout: '/repo-spy/.git' };
      }
      if (cmd === 'for-each-ref' && args[2] === 'refs/heads/epic/') {
        return { ok: true, stdout: branches.join('\n') };
      }
      if (cmd === 'for-each-ref' && args[2] === 'refs/heads/') {
        // Sync probe path (multi-token format) OR localBranches path
        // (single-token format). Distinguish on the --format= argument.
        if (args[1].includes('%(objectname)')) {
          // Sync — emit one synthetic row per epic branch with distinct
          // SHAs so callers can assert local/remote independence.
          const rows = branches.map(
            (b, i) =>
              `${b} local${i.toString(16).padStart(40, '0')} origin/${b} remote${i.toString(16).padStart(40, '0')}`,
          );
          return { ok: true, stdout: rows.join('\n') };
        }
        return { ok: true, stdout: branches.join('\n') };
      }
      if (cmd === 'config') return { ok: true, stdout: 'false' };
      return { ok: false, stdout: '' };
    },
    fs: () => false,
    env: () => 'missing',
    lock: () => ({ exists: false }),
    pidLiveness: () => false,
  };
  return { probes, counts, perCommand };
}

describe('epicBranchSync probe — Story #2463 batching', () => {
  beforeEach(() => {
    clearStateCache();
  });

  it('issues O(1) sync spawnSync calls regardless of epic-branch count', () => {
    // Two repos with very different branch counts — the *sync probe*
    // spawnSync count must stay constant (1 invocation).
    const small = makeCountingProbes(['epic/1']);
    assembleState({
      scope: 'story-close',
      cwd: '/spy-small',
      probes: small.probes,
    });
    const smallSyncCalls = small.perCommand['for-each-ref'];

    clearStateCache();

    const branches = Array.from({ length: 25 }, (_, i) => `epic/${i + 100}`);
    const large = makeCountingProbes(branches);
    assembleState({
      scope: 'story-close',
      cwd: '/spy-large',
      probes: large.probes,
    });
    const largeSyncCalls = large.perCommand['for-each-ref'];

    // The for-each-ref invocations are: epicBranches (1) + localBranches (1)
    // + epicBranchSync batched probe (1) = 3, regardless of branch count.
    // The crucial assertion is that growing from 1 → 25 branches does NOT
    // grow the spawnSync count by 2× per branch (the pre-batch behavior).
    assert.equal(
      smallSyncCalls,
      largeSyncCalls,
      'for-each-ref invocation count must be branch-count-independent',
    );
    assert.equal(largeSyncCalls, 3);
  });

  it('does NOT issue per-branch rev-parse --verify calls for sync', () => {
    const branches = Array.from({ length: 10 }, (_, i) => `epic/${i + 200}`);
    const { probes, perCommand } = makeCountingProbes(branches);
    assembleState({ scope: 'story-close', cwd: '/spy-no-rp', probes });
    // rev-parse fires exactly twice for the story-close scope on this fixture:
    //   1. `--abbrev-ref HEAD` for git.headRef
    //   2. `--git-common-dir`  driven by fs.epicMergeLocks
    // Crucially it does NOT fire 2 × N additional times for sync — the
    // pre-batch implementation would have emitted 20 additional
    // `rev-parse --verify` calls (local + origin for each of 10 branches).
    // Without that scaling, growing branches from 1 → 10 → 100 leaves
    // rev-parse count flat at 2.
    assert.equal(
      perCommand['rev-parse'],
      2,
      'rev-parse must only fire for headRef and --git-common-dir, not per-branch verify',
    );
  });

  it('total git probe count is bounded by O(1) + O(epicBranches) for the surrounding surface', () => {
    // The Task contract is `O(1) + O(epicBranches)`. The epicBranches term
    // is consumed by sibling probes (fs.epicMergeLocks per-branch lock
    // file checks via `lockProbe`), not by the sync probe itself. Here we
    // assert the SYNC probe component is purely O(1).
    const branches = Array.from({ length: 50 }, (_, i) => `epic/${i + 300}`);
    const { probes, counts } = makeCountingProbes(branches);
    assembleState({ scope: 'story-close', cwd: '/spy-bounded', probes });
    // Pre-batch: 4 fixed + 50 × 2 + 1 common-dir = 105 git calls. Post-batch:
    // 4 fixed (headRef, epicBranches, localBranches, coreBare) + 1 sync
    // for-each-ref + 1 git-common-dir = 6.
    assert.ok(
      counts.git <= 10,
      `git probe count must stay constant across branch growth, got ${counts.git}`,
    );
  });

  it('return shape stays byte-identical { local, remote, ahead } per branch (snapshot)', () => {
    const branches = ['epic/501', 'epic/502'];
    const { probes } = makeCountingProbes(branches);
    const state = assembleState({
      scope: 'story-close',
      cwd: '/spy-shape',
      probes,
    });
    // Snapshot the keys and value types per branch — the consumer
    // (stale-origin-epic check) treats this shape as a stable contract.
    const sync = state.git.epicBranchSync;
    assert.deepEqual(Object.keys(sync).sort(), branches.slice().sort());
    for (const branch of branches) {
      const entry = sync[branch];
      assert.deepEqual(
        Object.keys(entry).sort(),
        ['ahead', 'local', 'remote'],
        `entry for ${branch} must have exactly { local, remote, ahead } keys`,
      );
      assert.equal(typeof entry.local, 'string');
      assert.equal(typeof entry.remote, 'string');
      assert.equal(typeof entry.ahead, 'boolean');
      // SHAs differ across local vs remote in this fixture → ahead=true.
      assert.equal(entry.ahead, true);
    }
  });

  it('default probe seam stays intact — omitting `probes` does not throw', () => {
    // Production callers omit `probes` and get the spawnSync-backed
    // defaults. This test asserts the default seam still resolves; it
    // does not assert SHA content because the real git repo state is
    // out-of-band for unit testing. The assembler must return without
    // throwing and must produce an object for epicBranchSync (even if
    // empty when no epic branches exist).
    const state = assembleState({ scope: 'retro', cwd: process.cwd() });
    assert.equal(typeof state, 'object');
    assert.equal(state.scope, 'retro');
  });
});
