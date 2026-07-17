/**
 * tests/wave-runner/live-probe.test.js — Stories #4594, #4601.
 *
 * Probe mode exists to delete hand-maintained accounting from the `/deliver`
 * beat: the host LLM used to re-seed `--done` and count `--in-flight` by
 * following prose, and every one of those transcriptions was a chance to
 * silently wedge a run or double-dispatch a Story.
 *
 * These tests pin the properties that make the footgun structurally
 * impossible rather than merely documented:
 *
 *   1. `done` and `inFlight` are DERIVED from live labels / issue state, with
 *      no `--done` / `--in-flight` supplied.
 *   2. A foreign blocker that already landed lands in `done[]` (the cross-run
 *      resolution), while an open one keeps gating (`dropForeign: false`).
 *   3. `epilogueDue` is true exactly when every listed Story is done.
 *   4. Probe mode feeds the SAME cycle (2) / wedge (3) exits as flag mode —
 *      one kernel, two adapters.
 *
 * Story #4601 pins the two live states probe mode classified incompletely,
 * both of which presented as an ordinary "waiting" beat:
 *
 *   5. A **dispatched-but-unlabelled** Story holds its slot and is not handed
 *      back. `single-story-init.js` flips `agent::executing` last, so every
 *      test here that sets the label explicitly was skipping the window where
 *      the bug lives.
 *   6. An **`agent::blocked`** Story ends the loop (exit 4) instead of being
 *      polled forever.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createProbeContext,
  probeLiveState,
  validateProbeFlags,
} from '../../.agents/scripts/lib/wave-runner/live-probe.js';
import { runProbedStoriesWaveTick } from '../../.agents/scripts/stories-wave-tick.js';

const CONFIG = { delivery: { deliverRunner: { concurrencyCap: 3 } } };

function storyBody({ changes = [], blockedBy = null } = {}) {
  const lines = [
    '## Goal',
    'Do the thing.',
    '',
    '## Changes',
    ...changes.map(
      (p) => `- {"path":"${p}","assumption":"refactors-existing"}`,
    ),
    '',
    '## Acceptance',
    '- [ ] it works',
    '',
    '## Verify',
    '- npm test (unit)',
  ];
  if (blockedBy) lines.push('', '---', `blocked by #${blockedBy}`);
  return lines.join('\n');
}

/**
 * Build a stub provider over a plain `{ id: issue }` map.
 *
 * `native: []` keeps the dependencies API out of the way so each test states
 * its edges in exactly one place (the body footer) unless it is specifically
 * exercising native-edge union.
 */
function stubProvider(issues, { native = {} } = {}) {
  return {
    getTicket: async (id) => issues[id] ?? null,
    _gh: {
      api: async ({ endpoint }) => {
        const match = endpoint.match(/\/issues\/(\d+)\/dependencies/);
        const edges = native[match?.[1]] ?? [];
        return { stdout: JSON.stringify(edges) };
      },
    },
  };
}

function issue(id, { labels = [], state = 'open', ...bodyArgs } = {}) {
  return {
    number: id,
    title: `Story ${id}`,
    body: storyBody(bodyArgs),
    labels: [{ name: 'type::story' }, ...labels.map((name) => ({ name }))],
    state,
  };
}

/** Run a probe-mode tick against a stubbed provider — no network, no config. */
function tick(issues, { ids, native, concurrency, dispatched } = {}) {
  const provider = stubProvider(issues, { native });
  return runProbedStoriesWaveTick({
    stories: ids ?? Object.keys(issues).join(','),
    concurrency,
    dispatched,
    config: CONFIG,
    context: () => ({ provider, owner: 'dsj1984', repo: 'mandrel' }),
  });
}

describe('probeLiveState — done and in-flight come from live state', () => {
  it('derives done from an agent::done label and from a closed issue', async () => {
    const provider = stubProvider({
      101: issue(101, { labels: ['agent::done'] }),
      102: issue(102, { state: 'closed' }),
      103: issue(103),
    });

    const { doneIds, inFlight } = await probeLiveState({
      ids: [101, 102, 103],
      provider,
      owner: 'dsj1984',
      repo: 'mandrel',
    });

    assert.deepEqual(
      [...doneIds].sort((a, b) => a - b),
      [101, 102],
    );
    assert.equal(inFlight, 0);
  });

  it('counts agent::executing and agent::closing as in-flight', async () => {
    const provider = stubProvider({
      101: issue(101, { labels: ['agent::executing'] }),
      102: issue(102, { labels: ['agent::closing'] }),
      103: issue(103),
    });

    const { inFlight, doneIds } = await probeLiveState({
      ids: [101, 102, 103],
      provider,
      owner: 'dsj1984',
      repo: 'mandrel',
    });

    assert.equal(inFlight, 2);
    assert.equal(doneIds.size, 0);
  });

  it('counts a dispatched-but-unlabelled Story as in-flight (the init window)', async () => {
    // #101 was spawned this beat; single-story-init.js flips agent::executing
    // last, after the install, so live state still reads agent::ready.
    const provider = stubProvider({ 101: issue(101), 102: issue(102) });

    const { inFlight, nodes } = await probeLiveState({
      ids: [101, 102],
      provider,
      owner: 'dsj1984',
      repo: 'mandrel',
      dispatched: [101],
    });

    assert.equal(inFlight, 1);

    // The count alone only reserves a slot — eligibility is decided per-record
    // from labels, so the node must carry the executing label or the kernel
    // re-admits it to the same beat that reserved capacity for it.
    const byId = new Map(nodes.map((n) => [n.id, n]));
    assert.equal(byId.get(101).labels.includes('agent::executing'), true);
    assert.equal(byId.get(102).labels.includes('agent::executing'), false);
  });

  it('does not double-count a dispatched id that has since picked up its label', async () => {
    // The host appends monotonically and never removes, so it re-passes #101
    // after the label lands. A union cannot double-count; a counter would.
    const provider = stubProvider({
      101: issue(101, { labels: ['agent::executing'] }),
    });

    const { inFlight } = await probeLiveState({
      ids: [101],
      provider,
      owner: 'dsj1984',
      repo: 'mandrel',
      dispatched: [101],
    });

    assert.equal(inFlight, 1);
  });

  it('drops a stale dispatched id once live state says it is done', async () => {
    // Without this, a host that never prunes its --dispatched list would hold
    // a slot forever and starve the run — the failure mode that would make
    // --dispatched just another --done.
    const provider = stubProvider({
      101: issue(101, { labels: ['agent::done'] }),
      102: issue(102, { state: 'closed' }),
    });

    const { inFlight } = await probeLiveState({
      ids: [101, 102],
      provider,
      owner: 'dsj1984',
      repo: 'mandrel',
      dispatched: [101, 102],
    });

    assert.equal(inFlight, 0);
  });

  it('ignores a dispatched id outside the probed set', async () => {
    const provider = stubProvider({ 101: issue(101) });

    const { inFlight } = await probeLiveState({
      ids: [101],
      provider,
      owner: 'dsj1984',
      repo: 'mandrel',
      dispatched: [999],
    });

    assert.equal(inFlight, 0);
  });

  it('surfaces agent::blocked ids on blockedIds, counting them neither done nor in-flight', async () => {
    const provider = stubProvider({
      101: issue(101, { labels: ['agent::blocked'] }),
      102: issue(102),
    });

    const { blockedIds, doneIds, inFlight } = await probeLiveState({
      ids: [101, 102],
      provider,
      owner: 'dsj1984',
      repo: 'mandrel',
    });

    assert.deepEqual(blockedIds, [101]);
    assert.equal(doneIds.size, 0);
    assert.equal(inFlight, 0);
  });

  it('unions body edges with native blocked_by edges', async () => {
    const provider = stubProvider(
      {
        101: issue(101),
        102: issue(102, { blockedBy: 101 }),
        103: issue(103),
      },
      { native: { 103: [{ number: 101 }] } },
    );

    const { nodes } = await probeLiveState({
      ids: [101, 102, 103],
      provider,
      owner: 'dsj1984',
      repo: 'mandrel',
    });

    const byId = new Map(nodes.map((n) => [n.id, n]));
    assert.deepEqual(byId.get(102).dependsOn, [101], 'body edge');
    assert.deepEqual(byId.get(103).dependsOn, [101], 'native edge');
  });

  it('threads the declared files[] footprint through to the kernel', async () => {
    const provider = stubProvider({
      101: issue(101, { changes: ['.agents/scripts/a.js'] }),
    });

    const { nodes } = await probeLiveState({
      ids: [101],
      provider,
      owner: 'dsj1984',
      repo: 'mandrel',
    });

    assert.deepEqual(nodes[0].files, ['.agents/scripts/a.js']);
  });
});

describe('runProbedStoriesWaveTick — the flag-free beat', () => {
  it('emits a stories-ready-set envelope with no --done/--in-flight supplied', async () => {
    const { envelope, exitCode } = await tick({
      101: issue(101),
      102: issue(102, { blockedBy: 101 }),
    });

    assert.equal(exitCode, 0);
    assert.equal(envelope.kind, 'stories-ready-set');
    // #102 is gated by #101, which is not done: only #101 dispatches.
    assert.deepEqual(envelope.ready, [101]);
    assert.equal(envelope.totalStories, 2);
    assert.equal(envelope.concurrencyCap, 3);
    assert.equal(envelope.inFlight, 0);
    assert.deepEqual(envelope.done, []);
    assert.equal(envelope.cycleError, null);
    assert.equal(envelope.wedged, null);
  });

  it('opens a dependent the instant its blocker reads done, and never re-dispatches the blocker', async () => {
    const { envelope, exitCode } = await tick({
      101: issue(101, { labels: ['agent::done'] }),
      102: issue(102, { blockedBy: 101 }),
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(envelope.ready, [102]);
    assert.deepEqual(envelope.done, [101]);
    assert.equal(envelope.epilogueDue, false);
  });

  it('subtracts live in-flight Stories from the cap', async () => {
    const { envelope } = await tick(
      {
        101: issue(101, { labels: ['agent::executing'] }),
        102: issue(102),
        103: issue(103),
      },
      { concurrency: '2' },
    );

    // Cap 2 − 1 in-flight = 1 slot; #101 is in-flight so only #102 admits.
    assert.equal(envelope.inFlight, 1);
    assert.deepEqual(envelope.ready, [102]);
  });

  it('reports epilogueDue exactly when every listed Story is done', async () => {
    const partial = await tick({
      101: issue(101, { labels: ['agent::done'] }),
      102: issue(102),
    });
    assert.equal(partial.envelope.epilogueDue, false);

    const complete = await tick({
      101: issue(101, { labels: ['agent::done'] }),
      102: issue(102, { state: 'closed' }),
    });
    assert.equal(complete.envelope.epilogueDue, true);
    assert.equal(complete.exitCode, 0);
    assert.deepEqual(complete.envelope.ready, []);
    assert.deepEqual(complete.envelope.done, [101, 102]);
  });

  it('does not re-emit a dispatched Story on the next beat while init is still running', async () => {
    // The double-dispatch window (Story #4601), as the loop actually meets it.
    // Beat 1 hands back #101; the host spawns it. single-story-init.js flips
    // agent::executing at step 6 of 6, so for the next 3-6 minutes live state
    // still reads agent::ready — and beat 2 lands squarely inside that window.
    const issues = { 101: issue(101), 102: issue(102) };

    const beat1 = await tick(issues, { concurrency: '1' });
    assert.deepEqual(beat1.envelope.ready, [101], 'beat 1 offers #101');

    // Beat 2: labels are unchanged (init has not reached step 6), and the host
    // reports what it spawned. Without that, #101 comes back and a second
    // sub-agent joins it on story-101 and .worktrees/story-101/.
    const beat2 = await tick(issues, { concurrency: '1', dispatched: '101' });

    assert.equal(beat2.envelope.inFlight, 1, '#101 holds its slot');
    assert.deepEqual(
      beat2.envelope.ready,
      [],
      '#101 must not be dispatched twice, and the cap has no room for #102',
    );
    assert.equal(beat2.exitCode, 0, 'in-flight work means waiting, not wedged');
  });

  it('keeps filling the remaining slots around a dispatched Story', async () => {
    // The counterpart risk: --dispatched must hold exactly one slot, not stall
    // the run. Cap 2 − 1 dispatched = 1 slot, so #102 still goes out.
    const { envelope } = await tick(
      { 101: issue(101), 102: issue(102), 103: issue(103) },
      { concurrency: '2', dispatched: '101' },
    );

    assert.equal(envelope.inFlight, 1);
    assert.deepEqual(envelope.ready, [102]);
  });

  it('exits 4 and names the Story when one carries agent::blocked', async () => {
    // Before Story #4601 this was exit 0 / ready: [] / wedged: null forever:
    // blocked is neither done nor ready nor in-flight, and detectWedge drops a
    // Story with no unmet blockers. /deliver read that as "waiting" and polled
    // a state no beat could ever change.
    const { envelope, exitCode } = await tick({
      101: issue(101, { labels: ['agent::blocked'] }),
      102: issue(102, { blockedBy: 101 }),
    });

    assert.equal(exitCode, 4);
    assert.deepEqual(envelope.blocked, [101]);
    assert.match(envelope.blockedReason, /#101/);
    assert.match(envelope.blockedReason, /HITL pause/);
    assert.match(envelope.blockedReason, /update-ticket-state\.js/);
    assert.deepEqual(envelope.ready, []);
    assert.equal(envelope.epilogueDue, false);
  });

  it('reports blocked: [] and exit 0 on a healthy beat', async () => {
    const { envelope, exitCode } = await tick({ 101: issue(101) });

    assert.equal(exitCode, 0);
    assert.deepEqual(envelope.blocked, []);
    assert.equal(envelope.blockedReason, null);
  });

  it('lets a blocked Story outrank a wedge, but never a cycle', async () => {
    // A wedge's named blockers are moot while a human owes a decision, so
    // blocked wins. A cycle is a malformed graph that must be fixed before any
    // of this run's state means anything, so it does not yield.
    const wedgeAndBlock = await tick(
      {
        101: issue(101, { labels: ['agent::blocked'] }),
        102: issue(102, { blockedBy: 999 }),
        999: issue(999),
      },
      { ids: '101,102' },
    );
    assert.equal(wedgeAndBlock.exitCode, 4);
    assert.deepEqual(wedgeAndBlock.envelope.blocked, [101]);

    const cycleAndBlock = await tick({
      101: issue(101, { blockedBy: 102 }),
      102: issue(102, { blockedBy: 101 }),
      103: issue(103, { labels: ['agent::blocked'] }),
    });
    assert.equal(cycleAndBlock.exitCode, 2);
    assert.match(cycleAndBlock.envelope.cycleError, /Dependency cycle/);
  });

  it('rejects a malformed --dispatched list', async () => {
    const { envelope, exitCode } = await runProbedStoriesWaveTick({
      stories: '101',
      dispatched: '101,nope',
      config: CONFIG,
      context: () => ({ provider: {}, owner: 'o', repo: 'r' }),
    });

    assert.equal(exitCode, 1);
    assert.match(envelope.inputError, /--dispatched must be a comma-separated/);
  });

  it('exits 2 on a dependency cycle, matching flag-mode semantics', async () => {
    const { envelope, exitCode } = await tick({
      101: issue(101, { blockedBy: 102 }),
      102: issue(102, { blockedBy: 101 }),
    });

    assert.equal(exitCode, 2);
    assert.match(envelope.cycleError, /Dependency cycle detected/);
    assert.deepEqual(envelope.ready, []);
  });

  it('exits 3 on a wedge — an open foreign blocker keeps gating', async () => {
    // #999 is foreign (not in --stories) and OPEN, so it must keep gating:
    // dropForeign is false. Nothing is ready, nothing is in flight → wedge.
    const { envelope, exitCode } = await tick(
      {
        101: issue(101, { blockedBy: 999 }),
        999: issue(999),
      },
      { ids: '101' },
    );

    assert.equal(exitCode, 3);
    assert.equal(envelope.wedged.reason.includes('#101'), true);
    assert.deepEqual(envelope.wedged.stories, [
      { id: 101, unmetBlockers: [999] },
    ]);
  });

  it('resolves a landed foreign blocker into done[] rather than wedging', async () => {
    // The cross-run case: #999 merged weeks ago in another run. Probing it
    // live is what makes #101 simply ready.
    const { envelope, exitCode } = await tick(
      {
        101: issue(101, { blockedBy: 999 }),
        999: issue(999, { state: 'closed' }),
      },
      { ids: '101' },
    );

    assert.equal(exitCode, 0);
    assert.deepEqual(envelope.ready, [101]);
    assert.deepEqual(envelope.done, [999]);
    assert.equal(envelope.wedged, null);
  });

  it('fails loud rather than degrading a broken probe into an empty ready set', async () => {
    const { envelope, exitCode } = await runProbedStoriesWaveTick({
      stories: '101',
      config: CONFIG,
      context: () => ({ provider: {}, owner: 'o', repo: 'r' }),
      probe: async () => {
        throw new Error('dependencies API disabled');
      },
    });

    assert.equal(exitCode, 1);
    assert.match(envelope.inputError, /Could not probe live state/);
    assert.match(envelope.inputError, /dependencies API disabled/);
  });

  it('rejects a malformed --stories list', async () => {
    const { envelope, exitCode } = await runProbedStoriesWaveTick({
      stories: 'not-an-id',
      config: CONFIG,
      context: () => ({ provider: {}, owner: 'o', repo: 'r' }),
    });

    assert.equal(exitCode, 1);
    assert.match(envelope.inputError, /positive issue numbers/);
  });
});

describe('validateProbeFlags — the modes stay mutually exclusive', () => {
  it('accepts each mode on its own', () => {
    assert.equal(validateProbeFlags({ probeLive: true, stories: '1,2' }), null);
    assert.equal(validateProbeFlags({ dag: '[]', done: '1' }), null);
  });

  it('rejects hand-maintained accounting alongside --probe-live', () => {
    // The whole point: a supplied --done under --probe-live would silently
    // reintroduce the state probe mode exists to retire.
    for (const conflict of [
      { dag: '[]' },
      { dagFile: '/tmp/d.json' },
      { done: '101' },
      { inFlight: '1' },
    ]) {
      const err = validateProbeFlags({
        probeLive: true,
        stories: '1',
        ...conflict,
      });
      assert.match(err, /mutually exclusive/);
    }
  });

  it('requires --stories under --probe-live, and --probe-live under --stories', () => {
    assert.match(validateProbeFlags({ probeLive: true }), /requires --stories/);
    assert.match(
      validateProbeFlags({ stories: '1,2' }),
      /--stories requires --probe-live/,
    );
  });

  it('admits --dispatched under --probe-live but not alongside flag mode', () => {
    // --dispatched is additive and live-state-filtered, so it does not
    // reintroduce authoritative hand-maintained accounting the way --in-flight
    // would — which is why --in-flight stays excluded and this does not.
    assert.equal(
      validateProbeFlags({ probeLive: true, stories: '1', dispatched: '1' }),
      null,
    );
    assert.match(
      validateProbeFlags({ dag: '[]', dispatched: '1' }),
      /--dispatched requires --probe-live/,
    );
    assert.match(
      validateProbeFlags({ probeLive: true, stories: '1', inFlight: '1' }),
      /mutually exclusive/,
    );
  });
});

describe('CLI wiring — the mode guard fires before any network read', () => {
  const SCRIPT = fileURLToPath(
    new URL('../../.agents/scripts/stories-wave-tick.js', import.meta.url),
  );

  it('refuses --probe-live alongside --done without touching GitHub', () => {
    const res = spawnSync(
      process.execPath,
      [SCRIPT, '--stories', '101', '--probe-live', '--done', '101'],
      { encoding: 'utf8' },
    );

    assert.equal(res.status, 1);
    const envelope = JSON.parse(res.stdout);
    assert.match(envelope.inputError, /mutually exclusive/);
    assert.equal(envelope.kind, 'stories-ready-set');
  });

  it('documents probe mode in --help', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '--help'], {
      encoding: 'utf8',
    });

    assert.equal(res.status, 0);
    assert.match(res.stdout, /--probe-live/);
    assert.match(res.stdout, /--stories <csv>/);
    assert.match(res.stdout, /--dispatched <csv>/);
    assert.match(res.stdout, /4 - Blocked/);
  });
});

describe('createProbeContext — shares the resolver provider seam', () => {
  it('projects the provider and repo coordinates from resolved config', () => {
    const provider = { getTicket: async () => null };
    const ctx = createProbeContext({
      resolveProvider: () => ({
        provider,
        config: { github: { owner: 'dsj1984', repo: 'mandrel' } },
      }),
    });

    assert.equal(ctx.provider, provider);
    assert.equal(ctx.owner, 'dsj1984');
    assert.equal(ctx.repo, 'mandrel');
  });
});
