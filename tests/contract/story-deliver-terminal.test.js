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
 *   - the status enum is exactly landed | pending | blocked | failed |
 *     escalated, and the builder rejects anything else — no status can be
 *     smuggled in without landing here first (Story #4746 added `escalated`
 *     deliberately, and this suite is where that had to be argued);
 *   - `escalated` is the pre-Story terminal: storyId null, an escalation block
 *     whose `created` flags are structurally false, and its own exit code;
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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setLevel } from '../../.agents/scripts/lib/Logger.js';
import { MERGE_UNLANDED_BLOCK_CLASSES } from '../../.agents/scripts/lib/orchestration/merge-block-class.js';
import {
  buildEscalationTerminal,
  buildTerminalEnvelope,
  emitTerminalEnvelope,
  exitCodeForTerminal,
  NEXT_COMMANDS,
  persistTerminalEnvelope,
  TERMINAL_BEGIN_MARKER,
  TERMINAL_END_MARKER,
  TERMINAL_ENVELOPE_KIND,
  TERMINAL_EXIT_CODES,
  TERMINAL_STATUSES,
  validateTerminalEnvelope,
} from '../../.agents/scripts/lib/orchestration/story-deliver-terminal.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(
  fs.readFileSync(
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
  tempPurge: true,
  leaseRelease: true,
  epicRollup: true,
};

describe('story-deliver-terminal — the status contract', () => {
  it('the schema admits exactly these five statuses, and no more', () => {
    // A closed list, not a growing one. Story #4746 added `escalated` because
    // /deliver-light needed an outcome that ends a session before a Story
    // exists; the point of pinning the list is that the next addition has to
    // be argued here rather than appearing in a diff nobody reads.
    assert.deepEqual(SCHEMA.properties.status.enum, [
      'landed',
      'pending',
      'blocked',
      'failed',
      'escalated',
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
    // Story #4746 — escalation delivered nothing, so it must not read as a
    // land; it is also not a block, so it must not be diagnosed as one.
    assert.equal(TERMINAL_EXIT_CODES.escalated, 2);
    assert.notEqual(TERMINAL_EXIT_CODES.escalated, TERMINAL_EXIT_CODES.landed);
    assert.notEqual(TERMINAL_EXIT_CODES.escalated, TERMINAL_EXIT_CODES.blocked);
  });
});

describe('story-deliver-terminal — escalated (Story #4746)', () => {
  const ESCALATION_REASONS = [
    'shape: changes[] declares 7 entries (> maxChanges 2)',
    '--yes on over-scope fails closed to /mandrel-plan (never silently proceeds light)',
  ];

  it('is the pre-Story terminal: null storyId, /mandrel-plan next command, exit 2', () => {
    const env = buildEscalationTerminal({
      prompt: 'rework the whole billing pipeline',
      reasons: ESCALATION_REASONS,
      elapsedSeconds: 0.4,
    });
    assert.equal(env.status, 'escalated');
    assert.equal(env.phase, 'suitability-gate');
    assert.equal(env.storyId, null);
    assert.equal(exitCodeForTerminal(env), 2);
    assert.match(env.nextCommand, /^\/mandrel-plan "/);
    assert.match(env.nextCommand, /billing pipeline/);
    assert.deepEqual(env.escalation.reasons, ESCALATION_REASONS);
  });

  it('records per artifact that nothing was started, and cannot claim otherwise', () => {
    const env = buildEscalationTerminal({
      prompt: 'overhaul auth',
      reasons: ESCALATION_REASONS,
    });
    assert.deepEqual(env.escalation.created, {
      receiptStory: false,
      storyBranch: false,
      worktree: false,
    });
    // The flags are pinned by the schema, not merely produced by the builder:
    // an envelope asserting it authored a receipt Story is unbuildable.
    const { valid } = validateTerminalEnvelope({
      ...env,
      escalation: {
        ...env.escalation,
        created: { ...env.escalation.created, receiptStory: true },
      },
    });
    assert.equal(
      valid,
      false,
      'an escalated run must not be able to claim it created a Story',
    );
  });

  it('refuses to name a Story it did not create', () => {
    const { valid } = validateTerminalEnvelope({
      kind: TERMINAL_ENVELOPE_KIND,
      storyId: 4746,
      status: 'escalated',
      phase: 'suitability-gate',
      escalation: {
        reasons: ESCALATION_REASONS,
        created: { receiptStory: false, storyBranch: false, worktree: false },
      },
      nextCommand: '/mandrel-plan "x"',
      elapsedSeconds: 0,
    });
    assert.equal(valid, false);
  });

  it('keeps the escalation block out of every other status', () => {
    const { valid } = validateTerminalEnvelope({
      kind: TERMINAL_ENVELOPE_KIND,
      storyId: 4746,
      status: 'landed',
      phase: 'post-land',
      escalation: {
        reasons: ['sneaking in'],
        created: { receiptStory: false, storyBranch: false, worktree: false },
      },
      nextCommand: null,
      elapsedSeconds: 1,
    });
    assert.equal(valid, false);
  });

  it('still requires an integer storyId for the four Story-bearing statuses', () => {
    for (const status of ['landed', 'pending', 'blocked', 'failed']) {
      const { valid } = validateTerminalEnvelope({
        kind: TERMINAL_ENVELOPE_KIND,
        storyId: null,
        status,
        phase: 'confirm-merge',
        nextCommand: null,
        elapsedSeconds: 0,
      });
      assert.equal(valid, false, `${status} must still name its Story`);
    }
  });

  it('refuses an escalation with no prompt to hand /mandrel-plan', () => {
    // `/mandrel-plan ""` is the walk-past-able non-outcome in envelope clothing.
    assert.throws(
      () =>
        buildEscalationTerminal({ prompt: '   ', reasons: ESCALATION_REASONS }),
      /non-empty prompt is required/,
    );
  });

  it('quotes the prompt so it cannot break out of the next command', () => {
    const env = buildEscalationTerminal({
      prompt: 'add "smart" quotes\nand a \\ backslash',
      reasons: ESCALATION_REASONS,
    });
    assert.equal(env.nextCommand.split('\n').length, 1);
    assert.match(env.nextCommand, /\\"smart\\"/);
    assert.match(env.nextCommand, /\\\\ backslash/);
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
      [
        'baseFastForward',
        'epicRollup',
        'followUps',
        'leaseRelease',
        'refCleanup',
        'statusResync',
        'tempPurge',
      ],
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

  it('a blocked envelope carrying advisory-gate-inconclusive validates (Story #5266)', () => {
    // The class is emitted DIRECTLY by the arm and merge-wait phases — the
    // classifier cannot produce it — so nothing but this schema enum stands
    // between a real block and an unvalidatable envelope.
    const env = buildTerminalEnvelope({
      storyId: 5266,
      status: 'blocked',
      phase: 'confirm-merge',
      blocked: {
        blockClass: 'advisory-gate-inconclusive',
        reason: 'the advisory scan did not finish',
      },
      nextCommand: null,
      elapsedSeconds: 12,
    });
    assert.equal(env.blocked.blockClass, 'advisory-gate-inconclusive');
    assert.equal(exitCodeForTerminal(env), 1);
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

describe('story-deliver-terminal — the schema outlives the schema FILE', () => {
  // The regression: `single-story-close.js` invoked by a worktree-relative
  // path runs the WORKTREE's copy of the script and then reaps that worktree
  // as one of its own phases. The schema used to be read lazily, on the first
  // envelope build — which happens AFTER the reap — so the read hit a path
  // that no longer existed. It threw inside `failedTerminalFor`, meaning a
  // Story whose PR had merged, whose label had flipped to `agent::done`, and
  // whose post-land tail was green exited non-zero emitting NO envelope at
  // all. The engine's documented return contract was lost to a success.
  //
  // Two independent guarantees close it, and this block pins both: the read
  // happens at import (so the file's later disappearance is irrelevant), and
  // an unusable schema degrades to an unvalidated envelope rather than to no
  // envelope.

  const LANDED = {
    storyId: 4784,
    status: 'landed',
    phase: 'done',
    storyBranch: 'story-4784',
    baseBranch: 'main',
    pr: {
      number: 4788,
      url: 'https://example.test/pull/4788',
      state: 'MERGED',
    },
    tail: CLEAN_TAIL,
    nextCommand: null,
    elapsedSeconds: 12,
  };

  /** Break every filesystem read, the way a reaped worktree does. */
  function withNoFilesystem(fn) {
    mock.method(fs, 'readFileSync', () => {
      throw new Error('ENOENT: no such file or directory (reaped worktree)');
    });
    try {
      assert.throws(
        () => fs.readFileSync('/anything'),
        /ENOENT/,
        'the filesystem stub must actually be in force',
      );
      return fn();
    } finally {
      mock.restoreAll();
    }
  }

  it('validates with the filesystem gone — the schema is read at IMPORT', async () => {
    // A FRESH instance of the module that OWNS the read, deliberately. The
    // cached one compiled its validator during an earlier test, so it would
    // survive a lost filesystem no matter when it read the schema — which is
    // exactly how a lazy read hides from a suite until production reaps a
    // worktree. Import fresh while the filesystem is healthy, break the
    // filesystem, then validate: only an import-time read survives that
    // sequence.
    const fresh = await import(
      `${
        new URL(
          '../../.agents/scripts/lib/orchestration/story-deliver-terminal-schema.js',
          import.meta.url,
        ).href
      }?eager-schema-probe`
    );
    const envelope = buildTerminalEnvelope(LANDED);

    withNoFilesystem(() => {
      const result = fresh.validateTerminalEnvelope(envelope);
      // `validated: true`, not merely `valid` — the degrade path did NOT
      // fire, which is what proves the schema was already in memory.
      assert.equal(
        result.validated,
        true,
        'the eagerly-loaded schema is what validated this envelope',
      );
      assert.equal(result.valid, true);
    });
  });

  it('builds an envelope after the filesystem stops answering', () => {
    // The writer-level composition of the same guarantee: assembling a
    // terminal must touch no file at all, whatever state the tree is in.
    withNoFilesystem(() => {
      const envelope = buildTerminalEnvelope(LANDED);
      assert.equal(envelope.status, 'landed');
      assert.equal(envelope.storyId, 4784);
    });
  });

  it('degrades to an UNVALIDATED envelope when the schema cannot be read', () => {
    // Belt to the eager-load brace: if the schema is ever unavailable anyway
    // — a partial install, a truncated file — the run must still get its
    // terminal. An envelope a caller can act on beats a lost contract.
    const unreadable = {
      schema: null,
      error: 'ENOENT: no such file or directory',
    };
    const envelope = buildTerminalEnvelope({
      ...LANDED,
      schemaSource: unreadable,
    });
    assert.equal(envelope.status, 'landed');
    assert.equal(envelope.nextCommand, null);

    const degraded = validateTerminalEnvelope(envelope, {
      schemaSource: unreadable,
    });
    assert.equal(
      degraded.validated,
      false,
      'the degrade is reported, not hidden',
    );
    assert.equal(degraded.valid, true);

    // And the envelope it emitted unchecked is in fact well-formed — the
    // degrade skips the check, it does not lower the shape.
    const rechecked = validateTerminalEnvelope(envelope);
    assert.equal(rechecked.validated, true);
    assert.deepEqual(rechecked.errors, []);
    assert.equal(rechecked.valid, true);
  });

  it('still throws on a genuine schema VIOLATION — the degrade is scoped to an unreadable schema', () => {
    // The distinction that has to hold: "I cannot check this envelope" is
    // survivable; "this envelope is wrong" is not. Collapsing the two would
    // trade one silent failure for another.
    assert.throws(
      () =>
        buildTerminalEnvelope({
          ...LANDED,
          status: 'landed',
          storyId: null,
        }),
      /violates story-deliver-terminal\.schema\.json/,
    );
  });

  it('reports validated: true on the normal path', () => {
    const result = validateTerminalEnvelope(buildTerminalEnvelope(LANDED));
    assert.equal(result.validated, true);
    assert.equal(result.valid, true);
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
    // Story #4685 — the contract payload is compact (single-line), not the
    // former 2-space pretty JSON, so it stops paying per-turn cache rent.
    assert.equal(body.trim().split('\n').length, 1, 'envelope JSON is compact');
  });

  it('still emits under AGENT_LOG_LEVEL=silent', () => {
    // The regression: the envelope used to go out via Logger.info, which is
    // a no-op at `silent` — a documented level (execution-reference.md
    // § Log-level control). A
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

describe('persistTerminalEnvelope — the envelope outlives its turn (#4816)', () => {
  /**
   * A config whose tempRoot is an absolute scratch dir, so every assertion
   * below reads a real file without going anywhere near the repo tree.
   */
  function scratchConfig() {
    const root = makeTempDir('terminal-persist-');
    return {
      root,
      config: { project: { paths: { tempRoot: root } } },
      envelopePath: (sid) =>
        path.join(root, 'orchestration', `story-deliver-terminal-${sid}.json`),
    };
  }

  const pending = buildTerminalEnvelope({
    storyId: 4816,
    status: 'pending',
    phase: 'confirm-merge',
    nextCommand: NEXT_COMMANDS.resumeLand(4816),
    elapsedSeconds: 12,
  });

  it('writes the same object the stdout markers carry', () => {
    // The whole point: an orphaned turn costs a file read, not a recovery
    // round trip. That only holds if the file IS the envelope, byte for byte
    // in content — not a summary of it.
    const { config, envelopePath } = scratchConfig();
    let out = '';
    emitTerminalEnvelope(pending, { write: (s) => (out += s) });
    emitTerminalEnvelope(pending, { write: (s) => (out += s), config });
    const onDisk = JSON.parse(fs.readFileSync(envelopePath(4816), 'utf8'));
    const onStdout = JSON.parse(
      out.split(TERMINAL_BEGIN_MARKER).pop().split(TERMINAL_END_MARKER)[0],
    );
    assert.deepEqual(onDisk, onStdout);
    assert.deepEqual(onDisk, pending);
  });

  it('returns the path it wrote and creates the directory for it', () => {
    const { config, envelopePath } = scratchConfig();
    const written = persistTerminalEnvelope(pending, { config });
    assert.equal(written, envelopePath(4816));
    assert.ok(fs.existsSync(written));
  });

  it('overwrites the previous run rather than accumulating copies', () => {
    // A Story can be closed more than once (a `pending` wait resumed, a red
    // gate fixed). The reader wants the CURRENT verdict, so last write wins
    // and the directory holds exactly one file per Story.
    const { root, config, envelopePath } = scratchConfig();
    persistTerminalEnvelope(pending, { config });
    const landed = buildTerminalEnvelope({
      storyId: 4816,
      status: 'landed',
      phase: 'done',
      nextCommand: null,
      elapsedSeconds: 30,
    });
    persistTerminalEnvelope(landed, { config });
    assert.equal(
      JSON.parse(fs.readFileSync(envelopePath(4816), 'utf8')).status,
      'landed',
    );
    assert.deepEqual(fs.readdirSync(path.join(root, 'orchestration')), [
      'story-deliver-terminal-4816.json',
    ]);
  });

  it('renames into place so a reader never parses a partial file', () => {
    // The reader that matters most is a router polling during a live close.
    // Handing it a truncated JSON at exactly the moment it is trying to stop
    // guessing would be worse than handing it nothing.
    const writes = [];
    const renames = [];
    const fsImpl = {
      mkdirSync: () => {},
      writeFileSync: (target, body) => writes.push({ target, body }),
      renameSync: (from, to) => renames.push({ from, to }),
      rmSync: () => {},
    };
    const written = persistTerminalEnvelope(pending, {
      config: { project: { paths: { tempRoot: path.join(os.tmpdir(), 'x') } } },
      fsImpl,
    });
    assert.equal(writes.length, 1);
    assert.equal(renames.length, 1);
    assert.notEqual(
      writes[0].target,
      written,
      'the payload is written to a scratch name, never the final path',
    );
    assert.equal(renames[0].from, writes[0].target);
    assert.equal(renames[0].to, written);
  });

  it('never costs a close its return when the write fails', () => {
    // Best-effort is the contract. A landed PR must not become a crash
    // because a temp directory was unwritable.
    const fsImpl = {
      mkdirSync: () => {
        throw new Error('EACCES: read-only file system');
      },
      writeFileSync: () => {},
      renameSync: () => {},
      rmSync: () => {},
    };
    assert.equal(persistTerminalEnvelope(pending, { fsImpl }), null);

    let out = '';
    emitTerminalEnvelope(pending, {
      write: (s) => (out += s),
      persist: () => {
        throw new Error('should never propagate');
      },
    });
    assert.ok(out.includes(TERMINAL_BEGIN_MARKER));
  });

  it('cleans up the scratch file when the rename fails', () => {
    const removed = [];
    const fsImpl = {
      mkdirSync: () => {},
      writeFileSync: () => {},
      renameSync: () => {
        throw new Error('EXDEV');
      },
      rmSync: (target) => removed.push(target),
    };
    assert.equal(persistTerminalEnvelope(pending, { fsImpl }), null);
    assert.equal(removed.length, 1);
    assert.ok(removed[0].endsWith('.tmp'));
  });

  it('writes nothing for an escalated terminal, which has no Story id', () => {
    const { root, config } = scratchConfig();
    const escalated = buildEscalationTerminal({ prompt: 'add a --json flag' });
    assert.equal(escalated.storyId, null);
    assert.equal(persistTerminalEnvelope(escalated, { config }), null);
    assert.equal(fs.existsSync(path.join(root, 'orchestration')), false);
  });

  it('degrades to the default temp root when the config cannot be read', () => {
    // An unreadable .agentrc must not cost the run its copy: the fallback
    // root is still far better than no artifact at all.
    const seen = [];
    const fsImpl = {
      mkdirSync: (dir) => seen.push(dir),
      writeFileSync: () => {},
      renameSync: () => {},
      rmSync: () => {},
    };
    const written = persistTerminalEnvelope(pending, {
      fsImpl,
      resolveConfigImpl: () => {
        throw new Error('unparseable .agentrc.json');
      },
    });
    assert.ok(written, 'a broken config still yields a persisted path');
    assert.equal(seen.length, 1);
    assert.ok(written.endsWith('story-deliver-terminal-4816.json'));
  });

  it('is invoked by emitTerminalEnvelope, so no emit site can forget it', () => {
    // The single-writer property is the design: four emit sites, one place
    // that persists. A future fifth site inherits it for free.
    const calls = [];
    emitTerminalEnvelope(pending, {
      write: () => {},
      config: { marker: true },
      persist: (envelope, opts) => calls.push({ envelope, opts }),
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].envelope, pending);
    assert.deepEqual(calls[0].opts.config, { marker: true });
  });
});
