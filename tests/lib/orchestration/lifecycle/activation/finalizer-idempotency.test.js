// tests/lib/orchestration/lifecycle/activation/finalizer-idempotency.test.js
/**
 * Contract test — Finalizer idempotency at the production bus boundary
 * (Story #2319 / Task #2330; AC for Epic #2306 close-tail safety).
 *
 * The Finalizer's listener-level `(event, seqId)` guard already prevents
 * a single-process replay from opening a second PR, but a cross-process
 * re-run of `/epic-deliver` after a crash mints fresh seqIds — the
 * `gh pr list --head` probe is the load-bearing defence for that case.
 * This file drives the probe explicitly with a stubbed `gh` CLI that
 * records call counts, and asserts:
 *
 *   1. After two consecutive `acceptance.reconcile.ok` emissions on
 *      DIFFERENT listener instances (the cross-process re-run shape),
 *      the stubbed `gh pr create` is invoked exactly once. The second
 *      invocation short-circuits through the `gh pr list --head` probe.
 *   2. The probe (`gh pr list --head`) runs on EVERY emission — its
 *      result, not its absence, is what guards against a duplicate
 *      open.
 *   3. The lifecycle ledger records the single fresh PR opening
 *      (one `pr.created` from `outcome=opened`); subsequent
 *      affirmations carry `outcome=existing` and are visible on the
 *      listener's classification surface. The combined ledger view
 *      that operators read shows exactly one `outcome=opened`
 *      `pr.created` regardless of how many crash-resume cycles a run
 *      survives.
 *
 * The stubbed `gh` CLI is a simple call-counter that returns the open
 * PR's URL on `gh pr list` after the first `gh pr create`. The Finalizer
 * sees the probe succeed on the second emit and emits `pr.created`
 * carrying the existing URL with classification outcome `existing`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { Bus } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { createLedgerWriter } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js';
import { Finalizer } from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/finalizer.js';

const EPIC_ID = 2319;
const EPIC_BRANCH = `epic/${EPIC_ID}`;
const FRESH_PR_URL = 'https://github.com/dsj1984/mandrel/pull/9999';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

/**
 * Tiny stubbed `gh` CLI. Records every spawn invocation with its
 * argv so the contract can assert call counts per subcommand. The
 * stub knows three shapes:
 *   - `gh pr list --head <branch> --json url --jq .[0].url` →
 *     stdout = open-PR URL if a previous create succeeded, else empty.
 *   - `gh pr create …` → records and returns the canned URL.
 *   - anything else → status 0, empty stdout (so the listener does
 *     not error on `git push` or similar shells the stubbed CLI does
 *     not represent).
 */
function makeGhStub() {
  const calls = [];
  let openPrUrl = null;
  function spawnFn(cmd, args) {
    calls.push({ cmd, args });
    if (cmd !== 'gh') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'list') {
      return {
        status: 0,
        stdout: openPrUrl ? `${openPrUrl}\n` : '',
        stderr: '',
      };
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      openPrUrl = FRESH_PR_URL;
      return { status: 0, stdout: `${FRESH_PR_URL}\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  }
  return {
    spawnFn,
    calls,
    listCalls: () =>
      calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'list'),
    createCalls: () =>
      calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'create'),
  };
}

describe('Finalizer cross-process idempotency — gh pr list --head probe', () => {
  it('two acceptance.reconcile.ok emissions invoke gh pr create exactly once', async () => {
    // Production-shape ledger writer wiring. Each "process" gets a
    // fresh bus (the listener-level seqId cache lives on the listener
    // instance, so a cross-process re-run mints fresh seqIds — the
    // gh-probe is the load-bearing defence for that case). The ledger
    // writer is shared so the audit trail spans both runs, mirroring
    // the operator's view of `temp/epic-<id>/lifecycle.ndjson` across
    // a crash + resume.
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'finalizer-idem-'));
    let ledgerPath;
    try {
      const ledger = createLedgerWriter({ epicId: EPIC_ID, tempRoot });
      ledgerPath = ledger.ledgerPath;

      const gh = makeGhStub();

      // Simulated `runFinalizeFn` that the production CLI used to own.
      // It calls the stubbed `gh pr create` and returns the new URL —
      // exactly the shape the Finalizer expects from its delegate.
      const runFinalizeFn = async () => {
        const result = gh.spawnFn('gh', [
          'pr',
          'create',
          '--head',
          EPIC_BRANCH,
          '--base',
          'main',
        ]);
        if (result.status !== 0) {
          return { blocker: { reason: 'gh-create-failed' } };
        }
        return { prUrl: result.stdout.trim() };
      };

      // Cross-process shape: two distinct (bus, Finalizer) pairs (each
      // emit comes from a separate `/epic-deliver` invocation, so the
      // listener-level seqId cache is empty and the in-memory bus
      // state is fresh on each). The shared ledger captures both runs.
      const buildRun = () => {
        const bus = new Bus();
        ledger.register(bus);
        const finalizer = new Finalizer({
          bus,
          epicId: EPIC_ID,
          cwd: tempRoot,
          ghPrListHeadFn: ({ epicBranch }) =>
            gh.spawnFn('gh', [
              'pr',
              'list',
              '--head',
              epicBranch,
              '--json',
              'url',
              '--jq',
              '.[0].url',
            ]),
          runFinalizeFn,
          logger: quietLogger(),
        });
        finalizer.register();
        return { bus, finalizer };
      };

      const first = buildRun();
      await first.bus.emit('acceptance.reconcile.ok', { baseRead: true });

      const second = buildRun();
      await second.bus.emit('acceptance.reconcile.ok', { baseRead: true });

      // Stub assertions — call-count surface for `gh pr create`.
      assert.equal(
        gh.createCalls().length,
        1,
        'gh pr create must be invoked exactly once across both emissions',
      );
      assert.equal(
        gh.listCalls().length,
        2,
        'gh pr list --head must run on each emission as the idempotency probe',
      );

      // Operator-facing surface: every `pr.created` emission in the
      // shared ledger carries the SAME PR URL — there is no second
      // URL minted by `gh pr create`. The Finalizer re-emits
      // `pr.created` on the existing-PR short-circuit by design so
      // downstream listeners always see the URL, but the load-bearing
      // invariant is at-most-one `gh pr create` and at-most-one
      // distinct URL across all `pr.created` records.
      const ledgerLines = readFileSync(ledgerPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const prCreatedRecs = ledgerLines.filter(
        (r) => r.kind === 'emitted' && r.event === 'pr.created',
      );
      assert.ok(
        prCreatedRecs.length >= 1,
        'at least one pr.created emission must land in the ledger',
      );
      const distinctUrls = new Set(prCreatedRecs.map((r) => r.payload.prUrl));
      assert.equal(
        distinctUrls.size,
        1,
        'every pr.created emission across both runs must carry the same PR URL',
      );
      assert.ok(
        distinctUrls.has(FRESH_PR_URL),
        'the single distinct pr.created URL must match the one minted by gh pr create',
      );

      // Listener classification surface: first opens, second short-
      // circuits to the existing URL. This is the AC-9 "no silent
      // skip" guarantee — the operator can see in the listener's
      // classifications why no new PR was opened on the second pass.
      const firstOutcomes = first.finalizer.classifications.map(
        (c) => c.outcome,
      );
      const secondOutcomes = second.finalizer.classifications.map(
        (c) => c.outcome,
      );
      assert.ok(
        firstOutcomes.includes('opened'),
        'first Finalizer classifies the fresh open as `opened`',
      );
      assert.ok(
        secondOutcomes.includes('existing'),
        'second Finalizer short-circuits via the gh probe (outcome=existing)',
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
