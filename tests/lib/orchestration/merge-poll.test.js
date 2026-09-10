/**
 * tests/lib/orchestration/merge-poll.test.js
 *
 * Unit coverage for the close path's check-rollup derivation.
 *
 * `failingChecksBlockMerge` is the required-vs-optional discriminator the
 * rollup itself cannot provide. The bug it exists to prevent: the #4543
 * merge fail-fast treated ANY red check as terminal, so a red optional check
 * (or a CANCELLED superseded workflow run) flipped the Story to
 * `agent::blocked` while GitHub native auto-merge — which gates only on
 * REQUIRED checks — landed the PR anyway, leaving a merged-but-blocked strand
 * only an operator could unpick.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  ADVISORY_GATE_INCONCLUSIVE_CLASS,
  ADVISORY_GATE_RED_CLASS,
  advisoryCheckFailedBlocksArm,
  decideAdvisoryGateBlock,
  decideMergeWaitFailFast,
  deriveChecksStatus,
  deriveRedHeadRuns,
  deriveRequiredRunEvidence,
  failingChecksBlockMerge,
  parseWorkflowRunId,
  readRunSummary,
  requiredCheckFailedBlocksMerge,
  resolveAdvisoryGateVerdict,
  selectBlockingRedRuns,
} from '../../../.agents/scripts/lib/orchestration/merge-poll.js';

describe('deriveChecksStatus', () => {
  it('reports failure for a red check regardless of whether it is required', () => {
    assert.equal(
      deriveChecksStatus([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'FAILURE' },
      ]),
      'failure',
    );
  });

  it('counts a CANCELLED (e.g. superseded) run as a failure', () => {
    assert.equal(
      deriveChecksStatus([{ status: 'COMPLETED', conclusion: 'CANCELLED' }]),
      'failure',
    );
  });

  it('reports still-running while any check is incomplete', () => {
    assert.equal(
      deriveChecksStatus([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'IN_PROGRESS' },
      ]),
      'still-running',
    );
  });

  it('reports success when every check completed green', () => {
    assert.equal(
      deriveChecksStatus([{ status: 'COMPLETED', conclusion: 'SUCCESS' }]),
      'success',
    );
  });

  it('reports unknown for an empty or non-array rollup (checks-less repo)', () => {
    assert.equal(deriveChecksStatus([]), 'unknown');
    assert.equal(deriveChecksStatus(undefined), 'unknown');
  });
});

describe('failingChecksBlockMerge', () => {
  it('is true for a red check GitHub reports as BLOCKED (a required check)', () => {
    assert.equal(
      failingChecksBlockMerge({
        checksStatus: 'failure',
        mergeStateStatus: 'BLOCKED',
      }),
      true,
    );
  });

  it('is false for a red check on an UNSTABLE PR — mergeable with non-passing checks', () => {
    // The live bug: auto-merge lands this PR. Failing fast on it strands the
    // Story agent::blocked on a merged PR.
    assert.equal(
      failingChecksBlockMerge({
        checksStatus: 'failure',
        mergeStateStatus: 'UNSTABLE',
      }),
      false,
    );
  });

  it('is false when the merge state is unknown or absent (degrade to waiting)', () => {
    assert.equal(failingChecksBlockMerge({ checksStatus: 'failure' }), false);
    assert.equal(
      failingChecksBlockMerge({
        checksStatus: 'failure',
        mergeStateStatus: 'UNKNOWN',
      }),
      false,
    );
  });

  it('is false for a CLEAN or BEHIND PR carrying a red check', () => {
    for (const mergeStateStatus of ['CLEAN', 'BEHIND']) {
      assert.equal(
        failingChecksBlockMerge({ checksStatus: 'failure', mergeStateStatus }),
        false,
        `${mergeStateStatus} must not read as a required-check block`,
      );
    }
  });

  it('is false whenever the checks are not red, whatever the merge state', () => {
    for (const checksStatus of [
      'success',
      'pending',
      'still-running',
      'unknown',
      undefined,
    ]) {
      assert.equal(
        failingChecksBlockMerge({ checksStatus, mergeStateStatus: 'BLOCKED' }),
        false,
        `checksStatus=${checksStatus} is not a red check`,
      );
    }
  });

  it('is false for a missing probe', () => {
    assert.equal(failingChecksBlockMerge(undefined), false);
    assert.equal(failingChecksBlockMerge(null), false);
  });

  it('accepts a lowercase merge state (defensive against gh projection drift)', () => {
    assert.equal(
      failingChecksBlockMerge({
        checksStatus: 'failure',
        mergeStateStatus: 'blocked',
      }),
      true,
    );
  });
});

describe('deriveRequiredRunEvidence (Story #4695)', () => {
  it('reports requiredRunFailed only for a genuine FAILURE/ERROR, not superseded noise', () => {
    // A cancelled superseded run and a timed-out run are the rollup noise the
    // aggregate `deriveChecksStatus` miscounts as failure — they are NOT a red
    // required check.
    assert.deepEqual(
      deriveRequiredRunEvidence([
        { status: 'COMPLETED', conclusion: 'CANCELLED' },
        { status: 'COMPLETED', conclusion: 'TIMED_OUT' },
        { status: 'COMPLETED', conclusion: 'SKIPPED' },
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
      ]),
      { requiredRunFailed: false, requiredRunInFlight: false },
    );
    assert.deepEqual(
      deriveRequiredRunEvidence([
        { status: 'COMPLETED', conclusion: 'FAILURE' },
      ]),
      { requiredRunFailed: true, requiredRunInFlight: false },
    );
    assert.deepEqual(
      deriveRequiredRunEvidence([{ status: 'COMPLETED', conclusion: 'ERROR' }]),
      { requiredRunFailed: true, requiredRunInFlight: false },
    );
  });

  it('reports requiredRunInFlight for a QUEUED / IN_PROGRESS CheckRun', () => {
    assert.deepEqual(
      deriveRequiredRunEvidence([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'QUEUED' },
      ]),
      { requiredRunFailed: false, requiredRunInFlight: true },
    );
    assert.deepEqual(deriveRequiredRunEvidence([{ status: 'IN_PROGRESS' }]), {
      requiredRunFailed: false,
      requiredRunInFlight: true,
    });
  });

  it('pins the false-positive shape: a cancelled run beside a still-queued required run', () => {
    // Exactly the measured false positive — the aggregate reads `failure`, but
    // the head still has a run in flight and nothing genuinely failed.
    assert.deepEqual(
      deriveRequiredRunEvidence([
        { status: 'COMPLETED', conclusion: 'CANCELLED' },
        { status: 'QUEUED' },
      ]),
      { requiredRunFailed: false, requiredRunInFlight: true },
    );
  });

  it('handles legacy StatusContext entries via their state field', () => {
    assert.deepEqual(deriveRequiredRunEvidence([{ state: 'PENDING' }]), {
      requiredRunFailed: false,
      requiredRunInFlight: true,
    });
    assert.deepEqual(deriveRequiredRunEvidence([{ state: 'FAILURE' }]), {
      requiredRunFailed: true,
      requiredRunInFlight: false,
    });
    assert.deepEqual(deriveRequiredRunEvidence([{ state: 'EXPECTED' }]), {
      requiredRunFailed: false,
      requiredRunInFlight: true,
    });
  });

  it('returns null for an empty or non-array rollup (evidence unavailable)', () => {
    assert.equal(deriveRequiredRunEvidence([]), null);
    assert.equal(deriveRequiredRunEvidence(undefined), null);
    assert.equal(deriveRequiredRunEvidence(null), null);
  });
});

describe('requiredCheckFailedBlocksMerge (Story #4695)', () => {
  const genuinelyRed = {
    checksStatus: 'failure',
    mergeStateStatus: 'BLOCKED',
    requiredRunEvidence: {
      requiredRunFailed: true,
      requiredRunInFlight: false,
    },
  };

  it('is true only when a required run failed with none in flight', () => {
    assert.equal(requiredCheckFailedBlocksMerge(genuinelyRed), true);
  });

  it('is false when a required run is still in flight (the false positive)', () => {
    assert.equal(
      requiredCheckFailedBlocksMerge({
        ...genuinelyRed,
        requiredRunEvidence: {
          requiredRunFailed: false,
          requiredRunInFlight: true,
        },
      }),
      false,
    );
    // Even a genuine failure alongside an in-flight run keeps polling — the
    // change never converts a real failure into a wait beyond one poll.
    assert.equal(
      requiredCheckFailedBlocksMerge({
        ...genuinelyRed,
        requiredRunEvidence: {
          requiredRunFailed: true,
          requiredRunInFlight: true,
        },
      }),
      false,
    );
  });

  it('is false when the evidence is unavailable (older gh / API error)', () => {
    // The consecutive-probe fallback owns this path — a single evidence-free
    // failing snapshot must never fail-fast through this predicate.
    assert.equal(
      requiredCheckFailedBlocksMerge({
        checksStatus: 'failure',
        mergeStateStatus: 'BLOCKED',
      }),
      false,
    );
    assert.equal(
      requiredCheckFailedBlocksMerge({
        checksStatus: 'failure',
        mergeStateStatus: 'BLOCKED',
        requiredRunEvidence: null,
      }),
      false,
    );
  });

  it('is false when the raw rollup gate does not hold (UNSTABLE / not red)', () => {
    assert.equal(
      requiredCheckFailedBlocksMerge({
        ...genuinelyRed,
        mergeStateStatus: 'UNSTABLE',
      }),
      false,
    );
    assert.equal(
      requiredCheckFailedBlocksMerge({
        checksStatus: 'success',
        mergeStateStatus: 'BLOCKED',
        requiredRunEvidence: {
          requiredRunFailed: true,
          requiredRunInFlight: false,
        },
      }),
      false,
    );
  });

  it('is false for a missing probe', () => {
    assert.equal(requiredCheckFailedBlocksMerge(undefined), false);
    assert.equal(requiredCheckFailedBlocksMerge(null), false);
  });

  it('declines the verdict when a required review is missing (Story #4710)', () => {
    // The rollup cannot prove the red run is REQUIRED, and REVIEW_REQUIRED
    // already explains the BLOCKED merge state — classification must fall
    // through to the human-required branch, not claim checks-failed.
    assert.equal(
      requiredCheckFailedBlocksMerge({
        ...genuinelyRed,
        reviewDecision: 'REVIEW_REQUIRED',
      }),
      false,
    );
    // Any other review decision leaves the verdict intact.
    assert.equal(
      requiredCheckFailedBlocksMerge({
        ...genuinelyRed,
        reviewDecision: 'APPROVED',
      }),
      true,
    );
  });
});

describe('decideMergeWaitFailFast (Story #4710)', () => {
  const redBlockedProbe = {
    state: 'OPEN',
    checksStatus: 'failure',
    mergeStateStatus: 'BLOCKED',
  };

  it('fails fast on per-run evidence of a genuinely red run with none in flight', () => {
    const decision = decideMergeWaitFailFast({
      probe: {
        ...redBlockedProbe,
        requiredRunEvidence: {
          requiredRunFailed: true,
          requiredRunInFlight: false,
        },
      },
      consecutiveRequiredFailSnapshots: 0,
    });
    assert.equal(decision.failFast, true);
    assert.equal(decision.evidencePath, 'per-run');
    assert.equal(decision.prProbe.evidencePath, 'per-run');
    assert.equal(decision.consecutiveRequiredFailSnapshots, 0);
  });

  it('keeps polling while a required run is still in flight (evidence-bearing)', () => {
    const decision = decideMergeWaitFailFast({
      probe: {
        ...redBlockedProbe,
        requiredRunEvidence: {
          requiredRunFailed: false,
          requiredRunInFlight: true,
        },
      },
      consecutiveRequiredFailSnapshots: 1,
    });
    assert.equal(decision.failFast, false);
    assert.equal(
      decision.consecutiveRequiredFailSnapshots,
      0,
      'an evidence-bearing probe resets the evidence-free counter',
    );
  });

  it('without evidence, requires two consecutive failing probes before fail-fast', () => {
    const first = decideMergeWaitFailFast({
      probe: redBlockedProbe,
      consecutiveRequiredFailSnapshots: 0,
    });
    assert.equal(first.failFast, false);
    assert.equal(first.consecutiveRequiredFailSnapshots, 1);

    const second = decideMergeWaitFailFast({
      probe: redBlockedProbe,
      consecutiveRequiredFailSnapshots: first.consecutiveRequiredFailSnapshots,
    });
    assert.equal(second.failFast, true);
    assert.equal(second.evidencePath, 'consecutive-probe');
    // The synthesized evidence routes both paths through the SAME classifier
    // gate downstream.
    assert.deepEqual(second.prProbe.requiredRunEvidence, {
      requiredRunFailed: true,
      requiredRunInFlight: false,
    });
    assert.equal(second.prProbe.evidencePath, 'consecutive-probe');
  });

  it('resets the counter on any non-failing probe', () => {
    const decision = decideMergeWaitFailFast({
      probe: { state: 'OPEN', checksStatus: 'still-running' },
      consecutiveRequiredFailSnapshots: 1,
    });
    assert.equal(decision.failFast, false);
    assert.equal(decision.consecutiveRequiredFailSnapshots, 0);
  });

  it('never fail-fasts while a required review is missing — either path', () => {
    // Per-run path.
    const perRun = decideMergeWaitFailFast({
      probe: {
        ...redBlockedProbe,
        reviewDecision: 'REVIEW_REQUIRED',
        requiredRunEvidence: {
          requiredRunFailed: true,
          requiredRunInFlight: false,
        },
      },
      consecutiveRequiredFailSnapshots: 0,
    });
    assert.equal(perRun.failFast, false);
    // Consecutive-probe path: even the second evidence-free failing probe
    // must not claim checks-failed while REVIEW_REQUIRED explains the block.
    const consecutive = decideMergeWaitFailFast({
      probe: { ...redBlockedProbe, reviewDecision: 'REVIEW_REQUIRED' },
      consecutiveRequiredFailSnapshots: 1,
    });
    assert.equal(consecutive.failFast, false);
  });
});

// ---------------------------------------------------------------------------
// Story #5096 — the ADVISORY counterpart of `requiredCheckFailedBlocksMerge`.
//
// GitHub native auto-merge waits on REQUIRED contexts only, so a red
// NON-required gate is merged straight past. `mergeStateStatus` is the
// discriminator: BLOCKED means the red run gates the merge (already covered
// above); UNSTABLE means "mergeable with non-passing commit status" — the red
// run is advisory and only mandrel can stop the landing.
// ---------------------------------------------------------------------------

describe('deriveRedHeadRuns', () => {
  it('names each genuinely red run, from CheckRun name or StatusContext context', () => {
    assert.deepEqual(
      deriveRedHeadRuns([
        { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
        {
          name: 'Bundle-size ratchet',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
        },
        { context: 'legacy/lint', state: 'ERROR' },
      ]),
      [
        { name: 'Bundle-size ratchet', conclusion: 'FAILURE' },
        { name: 'legacy/lint', conclusion: 'ERROR' },
      ],
    );
  });

  it('excludes the superseded / sibling-invalidated conclusions (the #4695 trap)', () => {
    assert.deepEqual(
      deriveRedHeadRuns([
        { name: 'a', status: 'COMPLETED', conclusion: 'CANCELLED' },
        { name: 'b', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
        { name: 'c', status: 'COMPLETED', conclusion: 'SKIPPED' },
      ]),
      [],
    );
  });

  it('returns [] for an absent or empty rollup', () => {
    assert.deepEqual(deriveRedHeadRuns(undefined), []);
    assert.deepEqual(deriveRedHeadRuns([]), []);
  });

  it('keeps an unnamed red run, with a null name', () => {
    assert.deepEqual(
      deriveRedHeadRuns([{ status: 'COMPLETED', conclusion: 'FAILURE' }]),
      [{ name: null, conclusion: 'FAILURE' }],
    );
  });
});

describe('selectBlockingRedRuns', () => {
  const red = [
    { name: 'Bundle-size ratchet', conclusion: 'FAILURE' },
    { name: 'coverage', conclusion: 'FAILURE' },
  ];

  it('drops exactly the allowlisted runs', () => {
    assert.deepEqual(selectBlockingRedRuns(red, ['coverage']), [
      { name: 'Bundle-size ratchet', conclusion: 'FAILURE' },
    ]);
  });

  it('returns none when every red run is allowlisted', () => {
    assert.deepEqual(
      selectBlockingRedRuns(red, ['coverage', 'Bundle-size ratchet']),
      [],
    );
  });

  it('matches exactly — a partial or differently-cased name does not exempt', () => {
    assert.equal(selectBlockingRedRuns(red, ['coverage-report']).length, 2);
    assert.equal(selectBlockingRedRuns(red, ['COVERAGE']).length, 2);
  });

  it('never exempts an unnamed run', () => {
    assert.deepEqual(
      selectBlockingRedRuns([{ name: null, conclusion: 'FAILURE' }], ['x']),
      [{ name: null, conclusion: 'FAILURE' }],
    );
  });
});

describe('advisoryCheckFailedBlocksArm', () => {
  const redRuns = [{ name: 'Bundle-size ratchet', conclusion: 'FAILURE' }];

  it('blocks a genuinely red run under UNSTABLE', () => {
    assert.equal(
      advisoryCheckFailedBlocksArm({
        mergeStateStatus: 'UNSTABLE',
        redHeadRuns: redRuns,
      }),
      true,
    );
  });

  it('does NOT fire under BLOCKED — that is the required-check case', () => {
    assert.equal(
      advisoryCheckFailedBlocksArm({
        mergeStateStatus: 'BLOCKED',
        redHeadRuns: redRuns,
      }),
      false,
    );
  });

  it('fails OPEN on UNKNOWN, CLEAN, BEHIND, or an absent merge state', () => {
    for (const mergeStateStatus of ['UNKNOWN', 'CLEAN', 'BEHIND', undefined]) {
      assert.equal(
        advisoryCheckFailedBlocksArm({
          mergeStateStatus,
          redHeadRuns: redRuns,
        }),
        false,
        `expected no block for mergeStateStatus=${mergeStateStatus}`,
      );
    }
    assert.equal(advisoryCheckFailedBlocksArm(undefined), false);
  });

  it('does not fire when the only red runs are superseded noise', () => {
    assert.equal(
      advisoryCheckFailedBlocksArm({
        mergeStateStatus: 'UNSTABLE',
        redHeadRuns: deriveRedHeadRuns([
          { name: 'a', status: 'COMPLETED', conclusion: 'CANCELLED' },
        ]),
      }),
      false,
    );
  });

  it('does not fire when every red run is allowlisted', () => {
    assert.equal(
      advisoryCheckFailedBlocksArm(
        { mergeStateStatus: 'UNSTABLE', redHeadRuns: redRuns },
        ['Bundle-size ratchet'],
      ),
      false,
    );
  });

  it('is mutually exclusive with requiredCheckFailedBlocksMerge', () => {
    // BLOCKED + evidenced red required run: the required predicate owns it.
    const requiredCase = {
      checksStatus: 'failure',
      mergeStateStatus: 'BLOCKED',
      requiredRunEvidence: {
        requiredRunFailed: true,
        requiredRunInFlight: false,
      },
      redHeadRuns: redRuns,
    };
    assert.equal(requiredCheckFailedBlocksMerge(requiredCase), true);
    assert.equal(advisoryCheckFailedBlocksArm(requiredCase), false);

    // UNSTABLE: GitHub is not gating, so only the advisory predicate fires.
    const advisoryCase = { ...requiredCase, mergeStateStatus: 'UNSTABLE' };
    assert.equal(requiredCheckFailedBlocksMerge(advisoryCase), false);
    assert.equal(advisoryCheckFailedBlocksArm(advisoryCase), true);
  });
});

describe('the advisory-gate reason text', () => {
  it('names each offending job and its conclusion', () => {
    const reason = reasonOf([
      { name: 'Bundle-size ratchet', conclusion: 'FAILURE' },
    ]);
    assert.match(reason, /Bundle-size ratchet → FAILURE/);
    assert.match(reason, /UNSTABLE/);
    assert.match(reason, /advisoryAllowlist/);
  });

  it('degrades without throwing on an empty or malformed list', () => {
    assert.match(reasonOf([]), /none named/);
    assert.match(reasonOf(undefined), /none named/);
    assert.match(reasonOf([{}]), /\(unnamed run\) → FAILURE/);
  });
});

// ---------------------------------------------------------------------------
// Story #5266 — a job that TIMED OUT having reported no violation is not a job
// that found one, and the two authorise different acts. The gate keeps
// blocking in both cases; only the class, the reason and the remedies change.
// ---------------------------------------------------------------------------

const NAV_TIMEOUT = 'Navigation timeout of 30000 ms exceeded';

/**
 * `classifyAdvisoryRedRun`, `deriveAdvisoryGateClass` and the reason formatter
 * are deliberately module-private: `resolveAdvisoryGateVerdict` is the one
 * door, so a caller cannot take a class without the reason that matches it.
 * These shims score them through that door — which is also how production
 * reaches them.
 */
const classOf = (...runs) =>
  resolveAdvisoryGateVerdict({ blockingRuns: runs }).blockClass;
const reasonOf = (runs, options) =>
  resolveAdvisoryGateVerdict({ blockingRuns: runs, ...options }).reason;

describe('deriveRedHeadRuns — the widened projection (Story #5266)', () => {
  it('carries the summary, workflow run id and completion stamp when present', () => {
    assert.deepEqual(
      deriveRedHeadRuns([
        {
          name: 'a11y scan',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          completedAt: '2026-09-10T10:00:00Z',
          detailsUrl:
            'https://github.com/o/r/actions/runs/1234567890/job/99887766',
          description: NAV_TIMEOUT,
        },
      ]),
      [
        {
          name: 'a11y scan',
          conclusion: 'FAILURE',
          summary: NAV_TIMEOUT,
          runId: 1234567890,
          completedAt: '2026-09-10T10:00:00Z',
        },
      ],
    );
  });

  it('omits every widened field a thin rollup entry cannot supply', () => {
    // The pre-#5266 shape survives byte for byte, which is what keeps a
    // text-less run on its old `advisory-gate-red` verdict.
    assert.deepEqual(
      deriveRedHeadRuns([{ name: 'lint', conclusion: 'FAILURE' }]),
      [{ name: 'lint', conclusion: 'FAILURE' }],
    );
  });
});

describe('parseWorkflowRunId', () => {
  it('reads the run id out of an Actions detailsUrl', () => {
    assert.equal(
      parseWorkflowRunId('https://github.com/o/r/actions/runs/42/job/7'),
      42,
    );
  });

  it('returns null for a non-Actions or absent url', () => {
    assert.equal(parseWorkflowRunId('https://example.com/build/7'), null);
    assert.equal(parseWorkflowRunId(undefined), null);
  });

  it('returns null for a run id of zero — there is nothing to re-run', () => {
    assert.equal(
      parseWorkflowRunId('https://github.com/o/r/actions/runs/0/job/7'),
      null,
    );
  });
});

describe('readRunSummary', () => {
  it('reads a StatusContext description and a CheckRun output alike', () => {
    assert.equal(readRunSummary({ description: NAV_TIMEOUT }), NAV_TIMEOUT);
    assert.equal(
      readRunSummary({
        output: { title: 'Scan failed', summary: NAV_TIMEOUT },
      }),
      `Scan failed — ${NAV_TIMEOUT}`,
    );
  });

  it('is undefined — not empty string — when the record says nothing', () => {
    assert.equal(readRunSummary({ name: 'x' }), undefined);
    assert.equal(readRunSummary(undefined), undefined);
  });
});

describe('classifying one red advisory run', () => {
  it('reads a navigation timeout with no violations as inconclusive', () => {
    assert.equal(
      classOf({ summary: NAV_TIMEOUT }),
      ADVISORY_GATE_INCONCLUSIVE_CLASS,
    );
    assert.equal(
      classOf({ summary: '0 violations found - then TIMED OUT' }),
      ADVISORY_GATE_INCONCLUSIVE_CLASS,
    );
  });

  it('reads a reported violation as a violation, even beside a timeout word', () => {
    assert.equal(
      classOf({ summary: '3 violations found' }),
      ADVISORY_GATE_RED_CLASS,
    );
    assert.equal(
      classOf({ summary: '2 violations found before the run timed out' }),
      ADVISORY_GATE_RED_CLASS,
    );
  });

  it('a run that says nothing keeps the pre-#5266 verdict', () => {
    assert.equal(classOf({ name: 'x' }), ADVISORY_GATE_RED_CLASS);
    assert.equal(classOf(undefined), ADVISORY_GATE_RED_CLASS);
  });

  it('text that matches no timeout signature is a violation, not a timeout', () => {
    // The recogniser is deliberately narrow: an unfamiliar failure keeps the
    // pre-#5266 verdict rather than being excused as "did not finish".
    assert.equal(
      classOf({ summary: 'the bundle grew by 4kB' }),
      ADVISORY_GATE_RED_CLASS,
    );
  });
});

describe('classifying a SET of red advisory runs', () => {
  it('is inconclusive only when EVERY blocking run is', () => {
    assert.equal(
      classOf({ summary: NAV_TIMEOUT }),
      ADVISORY_GATE_INCONCLUSIVE_CLASS,
    );
    assert.equal(
      classOf({ summary: NAV_TIMEOUT }, { summary: '1 violation found' }),
      ADVISORY_GATE_RED_CLASS,
    );
  });

  it('falls back to the red class for an empty or malformed set', () => {
    assert.equal(classOf(), ADVISORY_GATE_RED_CLASS);
    assert.equal(
      resolveAdvisoryGateVerdict({}).blockClass,
      ADVISORY_GATE_RED_CLASS,
    );
  });
});

describe('resolveAdvisoryGateVerdict', () => {
  it('pairs the inconclusive class with wording that says the job did not finish', () => {
    const verdict = resolveAdvisoryGateVerdict({
      blockingRuns: [
        { name: 'a11y scan', conclusion: 'FAILURE', summary: NAV_TIMEOUT },
      ],
    });
    assert.equal(verdict.blockClass, ADVISORY_GATE_INCONCLUSIVE_CLASS);
    assert.match(verdict.reason, /FAILED WITHOUT FINISHING/);
    assert.match(verdict.reason, /reported no violation/);
    assert.doesNotMatch(verdict.reason, /concluded red/);
    assert.match(verdict.reason, /a11y scan → FAILURE/);
  });

  it('leaves a genuine violation on the unchanged red class and wording', () => {
    const verdict = resolveAdvisoryGateVerdict({
      blockingRuns: [
        {
          name: 'Bundle-size ratchet',
          conclusion: 'FAILURE',
          summary: '2 violations found',
        },
      ],
    });
    assert.equal(verdict.blockClass, ADVISORY_GATE_RED_CLASS);
    assert.match(verdict.reason, /concluded red on the PR head/);
    assert.doesNotMatch(verdict.reason, /WITHOUT FINISHING/);
  });

  it('names rerun, hand-merge and allowlist in BOTH classes (AC-8)', () => {
    for (const summary of [NAV_TIMEOUT, '2 violations found']) {
      const reason = reasonOf([
        { name: 'scan', conclusion: 'FAILURE', summary },
      ]);
      assert.match(reason, /--rerun-advisory <n>/);
      assert.match(reason, /delivery\.ci\.rerunAdvisory/);
      assert.match(reason, /[Mm]erge by hand|merge by hand/);
      assert.match(reason, /delivery\.ci\.advisoryAllowlist/);
    }
  });

  it('says so when the allowance was already spent on this head', () => {
    const reason = reasonOf([{ name: 'scan', conclusion: 'FAILURE' }], {
      rerunAllowance: 2,
    });
    assert.match(reason, /rerun allowance \(2\) is already spent/);
  });
});

describe('decideAdvisoryGateBlock — the class travels with the decision', () => {
  const probe = {
    mergeStateStatus: 'UNSTABLE',
    checksStatus: 'failure',
    redHeadRuns: [
      { name: 'a11y scan', conclusion: 'FAILURE', summary: NAV_TIMEOUT },
    ],
  };

  it('returns the inconclusive class for a timed-out advisory run', () => {
    const decision = decideAdvisoryGateBlock({
      probe,
      blockOnAdvisoryFailure: true,
      advisoryAllowlist: [],
    });
    assert.equal(decision.blockClass, ADVISORY_GATE_INCONCLUSIVE_CLASS);
    assert.equal(decision.blockingRuns.length, 1);
  });

  it('still returns null when the knob is off or the run is allowlisted', () => {
    assert.equal(
      decideAdvisoryGateBlock({
        probe,
        blockOnAdvisoryFailure: false,
        advisoryAllowlist: [],
      }),
      null,
    );
    assert.equal(
      decideAdvisoryGateBlock({
        probe,
        blockOnAdvisoryFailure: true,
        advisoryAllowlist: ['a11y scan'],
      }),
      null,
    );
  });
});
