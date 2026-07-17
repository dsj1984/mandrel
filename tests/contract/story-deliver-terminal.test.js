/**
 * tests/contract/story-deliver-terminal.test.js — the terminal-envelope
 * contract (Story #4543).
 *
 * The delivery tail used to have two divergent prose return contracts — one
 * in `helpers/deliver-story.md`, a different one in `agents/story-worker.md`
 * — and neither was validated by any schema, so nothing could catch them
 * drifting apart. This suite is what replaces "two docs that hopefully
 * agree" with an enforced shape.
 *
 * It pins:
 *   - the status enum is exactly landed | pending | blocked | failed (no
 *     fifth status can be smuggled in);
 *   - the builder VALIDATES and throws rather than emitting a malformed
 *     terminal — a silently-wrong terminal is the failure mode the envelope
 *     exists to eliminate;
 *   - `pending` carries its own exit code, distinct from blocked/failed;
 *   - a landed terminal exposes per-step tail booleans;
 *   - a blocked terminal carries a shared-classifier class;
 *   - the shipped schema and the shared block classifier agree on the class
 *     vocabulary — the drift a hand-maintained enum invites.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setLevel } from '../../.agents/scripts/lib/Logger.js';
import { MERGE_UNLANDED_BLOCK_CLASSES } from '../../.agents/scripts/lib/orchestration/merge-block-class.js';
import {
  buildTerminalEnvelope,
  emitTerminalEnvelope,
  exitCodeForTerminal,
  NEXT_COMMANDS,
  TERMINAL_BEGIN_MARKER,
  TERMINAL_END_MARKER,
  TERMINAL_ENVELOPE_KIND,
  TERMINAL_EXIT_CODES,
  TERMINAL_STATUSES,
  validateTerminalEnvelope,
} from '../../.agents/scripts/lib/orchestration/story-deliver-terminal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(
  readFileSync(
    path.resolve(
      __dirname,
      '..',
      '..',
      '.agents',
      'schemas',
      'story-deliver-terminal.schema.json',
    ),
    'utf8',
  ),
);

const CLEAN_TAIL = {
  followUps: true,
  statusResync: true,
  refCleanup: true,
  baseFastForward: true,
};

describe('story-deliver-terminal — the status contract', () => {
  it('the schema admits exactly four statuses, and no more', () => {
    assert.deepEqual(SCHEMA.properties.status.enum, [
      'landed',
      'pending',
      'blocked',
      'failed',
    ]);
    assert.deepEqual([...TERMINAL_STATUSES], SCHEMA.properties.status.enum);
  });

  it('rejects a status outside the enum instead of emitting it', () => {
    assert.throws(
      () =>
        buildTerminalEnvelope({
          storyId: 1,
          status: 'partially-landed',
          phase: 'confirm-merge',
          nextCommand: null,
          elapsedSeconds: 0,
        }),
      /violates story-deliver-terminal\.schema\.json/,
    );
  });

  it('rejects an envelope missing the phase it ended in', () => {
    assert.throws(
      () =>
        buildTerminalEnvelope({
          storyId: 1,
          status: 'landed',
          phase: 'not-a-phase',
          nextCommand: null,
          elapsedSeconds: 0,
        }),
      /violates story-deliver-terminal\.schema\.json/,
    );
  });

  it('every status maps to an exit code, and pending is distinct from blocked/failed', () => {
    for (const status of TERMINAL_STATUSES) {
      assert.equal(typeof TERMINAL_EXIT_CODES[status], 'number');
    }
    assert.equal(TERMINAL_EXIT_CODES.landed, 0);
    assert.equal(TERMINAL_EXIT_CODES.blocked, 1);
    assert.equal(TERMINAL_EXIT_CODES.failed, 1);
    // The whole point: a caller must be able to tell "slow CI, resume me"
    // from "hard block, come look" without parsing stdout.
    assert.notEqual(TERMINAL_EXIT_CODES.pending, TERMINAL_EXIT_CODES.landed);
    assert.notEqual(TERMINAL_EXIT_CODES.pending, TERMINAL_EXIT_CODES.blocked);
  });
});

describe('story-deliver-terminal — landed', () => {
  it('carries per-step tail booleans and no next command', () => {
    const env = buildTerminalEnvelope({
      storyId: 4543,
      status: 'landed',
      phase: 'post-land',
      storyBranch: 'story-4543',
      baseBranch: 'main',
      pr: { number: 99, url: 'https://x/99', state: 'MERGED' },
      gates: { validation: 'passed', codeReview: 'passed' },
      tail: CLEAN_TAIL,
      nextCommand: null,
      elapsedSeconds: 42,
    });
    assert.equal(env.kind, TERMINAL_ENVELOPE_KIND);
    assert.equal(env.status, 'landed');
    assert.equal(env.nextCommand, null);
    assert.equal(exitCodeForTerminal(env), 0);
    assert.deepEqual(
      Object.keys(env.tail)
        .filter((k) => k !== 'details')
        .sort(),
      ['baseFastForward', 'followUps', 'refCleanup', 'statusResync'],
    );
  });

  it('exposes a partial-tail degradation WITHOUT failing the land', () => {
    // The reap defect this repo fixed existed because a phase reported an
    // outcome it never checked. A degraded step must be visible and must not
    // demote a merge that demonstrably landed.
    const env = buildTerminalEnvelope({
      storyId: 4543,
      status: 'landed',
      phase: 'post-land',
      pr: { number: 99, state: 'MERGED' },
      tail: {
        ...CLEAN_TAIL,
        statusResync: false,
        details: { statusResync: 'status column drifted (attempts=4)' },
      },
      nextCommand: null,
      elapsedSeconds: 10,
    });
    assert.equal(env.status, 'landed');
    assert.equal(exitCodeForTerminal(env), 0);
    assert.equal(env.tail.statusResync, false);
    assert.match(env.tail.details.statusResync, /drifted/);
  });

  it('requires every tail step to be reported — no aggregate success bit', () => {
    assert.throws(
      () =>
        buildTerminalEnvelope({
          storyId: 1,
          status: 'landed',
          phase: 'post-land',
          tail: { followUps: true },
          nextCommand: null,
          elapsedSeconds: 0,
        }),
      /violates story-deliver-terminal\.schema\.json/,
    );
  });
});

describe('story-deliver-terminal — pending', () => {
  it('names the single command that resumes it and carries the wait budget', () => {
    const env = buildTerminalEnvelope({
      storyId: 4543,
      status: 'pending',
      phase: 'confirm-merge',
      pr: { number: 99, state: 'OPEN', checksStatus: 'pending' },
      nextCommand: NEXT_COMMANDS.resumeLand(4543),
      waitBudget: {
        maxWaitSeconds: 300,
        waitedSeconds: 300,
        cumulativeSeconds: 640,
        maxBudgetSeconds: 3600,
      },
      elapsedSeconds: 300,
    });
    assert.equal(exitCodeForTerminal(env), 3);
    assert.equal(env.nextCommand, NEXT_COMMANDS.resumeLand(4543));
    // Cumulative outruns this invocation's wait — proof the clock is
    // anchored outside the invocation and survives a resume.
    assert.ok(env.waitBudget.cumulativeSeconds > env.waitBudget.waitedSeconds);
    assert.equal(env.blocked, null);
  });
});

describe('story-deliver-terminal — blocked / failed', () => {
  it('blocked carries a shared-classifier class and a friction pointer', () => {
    const env = buildTerminalEnvelope({
      storyId: 4543,
      status: 'blocked',
      phase: 'confirm-merge',
      pr: { number: 99, state: 'OPEN', checksStatus: 'failure' },
      blocked: {
        blockClass: 'checks-failed',
        reason: 'a required check failed',
        frictionCommentId: '12345',
      },
      nextCommand: NEXT_COMMANDS.watchCi(4543, 99),
      elapsedSeconds: 30,
    });
    assert.equal(exitCodeForTerminal(env), 1);
    assert.equal(env.blocked.blockClass, 'checks-failed');
    assert.equal(env.blocked.frictionCommentId, '12345');
  });

  it('rejects a blocked terminal whose class is not from the shared classifier', () => {
    assert.throws(
      () =>
        buildTerminalEnvelope({
          storyId: 1,
          status: 'blocked',
          phase: 'confirm-merge',
          blocked: { blockClass: 'vibes', reason: 'felt wrong' },
          nextCommand: null,
          elapsedSeconds: 0,
        }),
      /violates story-deliver-terminal\.schema\.json/,
    );
  });

  it('the schema block-class enum stays a superset of the shared classifier vocabulary', () => {
    // A hand-maintained enum drifts from its classifier the moment someone
    // adds a class on one side only. `checks-failed` (Story #4543) is exactly
    // that case; pin the relationship so the next one fails here first.
    const schemaClasses = SCHEMA.properties.blocked.properties.blockClass.enum;
    for (const cls of MERGE_UNLANDED_BLOCK_CLASSES) {
      assert.ok(
        schemaClasses.includes(cls),
        `terminal schema is missing block class "${cls}" from merge-block-class.js`,
      );
    }
    // The merged-flip-failed terminal is not an unlanded attribution (the
    // merge landed) but is a legitimate blocked class on the envelope.
    assert.ok(schemaClasses.includes('merged-flip-failed'));
  });

  it('failed names the phase that crashed', () => {
    const env = buildTerminalEnvelope({
      storyId: 4543,
      status: 'failed',
      phase: 'close-validation',
      failure: { reason: 'lint gate threw: ENOENT' },
      nextCommand: NEXT_COMMANDS.close(4543),
      elapsedSeconds: 12,
    });
    assert.equal(exitCodeForTerminal(env), 1);
    assert.equal(env.phase, 'close-validation');
    assert.match(env.failure.reason, /lint gate threw/);
  });
});

describe('story-deliver-terminal — the PR block', () => {
  it('admits a null PR number (the unparseable-create-URL case)', () => {
    // `gh pr create` can return a URL the /pull/<n> parser cannot read. The
    // PR exists and its url is known, but nothing — including auto-merge —
    // can address it by number. The envelope must be able to say that rather
    // than fabricate a number or drop the PR entirely.
    const env = buildTerminalEnvelope({
      storyId: 4543,
      status: 'pending',
      phase: 'auto-merge',
      pr: {
        number: null,
        url: 'https://example.com/totally-not-a-pr',
        state: 'OPEN',
        autoMergeEnabled: false,
      },
      nextCommand: NEXT_COMMANDS.recover(4543),
      elapsedSeconds: 3,
    });
    assert.equal(env.pr.number, null);
    assert.equal(env.pr.autoMergeEnabled, false);
  });

  it('admits a null PR entirely for a phase that failed before one existed', () => {
    const env = buildTerminalEnvelope({
      storyId: 4543,
      status: 'failed',
      phase: 'close-validation',
      pr: null,
      failure: { reason: 'gate threw' },
      nextCommand: NEXT_COMMANDS.close(4543),
      elapsedSeconds: 1,
    });
    assert.equal(env.pr, null);
  });
});

describe('story-deliver-terminal — validation surface', () => {
  it('validateTerminalEnvelope reports the offending paths rather than a bare false', () => {
    const { valid, errors } = validateTerminalEnvelope({
      kind: 'story-deliver-terminal',
      storyId: 1,
      status: 'landed',
    });
    assert.equal(valid, false);
    assert.ok(errors.length > 0);
    assert.ok(errors.every((e) => typeof e === 'string'));
  });

  it('rejects unknown top-level fields so the contract cannot grow by accident', () => {
    const { valid } = validateTerminalEnvelope({
      kind: 'story-deliver-terminal',
      storyId: 1,
      status: 'landed',
      phase: 'done',
      nextCommand: null,
      elapsedSeconds: 0,
      surpriseField: true,
    });
    assert.equal(valid, false);
  });
});

describe('emitTerminalEnvelope — the contract payload is not level-gated', () => {
  const envelope = buildTerminalEnvelope({
    storyId: 42,
    status: 'landed',
    phase: 'done',
    nextCommand: null,
    elapsedSeconds: 1,
  });

  it('writes the envelope between its markers', () => {
    let out = '';
    emitTerminalEnvelope(envelope, { write: (s) => (out += s) });
    assert.ok(out.includes(TERMINAL_BEGIN_MARKER));
    assert.ok(out.includes(TERMINAL_END_MARKER));
    const body = out
      .split(TERMINAL_BEGIN_MARKER)[1]
      .split(TERMINAL_END_MARKER)[0];
    assert.deepEqual(JSON.parse(body), envelope);
  });

  it('still emits under AGENT_LOG_LEVEL=silent', () => {
    // The regression: the envelope used to go out via Logger.info, which is
    // a no-op at `silent` — a documented level (instructions.md § 1.H). A
    // headless caller got an exit code and no envelope: the "none at all"
    // outcome the envelope exists to remove. A verbosity knob must not be
    // able to suppress a machine contract.
    const previous = process.env.AGENT_LOG_LEVEL;
    setLevel('silent');
    try {
      let out = '';
      emitTerminalEnvelope(envelope, { write: (s) => (out += s) });
      assert.ok(
        out.includes(TERMINAL_BEGIN_MARKER),
        'envelope must survive AGENT_LOG_LEVEL=silent',
      );
      const body = out
        .split(TERMINAL_BEGIN_MARKER)[1]
        .split(TERMINAL_END_MARKER)[0];
      assert.equal(JSON.parse(body).status, 'landed');
    } finally {
      setLevel(previous ?? 'info');
    }
  });
});
