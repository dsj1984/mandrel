// tests/lib/orchestration/light-suitability.test.js
//
// Unit tier (Story #4740): /deliver-light — a validated single-session
// delivery path for genuinely small work that keeps every quality gate and the
// landing guarantee. This suite pins the four invariants that keep the light
// path proportional rather than a planning bypass, plus the thin-entry-point
// contract that it reuses the shared engine scripts:
//
//   - AC-1: the light path lands through the unchanged single-story-close
//           engine (buildNextCommands references it, no parallel close impl);
//   - AC-2: the suitability gate judges the predicted footprint via the shared
//           shape machinery plus a ledgered model verdict with a recorded
//           reason (deriveLightSuitability / resolveLedgeredVerdict);
//   - AC-3: over-scope STOPS and asks; under --yes it fails closed to /plan
//           (resolveLightGateOutcome);
//   - AC-4: a diff-derived backstop blocks over-ceiling actual diffs
//           (checkLightDiffBackstop / runDiffBackstop);
//   - AC-5: a minimal receipt type::story is authored inline carrying the
//           prompt and footprint (buildReceiptStoryTicket / createLightReceipt);
//   - AC-6: --amends is shape-checked identically (small → light, heavy → plan);
//   - AC-7: /deliver-light projects into the generated command tree;
//   - AC-8: the light entry contains no parallel init/close implementation.
//
// Story #4746 makes the escalate-plan OUTCOME terminal rather than advisory.
// The gate's decision is untouched (the describes above still pass verbatim);
// what is new is that over-scope under --yes emits a schema-validated
// `escalated` terminal envelope, starts nothing, and ends the session — see
// the final three describes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildNextCommands,
  buildPredictedChanges,
  createLightReceipt,
  parseCsvPaths,
  runDiffBackstop,
  runGateMode,
  runLightGate,
  synthesizeAcceptance,
} from '../../../.agents/scripts/deliver-light.js';
import {
  buildReceiptStoryTicket,
  checkLightDiffBackstop,
  deriveLightSuitability,
  LIGHT_DIFF_CEILINGS,
  resolveLedgeredVerdict,
  resolveLightGateOutcome,
} from '../../../.agents/scripts/lib/orchestration/light-suitability.js';
import {
  TERMINAL_BEGIN_MARKER,
  TERMINAL_END_MARKER,
  validateTerminalEnvelope,
} from '../../../.agents/scripts/lib/orchestration/story-deliver-terminal.js';
import { assertDocMentions, readDoc } from '../../helpers/doc-assert.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DELIVER_LIGHT_SRC = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'deliver-light.js',
);

/** Stand-in sensitive-path manifest, mirroring the review-depth fixtures. */
const RULES = {
  sensitivePaths: {
    security: { filePatterns: ['**/auth/**'] },
    billing: { filePatterns: ['**/billing/**'] },
  },
};

/** A ledgered lite verdict — the auditable claim the gate demands. */
const LITE_VERDICT = { route: 'lite', reason: 'one-file additive helper' };

// ---------------------------------------------------------------------------
// resolveLedgeredVerdict (AC-2) — a lite claim counts only when ledgered
// ---------------------------------------------------------------------------

describe('resolveLedgeredVerdict — lite only with a recorded reason (AC-2)', () => {
  test('a lite claim with a recorded reason is honored', () => {
    const v = resolveLedgeredVerdict(LITE_VERDICT);
    assert.equal(v.route, 'lite');
    assert.equal(v.recorded, true);
    assert.equal(v.reason, 'one-file additive helper');
  });

  test('a lite claim WITHOUT a recorded reason fails closed to full', () => {
    for (const reason of ['', '   ', undefined, null, 42]) {
      const v = resolveLedgeredVerdict({ route: 'lite', reason });
      assert.equal(v.route, 'full', `reason ${JSON.stringify(reason)}`);
      assert.equal(v.recorded, false);
      assert.equal(v.reason, null);
    }
  });

  test('a non-lite route is full regardless of reason', () => {
    const v = resolveLedgeredVerdict({ route: 'full', reason: 'whatever' });
    assert.equal(v.route, 'full');
  });

  test('is total: missing verdict yields a full route, never a throw', () => {
    assert.equal(resolveLedgeredVerdict().route, 'full');
    assert.equal(resolveLedgeredVerdict({}).route, 'full');
  });
});

// ---------------------------------------------------------------------------
// deriveLightSuitability (AC-2) — shape machinery AND ledgered verdict
// ---------------------------------------------------------------------------

describe('deriveLightSuitability — shape + ledgered verdict must agree (AC-2)', () => {
  test('a clearly-small prompt with a ledgered lite verdict is suitable', () => {
    const s = deriveLightSuitability({
      predictedChanges: [{ path: 'bin/hello.js', assumption: 'creates' }],
      predictedAcceptance: ['prints hello and exits 0'],
      verdict: LITE_VERDICT,
      injectedRules: RULES,
    });
    assert.equal(s.suitable, true);
    assert.equal(s.route, 'lite');
    assert.equal(s.shape.route, 'lite');
    assert.equal(s.ledger.route, 'lite');
  });

  test('an over-ceiling predicted footprint is not suitable (shape wins)', () => {
    const s = deriveLightSuitability({
      predictedChanges: [
        { path: 'a.js', assumption: 'refactors-existing' },
        { path: 'b.js', assumption: 'refactors-existing' },
        { path: 'c.js', assumption: 'refactors-existing' },
      ],
      predictedAcceptance: ['does a', 'does b', 'does c', 'does d'],
      verdict: LITE_VERDICT,
      injectedRules: RULES,
    });
    assert.equal(s.suitable, false);
    assert.equal(s.route, 'full');
    assert.equal(s.shape.route, 'full');
  });

  test('a sensitive-path footprint is not suitable even when small', () => {
    const s = deriveLightSuitability({
      predictedChanges: [
        { path: 'src/auth/session.js', assumption: 'creates' },
      ],
      predictedAcceptance: ['session refresh works'],
      verdict: LITE_VERDICT,
      injectedRules: RULES,
    });
    assert.equal(s.suitable, false);
    assert.equal(s.route, 'full');
  });

  test('a small shape with an UNLEDGERED verdict is not suitable (verdict wins)', () => {
    const s = deriveLightSuitability({
      predictedChanges: [{ path: 'bin/hello.js', assumption: 'creates' }],
      predictedAcceptance: ['prints hello'],
      verdict: { route: 'lite', reason: '' },
      injectedRules: RULES,
    });
    assert.equal(s.suitable, false);
    assert.equal(s.ledger.route, 'full');
  });

  test('is total: empty args yield a non-suitable full decision, never a throw', () => {
    const s = deriveLightSuitability();
    assert.equal(s.suitable, false);
    assert.equal(s.route, 'full');
  });
});

// ---------------------------------------------------------------------------
// resolveLightGateOutcome (AC-3) — over-scope stops, never lands silently
// ---------------------------------------------------------------------------

describe('resolveLightGateOutcome — over-scope STOPS and asks (AC-3)', () => {
  test('a suitable decision proceeds light', () => {
    const o = resolveLightGateOutcome({ suitability: { suitable: true } });
    assert.equal(o.action, 'proceed-light');
  });

  test('over-scope attended asks the operator to escalate or proceed', () => {
    const o = resolveLightGateOutcome({
      suitability: { suitable: false, reasons: ['over ceiling'] },
      yes: false,
    });
    assert.equal(o.action, 'ask-operator');
    assert.deepEqual(o.options, ['escalate-plan', 'proceed-light']);
  });

  test('over-scope under --yes fails closed to /plan (never proceeds light)', () => {
    const o = resolveLightGateOutcome({
      suitability: { suitable: false, reasons: ['over ceiling'] },
      yes: true,
    });
    assert.equal(o.action, 'escalate-plan');
    assert.notEqual(o.action, 'proceed-light');
  });

  test('is total: missing suitability defaults to ask-operator (attended)', () => {
    assert.equal(resolveLightGateOutcome().action, 'ask-operator');
  });
});

// ---------------------------------------------------------------------------
// checkLightDiffBackstop (AC-4) — the actual diff is the real scope signal
// ---------------------------------------------------------------------------

describe('checkLightDiffBackstop — blocks over-ceiling actual diffs (AC-4)', () => {
  test('a small non-sensitive diff is not blocked', () => {
    const r = checkLightDiffBackstop({
      changedFiles: ['bin/hello.js', 'tests/hello.test.js'],
      injectedRules: RULES,
    });
    assert.equal(r.blocked, false);
    assert.equal(r.level, 'low');
    assert.equal(r.fileCount, 2);
  });

  test('a diff exceeding the file-count ceiling is blocked', () => {
    const files = Array.from(
      { length: LIGHT_DIFF_CEILINGS.maxFiles + 1 },
      (_v, i) => `src/mod${i}.js`,
    );
    const r = checkLightDiffBackstop({
      changedFiles: files,
      injectedRules: RULES,
    });
    assert.equal(r.blocked, true);
    assert.match(r.reasons.join(' '), /maxFiles/);
  });

  test('a diff intersecting a sensitive-path class is blocked', () => {
    const r = checkLightDiffBackstop({
      changedFiles: ['src/auth/session.js'],
      injectedRules: RULES,
    });
    assert.equal(r.blocked, true);
    assert.deepEqual(r.classes, ['security']);
  });

  test('an empty or unknown change set is blocked (cannot verify light)', () => {
    for (const changedFiles of [[], null, undefined, 'x']) {
      const r = checkLightDiffBackstop({ changedFiles });
      assert.equal(r.blocked, true);
    }
  });

  test('honors a caller ceiling but rejects a malformed one', () => {
    const files = ['a.js', 'b.js', 'c.js'];
    assert.equal(
      checkLightDiffBackstop({
        changedFiles: files,
        ceilings: { maxFiles: 2 },
        injectedRules: RULES,
      }).blocked,
      true,
    );
    // A malformed ceiling falls back to the framework default (not 0/∞).
    assert.equal(
      checkLightDiffBackstop({
        changedFiles: files,
        ceilings: { maxFiles: 0 },
        injectedRules: RULES,
      }).ceilings.maxFiles,
      LIGHT_DIFF_CEILINGS.maxFiles,
    );
  });
});

// ---------------------------------------------------------------------------
// buildReceiptStoryTicket (AC-5) — the minimal receipt carries prompt + footprint
// ---------------------------------------------------------------------------

describe('buildReceiptStoryTicket — minimal receipt Story (AC-5)', () => {
  test('carries the prompt (goal + spec) and the diff-derived footprint', () => {
    const ticket = buildReceiptStoryTicket({
      prompt: 'Fix the footer copyright year',
      changedFiles: ['src/footer.js', 'tests/footer.test.js'],
    });
    assert.match(ticket.body.goal, /footer copyright year/);
    assert.match(ticket.body.spec, /Fix the footer copyright year/);
    assert.deepEqual(
      ticket.body.changes.map((c) => c.path),
      ['src/footer.js', 'tests/footer.test.js'],
    );
    assert.ok(ticket.body.acceptance.length >= 1);
    assert.ok(typeof ticket.slug === 'string' && ticket.slug.length > 0);
  });

  test('an amendment is prefixed and notes the amended issue', () => {
    const ticket = buildReceiptStoryTicket({
      prompt: 'tweak the label color',
      changedFiles: ['src/label.js'],
      amends: '#123',
    });
    assert.match(ticket.title, /^Amend #123:/);
    assert.match(ticket.body.goal, /Amends #123\./);
  });

  test('rejects an empty prompt — a receipt with nothing to record', () => {
    assert.throws(() => buildReceiptStoryTicket({ prompt: '' }), /prompt/);
    assert.throws(() => buildReceiptStoryTicket({}), /prompt/);
  });
});

// ---------------------------------------------------------------------------
// deliver-light.js entry helpers — CSV / predicted-shape parsing
// ---------------------------------------------------------------------------

describe('deliver-light entry helpers', () => {
  test('parseCsvPaths splits, trims, and drops empties', () => {
    assert.deepEqual(parseCsvPaths(' a.js , b.js ,,'), ['a.js', 'b.js']);
    assert.deepEqual(parseCsvPaths(''), []);
    assert.deepEqual(parseCsvPaths(undefined), []);
  });

  test('buildPredictedChanges tags creates vs refactors', () => {
    const changes = buildPredictedChanges({
      creates: ['a.js'],
      refactors: ['b.js'],
    });
    assert.deepEqual(changes, [
      { path: 'a.js', assumption: 'creates' },
      { path: 'b.js', assumption: 'refactors-existing' },
    ]);
  });

  test('synthesizeAcceptance yields at least one criterion', () => {
    assert.equal(synthesizeAcceptance(3).length, 3);
    assert.equal(synthesizeAcceptance(0).length, 1);
    assert.equal(synthesizeAcceptance(undefined).length, 1);
  });
});

// ---------------------------------------------------------------------------
// runLightGate + --amends (AC-3, AC-6) — shape-checked identically
// ---------------------------------------------------------------------------

describe('runLightGate — end-to-end gate over the entry inputs (AC-3, AC-6)', () => {
  test('a small prompt with a ledgered lite verdict proceeds light', () => {
    const gate = runLightGate({
      prompt: 'add a bin/hello.js greeter',
      creates: ['bin/hello.js'],
      acceptance: 1,
      route: 'lite',
      reason: 'single additive file',
      injectedRules: RULES,
    });
    assert.equal(gate.action, 'proceed-light');
  });

  test('a heavy prompt asks the operator (attended)', () => {
    const gate = runLightGate({
      prompt: 'rework the whole billing pipeline',
      refactors: ['src/billing/a.js', 'src/billing/b.js', 'src/billing/c.js'],
      acceptance: 5,
      route: 'lite',
      reason: 'claims small but is not',
      injectedRules: RULES,
    });
    assert.equal(gate.action, 'ask-operator');
  });

  test('--amends: a SMALL amendment routes light', () => {
    const gate = runLightGate({
      prompt: 'fix the off-by-one in the counter',
      refactors: ['src/counter.js'],
      acceptance: 1,
      route: 'lite',
      reason: 'one-line fix in an existing file',
      amends: '#4200',
      injectedRules: RULES,
    });
    assert.equal(gate.action, 'proceed-light');
  });

  test('--amends: a HEAVY amendment escalates to /plan under --yes', () => {
    const gate = runLightGate({
      prompt: 'amend: overhaul auth and add a migration',
      creates: ['src/auth/new.js'],
      acceptance: 2,
      route: 'lite',
      reason: 'claims small but touches auth',
      amends: '#4200',
      yes: true,
      injectedRules: RULES,
    });
    assert.equal(gate.action, 'escalate-plan');
  });
});

// ---------------------------------------------------------------------------
// buildNextCommands + createLightReceipt (AC-1, AC-5, AC-8) — same engine
// ---------------------------------------------------------------------------

describe('buildNextCommands — hands off to the shared engine (AC-1, AC-8)', () => {
  test('references single-story-init.js and single-story-close.js by name', () => {
    const cmds = buildNextCommands(4741);
    assert.match(cmds.init, /single-story-init\.js --story 4741/);
    assert.match(cmds.close, /single-story-close\.js --story 4741/);
  });
});

describe('createLightReceipt — authors the receipt via the plan-persist surface (AC-5)', () => {
  test('assembles the ticket and creates it through createStoryIssues', async () => {
    const calls = [];
    const provider = {
      createIssue: async (payload) => {
        calls.push(payload);
        return { id: 4741, url: 'https://example/4741' };
      },
    };
    const receipt = await createLightReceipt({
      provider,
      prompt: 'add a bin/hello.js greeter',
      changedFiles: ['bin/hello.js'],
    });
    assert.equal(receipt.storyId, 4741);
    assert.equal(calls.length, 1);
    assert.match(calls[0].body, /add a bin\/hello\.js greeter/);
  });
});

// ---------------------------------------------------------------------------
// runDiffBackstop (AC-4) — wraps computeChangeSet over the Story branch
// ---------------------------------------------------------------------------

describe('runDiffBackstop — re-checks the ACTUAL branch diff (AC-4)', () => {
  test('a clean small diff is not blocked', () => {
    const r = runDiffBackstop({
      storyId: 4741,
      injectedRules: RULES,
      computeFn: () => ({ files: ['bin/hello.js'] }),
    });
    assert.equal(r.blocked, false);
  });

  test('an over-ceiling diff is blocked', () => {
    const r = runDiffBackstop({
      storyId: 4741,
      injectedRules: RULES,
      computeFn: () => ({
        files: ['src/auth/a.js', 'b.js', 'c.js', 'd.js', 'e.js'],
      }),
    });
    assert.equal(r.blocked, true);
  });

  test('an unenumerable diff (files: null) is blocked', () => {
    const r = runDiffBackstop({
      storyId: 4741,
      computeFn: () => ({ files: null }),
    });
    assert.equal(r.blocked, true);
  });
});

// ---------------------------------------------------------------------------
// AC-8 — the light entry contains NO parallel init/close implementation
// ---------------------------------------------------------------------------

describe('deliver-light.js is a thin entry point, not a second engine (AC-8)', () => {
  const src = readFileSync(DELIVER_LIGHT_SRC, 'utf8');

  test('names the shared engine scripts it hands off to', () => {
    assert.match(src, /single-story-init\.js/);
    assert.match(src, /single-story-close\.js/);
  });

  test('does not reimplement worktree / branch / PR / push mechanics', () => {
    const forbidden = [
      /worktree add/,
      /checkout -b/,
      /git push/,
      /createPullRequest/,
      /git branch /,
    ];
    for (const pat of forbidden) {
      assert.doesNotMatch(
        src,
        pat,
        `deliver-light.js must not reimplement engine mechanics (${pat})`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Story #4746 — escalation is TERMINAL, not advisory
// ---------------------------------------------------------------------------

/** Over-scope gate inputs: 7 predicted changes against a maxChanges of 2. */
const OVER_SCOPE = {
  prompt: 'rework the whole reporting pipeline end to end',
  refactors: Array.from({ length: 7 }, (_v, i) => `src/report/mod${i}.js`).join(
    ',',
  ),
  acceptance: '5',
  route: 'lite',
  reason: 'claims small but is not',
};

/**
 * Drive `runGateMode` with every side-effecting seam replaced by a spy, so a
 * test can assert not merely that the envelope SAYS nothing was created but
 * that the code never reached the call sites that would create anything.
 *
 * @param {object} values
 * @returns {Promise<{ code: number, terminals: object[], gateEnvelopes: object[], created: number, providers: number }>}
 */
async function driveGate(values) {
  const terminals = [];
  const gateEnvelopes = [];
  let created = 0;
  let providers = 0;
  const code = await runGateMode(values, {
    createProviderFn: () => {
      providers += 1;
      return {};
    },
    resolveConfigFn: () => ({}),
    createReceiptFn: async () => {
      created += 1;
      return { storyId: 1, url: 'https://example/1', title: 't' };
    },
    emitFn: (envelope) => gateEnvelopes.push(envelope),
    emitTerminalFn: (envelope) => terminals.push(envelope),
  });
  return { code, terminals, gateEnvelopes, created, providers };
}

describe('escalate-plan emits a terminal envelope and exits non-zero (AC-1)', () => {
  test('the envelope is schema-valid, escalated, and names the /plan next command', async () => {
    const { code, terminals, gateEnvelopes } = await driveGate({
      ...OVER_SCOPE,
      yes: true,
    });

    assert.equal(terminals.length, 1, 'exactly one terminal envelope');
    const env = terminals[0];
    assert.equal(validateTerminalEnvelope(env).valid, true);
    assert.equal(env.kind, 'story-deliver-terminal');
    assert.equal(env.status, 'escalated');
    assert.equal(env.phase, 'suitability-gate');
    assert.match(env.nextCommand, /^\/plan "/);
    assert.match(env.nextCommand, /reporting pipeline/);

    // Non-zero: a caller must not be able to read escalation as success.
    assert.notEqual(code, 0);
    assert.equal(code, 2);

    // The terminal replaces the walk-past-able gate envelope; it does not
    // accompany it. One session, one terminal output.
    assert.equal(gateEnvelopes.length, 0);
  });

  test('the gate reasons survive verbatim into the envelope', async () => {
    const { terminals } = await driveGate({ ...OVER_SCOPE, yes: true });
    const reasons = terminals[0].escalation.reasons.join(' ');
    assert.match(reasons, /maxChanges/);
    assert.match(reasons, /--yes on over-scope fails closed to \/plan/);
  });
});

describe('an escalated run starts nothing (AC-2)', () => {
  test('never reaches the receipt-Story call site', async () => {
    const { created, providers } = await driveGate({
      ...OVER_SCOPE,
      yes: true,
    });
    assert.equal(created, 0, 'no receipt Story may be authored');
    assert.equal(
      providers,
      0,
      'the escalate path must not even build a provider',
    );
  });

  test('the envelope records no Story, no branch, and no worktree', async () => {
    const { terminals } = await driveGate({ ...OVER_SCOPE, yes: true });
    const env = terminals[0];
    assert.equal(env.storyId, null, 'an escalated run names no Story');
    assert.deepEqual(env.escalation.created, {
      receiptStory: false,
      storyBranch: false,
      worktree: false,
    });
  });

  test('end to end from a NON-repo cwd: no git, no GitHub, still terminal', () => {
    // The strongest available pin on "nothing was started": run the real CLI
    // somewhere with no git repository at all. Anything that cut a branch,
    // materialized a worktree, or resolved repo config would fail here; a
    // clean exit 2 with a valid envelope proves the path did none of it.
    const cwd = mkdtempSync(path.join(tmpdir(), 'light-escalate-'));
    const result = spawnSync(
      process.execPath,
      [
        DELIVER_LIGHT_SRC,
        '--prompt',
        OVER_SCOPE.prompt,
        '--refactors',
        OVER_SCOPE.refactors,
        '--acceptance',
        OVER_SCOPE.acceptance,
        '--route',
        'lite',
        '--reason',
        OVER_SCOPE.reason,
        '--yes',
      ],
      { cwd, encoding: 'utf8' },
    );

    assert.equal(result.status, 2, result.stderr);
    assert.ok(!existsSync(path.join(cwd, '.worktrees')), 'no worktree');
    assert.ok(!existsSync(path.join(cwd, '.git')), 'no repo touched');

    const body = result.stdout
      .split(TERMINAL_BEGIN_MARKER)[1]
      ?.split(TERMINAL_END_MARKER)[0];
    assert.ok(body, 'the terminal envelope must be recoverable from stdout');
    const env = JSON.parse(body);
    assert.equal(env.status, 'escalated');
    assert.equal(env.storyId, null);
    assert.equal(validateTerminalEnvelope(env).valid, true);
  });
});

describe('the attended over-scope path is UNCHANGED (AC-4)', () => {
  test('still asks the operator to choose, with no terminal envelope', async () => {
    const { code, terminals, gateEnvelopes, created } = await driveGate({
      ...OVER_SCOPE,
      yes: false,
    });

    // A question, not a terminal — emitting one would end a session that is
    // supposed to be waiting for the operator's answer.
    assert.equal(terminals.length, 0);
    assert.equal(gateEnvelopes.length, 1);
    assert.equal(gateEnvelopes[0].action, 'ask-operator');
    assert.deepEqual(gateEnvelopes[0].outcome.options, [
      'escalate-plan',
      'proceed-light',
    ]);
    assert.equal(code, 2);
    assert.equal(created, 0);
  });

  test('proceed-light is likewise untouched — receipt authored, no terminal', async () => {
    const { code, terminals, gateEnvelopes, created } = await driveGate({
      prompt: 'add a bin/hello.js greeter',
      creates: 'bin/hello.js',
      acceptance: '1',
      route: 'lite',
      reason: 'single additive file',
      yes: true,
    });
    assert.equal(code, 0);
    assert.equal(created, 1);
    assert.equal(terminals.length, 0);
    assert.equal(gateEnvelopes[0].action, 'proceed-light');
  });
});

describe('the workflow states escalation is terminal (AC-3)', () => {
  // Prose assertions go through doc-assert: these claims are about what the
  // document SAYS, and a plain `assert.match` would silently also be pinning
  // where the 80-column wrap happens to fall.
  const doc = readDoc(
    path.join(REPO_ROOT, '.agents', 'workflows', 'deliver-light.md'),
  );

  test('names the envelope as the session terminal output', () => {
    assertDocMentions(
      doc,
      /envelope IS this session's terminal output/i,
      'the workflow must state the escalated envelope IS the terminal output',
    );
    assertDocMentions(doc, /status.{0,4}:.{0,4}"?escalated/i);
  });

  test('forbids invoking /plan in the same session', () => {
    // `?` around the code span: this pins what the doc SAYS, not whether
    // /plan happens to be code-formatted at that call site.
    assertDocMentions(
      doc,
      /Invoking `?\/plan`? in this same session is forbidden/i,
      'in-session /plan must be forbidden in so many words',
    );
    assertDocMentions(doc, /`?\/plan`? runs in a \*\*fresh\*\* session/i);
  });

  test('records the empirical reason so the rule reads as load-bearing', () => {
    // Without the measurement this is style; with it, it is a finding. Pin
    // the numbers themselves — a doc that kept the word "empirically" but
    // dropped the 1-vs-4 comparison would have lost exactly what makes the
    // rule persuasive to the next session reading it.
    assertDocMentions(doc, /mandrel-bench/i);
    assertDocMentions(
      doc,
      /authored \*\*one\*\* Story against the scenario's 3[–-]5 contract/i,
      'the under-decomposition finding must name what in-session planning produced',
    );
    assertDocMentions(
      doc,
      /fresh `?\/plan`? session on the identical seed authored \*\*four\*\*/i,
      'the finding is only load-bearing next to the fresh-session comparison',
    );
    assertDocMentions(doc, /under-decompos/i);
  });

  test('states that an escalated run leaves no Story, branch, or worktree', () => {
    assertDocMentions(
      doc,
      /no receipt Story, no `story-<id>` branch, and no worktree/i,
      'the workflow must name all three artifacts an escalated run does not create',
    );
  });
});

// ---------------------------------------------------------------------------
// AC-7 — /deliver-light projects into the generated command tree
// ---------------------------------------------------------------------------

describe('/deliver-light projects via sync-claude-commands (AC-7)', () => {
  test('the sync script writes .claude/commands/deliver-light.md', () => {
    const dest = mkdtempSync(path.join(tmpdir(), 'light-cmd-'));
    const result = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, '.agents', 'scripts', 'sync-claude-commands.js')],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          SYNC_CLAUDE_COMMANDS_SRC: path.join(
            REPO_ROOT,
            '.agents',
            'workflows',
          ),
          SYNC_CLAUDE_COMMANDS_DEST: dest,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      existsSync(path.join(dest, 'deliver-light.md')),
      'deliver-light.md was not projected into the command tree',
    );
  });
});
