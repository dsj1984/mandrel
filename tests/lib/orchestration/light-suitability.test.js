// tests/lib/orchestration/light-suitability.test.js
//
// Unit tier (Story #4740): the light path — a validated single-session
// delivery route for genuinely small work that keeps every quality gate and the
// landing guarantee. This suite pins the four invariants that keep the light
// path proportional rather than a planning bypass, plus the thin-entry-point
// contract that it reuses the shared engine scripts.
//
// Story #4760 folded it into `/mandrel-deliver` as a routed prompt path (and a second
// caller, `/mandrel-plan` Gate #1); the gate logic below is untouched by that move.
//
//   - AC-1: the light path lands through the unchanged single-story-close
//           engine (buildNextCommands references it, no parallel close impl);
//   - AC-2: the suitability gate judges the predicted footprint via the shared
//           shape machinery plus a ledgered model verdict with a recorded
//           reason (deriveLightSuitability / resolveLedgeredVerdict);
//   - AC-3: over-scope STOPS and asks; under --yes it fails closed to /mandrel-plan
//           (resolveLightGateOutcome);
//   - AC-4: a diff-derived backstop blocks over-ceiling actual diffs
//           (checkLightDiffBackstop / runDiffBackstop);
//   - AC-5: a minimal receipt type::story is authored inline carrying the
//           prompt and footprint (buildReceiptStoryTicket / createLightReceipt);
//   - AC-6: --amends is shape-checked identically (small → light, heavy → plan);
//   - AC-7: (amended by Story #4760) the light path does NOT project a command
//           — it moved under helpers/ so `/mandrel-deliver` is the one delivery door;
//   - AC-8: the light entry contains no parallel init/close implementation.
//
// Story #4764 re-anchored the suitability gate off artifact cardinality, and
// Story #5344 finished the job: the declared effort axes (change kinds,
// magnitude, uncertainty, deployable span) and the `warnings[]` Story #5313 had
// demoted them to are gone. What the gate reads now is evidence rather than a
// self-declaration — the predicted PATHS, for the two absolute risk rules — and
// a ledgered reason. Size is bounded by the diff backstop alone.
//
// Story #4746 makes the escalate-plan OUTCOME terminal rather than advisory.
// The gate's decision is untouched (the describes above still pass verbatim);
// what is new is that over-scope under --yes emits a schema-validated
// `escalated` terminal envelope, starts nothing, and ends the session — see
// the final three describes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildNextCommands,
  buildPredictedChanges,
  createLightReceipt,
  parseCsvPaths,
  runGateMode,
  runLightGate,
} from '../../../.agents/scripts/deliver-light.js';
import { TEST_TEMP_ROOT_ENV } from '../../../.agents/scripts/lib/config/temp-paths.js';
import {
  lightScopeRejectedCategory,
  RUNTIME_FRICTION_CATEGORIES,
} from '../../../.agents/scripts/lib/observability/runtime-friction.js';
import { resolveBackstopOutcome } from '../../../.agents/scripts/lib/orchestration/light-backstop.js';
import {
  handleBlockedBackstop,
  preserveRefusedWork,
  recordGateRefusal,
} from '../../../.agents/scripts/lib/orchestration/light-escalation.js';
import {
  buildReceiptStoryTicket,
  checkLightDiffBackstop,
  deriveLightSuitability,
  LIGHT_DIFF_CEILINGS,
  LIGHT_REFUSAL_CLASSES,
  resolveLedgeredVerdict,
  resolveLightGateOutcome,
} from '../../../.agents/scripts/lib/orchestration/light-suitability.js';
import { DEFAULT_DIFF_WIDTH } from '../../../.agents/scripts/lib/orchestration/review-depth.js';
import {
  TERMINAL_BEGIN_MARKER,
  TERMINAL_END_MARKER,
  validateTerminalEnvelope,
} from '../../../.agents/scripts/lib/orchestration/story-deliver-terminal.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';
import {
  assertDocMentions,
  assertDocOmits,
  readDoc,
} from '../../helpers/doc-assert.js';

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

/** A ledgered light verdict — the auditable claim the gate demands. */
const LITE_VERDICT = { reason: 'one-file additive helper' };

// ---------------------------------------------------------------------------
// resolveLedgeredVerdict (AC-2) — a lite claim counts only when ledgered
// ---------------------------------------------------------------------------

describe('resolveLedgeredVerdict — light only with a recorded reason (AC-2)', () => {
  test('a verdict with a recorded reason is honored', () => {
    const v = resolveLedgeredVerdict(LITE_VERDICT);
    assert.equal(v.recorded, true);
    assert.equal(v.reason, 'one-file additive helper');
  });

  test('a verdict WITHOUT a recorded reason fails closed to full', () => {
    for (const reason of ['', '   ', undefined, null, 42]) {
      const v = resolveLedgeredVerdict({ reason });
      assert.equal(v.recorded, false, `reason ${JSON.stringify(reason)}`);
      assert.equal(v.reason, null);
    }
  });

  test('Story #5344: the route half is gone — a stray route key decides nothing', () => {
    assert.equal(
      resolveLedgeredVerdict({ route: 'full', reason: 'why' }).recorded,
      true,
    );
  });

  test('Story #5366: the verdict carries no route field restating `recorded`', () => {
    for (const v of [
      resolveLedgeredVerdict(LITE_VERDICT),
      resolveLedgeredVerdict({}),
    ]) {
      assert.equal('route' in v, false);
      assert.deepEqual(Object.keys(v).sort(), ['note', 'reason', 'recorded']);
    }
  });

  test('is total: a missing verdict fails closed, never throws', () => {
    assert.equal(resolveLedgeredVerdict().recorded, false);
    assert.equal(resolveLedgeredVerdict({}).recorded, false);
  });
});

// ---------------------------------------------------------------------------
// deriveLightSuitability (AC-2) — shape machinery AND ledgered verdict
// ---------------------------------------------------------------------------

describe('deriveLightSuitability — only risk and the ledger decide (AC-2, Story #5344)', () => {
  test('a clearly-small prompt with a ledgered verdict is suitable', () => {
    const s = deriveLightSuitability({
      predictedChanges: [{ path: 'bin/hello.js', assumption: 'creates' }],
      verdict: LITE_VERDICT,
      injectedRules: RULES,
    });
    assert.equal(s.suitable, true);
    assert.equal(s.shape.route, 'lite');
    assert.equal(s.ledger.recorded, true);
    // Story #5366 — `suitable` is the whole verdict; nothing restates it.
    assert.equal('route' in s, false);
  });

  test('Story #5344: a multi-deployable footprint proceeds light — span is not a rule any more', () => {
    const s = deriveLightSuitability({
      predictedChanges: [
        { path: 'apps/api/src/a.js', assumption: 'refactors-existing' },
        { path: 'apps/web/src/b.js', assumption: 'refactors-existing' },
      ],
      verdict: LITE_VERDICT,
      injectedRules: RULES,
    });
    assert.equal(s.shape.route, 'lite', 'no absolute risk rule fires');
    assert.equal(s.suitable, true);
  });

  test('Story #5344: no decision carries a warnings[] any more', () => {
    const s = deriveLightSuitability({
      predictedChanges: [{ path: 'bin/hello.js', assumption: 'creates' }],
      verdict: LITE_VERDICT,
      injectedRules: RULES,
    });
    assert.equal('warnings' in s, false);
    assert.equal('ceilings' in s, false, 'no predicted-shape ceilings survive');
  });

  test('Story #5344: the declared effort axes are not inputs — passing them changes nothing', () => {
    const base = {
      predictedChanges: [
        { path: 'src/reporting.js', assumption: 'refactors-existing' },
      ],
      verdict: LITE_VERDICT,
      injectedRules: RULES,
    };
    const plain = deriveLightSuitability(base);
    const declared = deriveLightSuitability({
      ...base,
      predictedKinds: ['a', 'b', 'c', 'd'],
      predictedMagnitude: 'substantial',
      predictedUncertainty: 'needs-design',
    });
    assert.equal(plain.suitable, true);
    assert.deepEqual(declared.shape, plain.shape);
    assert.equal(declared.suitable, true);
  });

  test('AC-1: three instances of one mechanical edit are suitable', () => {
    const mechanical = deriveLightSuitability({
      predictedChanges: ['a', 'b', 'c'].map((p) => ({
        path: `src/${p}.js`,
        assumption: 'refactors-existing',
      })),
      verdict: LITE_VERDICT,
      injectedRules: RULES,
    });
    assert.equal(mechanical.suitable, true);
  });

  test('AC-3: marginal small work is no longer rejected on counts alone', () => {
    const s = deriveLightSuitability({
      predictedChanges: ['a', 'b', 'c', 'd', 'e'].map((p) => ({
        path: `src/widgets/${p}.js`,
        assumption: 'refactors-existing',
      })),
      verdict: LITE_VERDICT,
      injectedRules: RULES,
    });
    assert.equal(
      s.suitable,
      true,
      'over every retired count ceiling, yet plainly not epic',
    );
  });

  test('AC-5: the benchmark hello-world footprint is suitable', () => {
    const s = deriveLightSuitability({
      predictedChanges: [
        { path: 'src/server.js', assumption: 'creates' },
        { path: 'package.json', assumption: 'refactors-existing' },
        { path: 'tests/server.test.js', assumption: 'creates' },
      ],
      verdict: LITE_VERDICT,
      injectedRules: RULES,
    });
    assert.equal(s.suitable, true);
  });

  test('a sensitive-path footprint is not suitable even when small', () => {
    const s = deriveLightSuitability({
      predictedChanges: [
        { path: 'src/auth/session.js', assumption: 'creates' },
      ],
      verdict: LITE_VERDICT,
      injectedRules: RULES,
    });
    assert.equal(s.suitable, false);
    assert.equal(s.suitable, false);
    assert.equal(s.unwaivable.present, true);
    assert.deepEqual(s.unwaivable.classes, ['security']);
  });

  test('a billing footprint is not suitable even when small', () => {
    const s = deriveLightSuitability({
      predictedChanges: [
        { path: 'src/billing/invoice.js', assumption: 'refactors-existing' },
      ],
      verdict: LITE_VERDICT,
      injectedRules: RULES,
    });
    assert.equal(s.suitable, false);
    assert.deepEqual(s.unwaivable.classes, ['billing']);
  });

  test('a migration paired with its consumers is not suitable', () => {
    const s = deriveLightSuitability({
      predictedChanges: [
        { path: 'db/migrations/003_add_col.sql', assumption: 'creates' },
        { path: 'src/repo/user.js', assumption: 'refactors-existing' },
      ],
      injectedRules: { sensitivePaths: {} },
      verdict: LITE_VERDICT,
    });
    assert.equal(s.suitable, false);
    assert.equal(s.shape.code, 'migration-span');
    assert.equal(s.unwaivable.present, true);
  });

  test('a small shape with an UNLEDGERED verdict is not suitable (verdict wins)', () => {
    const s = deriveLightSuitability({
      predictedChanges: [{ path: 'bin/hello.js', assumption: 'creates' }],
      verdict: { reason: '' },
      injectedRules: RULES,
    });
    assert.equal(s.suitable, false);
    assert.equal(s.ledger.recorded, false);
  });

  test('is total: empty args yield a non-suitable full decision, never a throw', () => {
    const s = deriveLightSuitability();
    assert.equal(s.suitable, false);
    assert.equal(s.suitable, false);
  });
});

// ---------------------------------------------------------------------------
// resolveLightGateOutcome (AC-3) — over-scope stops, never lands silently
// ---------------------------------------------------------------------------

describe('resolveLightGateOutcome — proceed, or escalate (Story #5344)', () => {
  test('a suitable decision proceeds light and carries no warnings channel', () => {
    const o = resolveLightGateOutcome({ suitability: { suitable: true } });
    assert.equal(o.action, 'proceed-light');
    assert.equal('warnings' in o, false);
    assert.match(
      o.reasons.join(' '),
      /diff backstop bounds the actual change set/,
    );
  });

  test('an unsuitable decision escalates whether or not the run is attended', () => {
    const o = resolveLightGateOutcome({
      suitability: { suitable: false, reasons: ['un-waivable rule'] },
    });
    assert.equal(o.action, 'escalate-plan');
    assert.equal('options' in o, false, 'there is no question to ask');
    assert.equal('override' in o, false, 'there is no answer to record');
  });

  test('is total: missing suitability escalates, never throws', () => {
    assert.equal(resolveLightGateOutcome().action, 'escalate-plan');
  });
});

// ---------------------------------------------------------------------------
// checkLightDiffBackstop (AC-4) — the actual diff is the real scope signal
// ---------------------------------------------------------------------------

/** A measured magnitude summary, the shape summarizeDiffMagnitude returns. */
const magnitudeOf = (implFiles, implLines) => ({ implFiles, implLines });

describe('checkLightDiffBackstop — blocks over-magnitude actual diffs (AC-4)', () => {
  test('a small non-sensitive diff is not blocked', () => {
    const r = checkLightDiffBackstop({
      changedFiles: ['bin/hello.js', 'tests/hello.test.js'],
      magnitude: magnitudeOf(1, 40),
      injectedRules: RULES,
    });
    assert.equal(r.blocked, false);
    assert.equal(r.level, 'low');
    assert.equal(r.fileCount, 2);
  });

  test('Story #4856: a wide-but-shallow diff lands; a narrow-but-deep one does not', () => {
    // The inversion the retired maxFiles ceiling produced, both directions.
    // Twelve implementation files at 900 lines is real work a single session
    // absorbs; six files at 3712 lines is not, however few files it touches.
    const wide = checkLightDiffBackstop({
      changedFiles: Array.from({ length: 12 }, (_v, i) => `src/mod${i}.js`),
      magnitude: magnitudeOf(12, 900),
      injectedRules: RULES,
    });
    assert.equal(wide.blocked, false);

    const deep = checkLightDiffBackstop({
      changedFiles: Array.from({ length: 6 }, (_v, i) => `src/mod${i}.js`),
      magnitude: magnitudeOf(6, 3712),
      injectedRules: RULES,
    });
    assert.equal(deep.blocked, true);
    assert.match(deep.reasons.join(' '), /maxImplLines/);
  });

  test('Story #4856: companion churn cannot push a small change over — 40 test files, 8000 lines', () => {
    // The 190-file merge that measured 47x over the old ceiling: 186 of those
    // files were tests. Its implementation is one file.
    const r = checkLightDiffBackstop({
      changedFiles: [
        'src/one.js',
        ...Array.from({ length: 40 }, (_v, i) => `tests/gen${i}.test.js`),
      ],
      magnitude: magnitudeOf(1, 600),
      injectedRules: RULES,
    });
    assert.equal(r.blocked, false);
    assert.equal(r.fileCount, 41);
  });

  test('the implementation-file sprawl tripwire blocks genuine sprawl', () => {
    const r = checkLightDiffBackstop({
      changedFiles: Array.from({ length: 42 }, (_v, i) => `src/mod${i}.js`),
      magnitude: magnitudeOf(42, 803),
      injectedRules: RULES,
    });
    assert.equal(r.blocked, true);
    assert.match(r.reasons.join(' '), /maxImplFiles/);
  });

  test('a diff intersecting a sensitive-path class is blocked', () => {
    const r = checkLightDiffBackstop({
      changedFiles: ['src/auth/session.js'],
      magnitude: magnitudeOf(1, 3),
      injectedRules: RULES,
    });
    assert.equal(r.blocked, true);
    assert.deepEqual(r.classes, ['security']);
  });

  test('Story #4856: a COMPANION under a sensitive class still blocks — exemption is from counting, not risk', () => {
    const r = checkLightDiffBackstop({
      changedFiles: ['tests/auth/session.test.js', 'src/auth/session.js'],
      magnitude: magnitudeOf(0, 0),
      injectedRules: RULES,
    });
    assert.equal(r.blocked, true);
    assert.deepEqual(r.classes, ['security']);
  });

  test('AC-4 (Story #4764): relaxing the PREDICTION gate cannot land oversized work', () => {
    // The same five same-kind files the prediction gate now admits: the
    // backstop reads ground truth, so it still refuses to land them when their
    // magnitude is genuinely large. Coarse prediction, measured diff.
    const files = ['a', 'b', 'c', 'd', 'e'].map((p) => `src/widgets/${p}.js`);
    assert.equal(
      deriveLightSuitability({
        predictedChanges: files.map((path) => ({
          path,
          assumption: 'refactors-existing',
        })),
        verdict: LITE_VERDICT,
        injectedRules: RULES,
      }).suitable,
      true,
    );
    const backstop = checkLightDiffBackstop({
      changedFiles: files,
      magnitude: magnitudeOf(5, 4000),
      injectedRules: RULES,
    });
    assert.equal(backstop.blocked, true);
    assert.match(backstop.reasons.join(' '), /maxImplLines/);
  });

  test('an empty or unknown change set is blocked (cannot verify light)', () => {
    for (const changedFiles of [[], null, undefined, 'x']) {
      const r = checkLightDiffBackstop({
        changedFiles,
        magnitude: magnitudeOf(1, 1),
      });
      assert.equal(r.blocked, true);
    }
  });

  test('Story #4856: an unmeasurable magnitude blocks — absence of evidence is not evidence of smallness', () => {
    for (const magnitude of [null, undefined, {}, { implFiles: 1 }, 'x']) {
      const r = checkLightDiffBackstop({
        changedFiles: ['src/one.js'],
        magnitude,
        injectedRules: RULES,
      });
      assert.equal(r.blocked, true);
      assert.match(r.reasons.join(' '), /could not be measured/);
    }
  });

  test('honors a caller ceiling but rejects a malformed one', () => {
    assert.equal(
      checkLightDiffBackstop({
        changedFiles: ['a.js', 'b.js', 'c.js'],
        magnitude: magnitudeOf(3, 300),
        ceilings: { maxImplLines: 200 },
        injectedRules: RULES,
      }).blocked,
      true,
    );
    // A malformed ceiling falls back to the framework default (not 0/∞).
    for (const bad of [0, -1, Number.NaN, 'four', null]) {
      const r = checkLightDiffBackstop({
        changedFiles: ['a.js'],
        magnitude: magnitudeOf(1, 10),
        ceilings: { maxImplLines: bad, maxImplFiles: bad },
        injectedRules: RULES,
      });
      assert.deepEqual(r.ceilings, {
        maxImplLines: LIGHT_DIFF_CEILINGS.maxImplLines,
        maxImplFiles: LIGHT_DIFF_CEILINGS.maxImplFiles,
      });
    }
  });

  test('Story #4856: cardinality is no longer an axis anywhere in the ceilings', () => {
    assert.deepEqual(Object.keys(LIGHT_DIFF_CEILINGS).sort(), [
      'maxImplFiles',
      'maxImplLines',
    ]);
    assert.equal(LIGHT_DIFF_CEILINGS.maxFiles, undefined);
    assert.equal(LIGHT_DIFF_CEILINGS.maxImplLines, 1000);
    // Aligned with review-depth's own narrow-diff scale (DEFAULT_DIFF_WIDTH
    // .softFiles) so the two stop holding different definitions of "narrow".
    assert.equal(
      LIGHT_DIFF_CEILINGS.maxImplFiles,
      DEFAULT_DIFF_WIDTH.softFiles,
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
});

// ---------------------------------------------------------------------------
// runLightGate + --amends (AC-3, AC-6) — shape-checked identically
// ---------------------------------------------------------------------------

describe('runLightGate — end-to-end gate over the entry inputs (AC-3, AC-6)', () => {
  test('a small prompt with a ledgered lite verdict proceeds light', () => {
    const gate = runLightGate({
      prompt: 'add a bin/hello.js greeter',
      creates: ['bin/hello.js'],
      reason: 'single additive file',
      injectedRules: RULES,
    });
    assert.equal(gate.action, 'proceed-light');
  });

  test('a sensitive-path prompt escalates — attended or not (Story #5313)', () => {
    const gate = runLightGate({
      prompt: 'rework the whole billing pipeline',
      refactors: ['src/billing/a.js', 'src/billing/b.js', 'src/billing/c.js'],
      reason: 'claims small but is not',
      injectedRules: RULES,
    });
    assert.equal(gate.action, 'escalate-plan');
    assert.equal(gate.suitability.unwaivable.code, 'sensitive-path');
  });

  test('--amends: a SMALL amendment routes light', () => {
    const gate = runLightGate({
      prompt: 'fix the off-by-one in the counter',
      refactors: ['src/counter.js'],
      reason: 'one-line fix in an existing file',
      amends: '#4200',
      injectedRules: RULES,
    });
    assert.equal(gate.action, 'proceed-light');
  });

  test('Story #5344: the retired effort flags are not inputs — the gate ignores them', () => {
    const gate = runLightGate({
      prompt: 'make the counter configurable somehow',
      refactors: ['src/counter.js'],
      kinds: ['a', 'b', 'c', 'd'],
      magnitude: 'substantial',
      uncertainty: 'needs-design',
      reason: 'one file, but the shape is not decided',
      injectedRules: RULES,
    });
    assert.equal(gate.action, 'proceed-light');
    assert.equal('warnings' in gate.outcome, false);
  });

  test('--amends: a HEAVY amendment escalates to /mandrel-plan', () => {
    const gate = runLightGate({
      prompt: 'amend: overhaul auth and add a migration',
      creates: ['src/auth/new.js'],
      reason: 'claims small but touches auth',
      amends: '#4200',
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
// runDiffBackstop (AC-4) — joins computeChangeSet with the numstat magnitude
// ---------------------------------------------------------------------------

/** Numstat rows for a list of `[additions, deletions, path]` triples. */
const rowsOf = (...triples) =>
  triples.map(([additions, deletions, path]) => ({
    additions,
    deletions,
    path,
  }));

/**
 * Drive the backstop pass through its public entry point, which forwards the
 * git seams to the internal run. Returns the verdict.
 */
const backstop = async (args) =>
  (
    await resolveBackstopOutcome({
      handleBlockedFn: async () => '/mandrel-plan x',
      // Never shell out to git from a unit test — the preservation push has
      // its own coverage below.
      preserveFn: () => ({
        preserved: true,
        branch: 'story-x',
        remoteRef: 'origin/story-x',
        detail: 'stub',
      }),
      ...args,
    })
  ).result;

describe('the backstop pass re-checks the ACTUAL branch diff (AC-4)', () => {
  test('a clean small diff is not blocked', async () => {
    const r = await backstop({
      storyId: 4741,
      injectedRules: RULES,
      computeFn: () => ({ files: ['bin/hello.js'] }),
      readRowsFn: () => rowsOf([20, 4, 'bin/hello.js']),
    });
    assert.equal(r.blocked, false);
    assert.deepEqual(r.magnitude, { implFiles: 1, implLines: 24 });
  });

  test('an over-magnitude diff is blocked', async () => {
    const r = await backstop({
      storyId: 4741,
      injectedRules: RULES,
      computeFn: () => ({ files: ['a.js', 'b.js'] }),
      readRowsFn: () => rowsOf([2000, 500, 'a.js'], [10, 2, 'b.js']),
    });
    assert.equal(r.blocked, true);
    assert.match(r.reasons.join(' '), /maxImplLines/);
  });

  test('a sensitive-path diff is blocked whatever its magnitude', async () => {
    const r = await backstop({
      storyId: 4741,
      injectedRules: RULES,
      computeFn: () => ({ files: ['src/auth/a.js'] }),
      readRowsFn: () => rowsOf([1, 0, 'src/auth/a.js']),
    });
    assert.equal(r.blocked, true);
  });

  test('an unenumerable diff (files: null) is blocked', async () => {
    const r = await backstop({
      storyId: 4741,
      computeFn: () => ({ files: null }),
      readRowsFn: () => rowsOf([1, 1, 'a.js']),
    });
    assert.equal(r.blocked, true);
  });

  test('Story #4856: an unreadable numstat (rows: null) is blocked', async () => {
    const r = await backstop({
      storyId: 4741,
      injectedRules: RULES,
      computeFn: () => ({ files: ['bin/hello.js'] }),
      readRowsFn: () => null,
    });
    assert.equal(r.blocked, true);
    assert.match(r.reasons.join(' '), /could not be measured/);
  });

  test('Story #4856: both git surfaces are read against the same refs', async () => {
    const seen = [];
    await backstop({
      storyId: 4741,
      baseRef: 'main',
      injectedRules: RULES,
      computeFn: (args) => {
        seen.push(args);
        return { files: ['bin/hello.js'] };
      },
      readRowsFn: (args) => {
        seen.push(args);
        return rowsOf([1, 0, 'bin/hello.js']);
      },
    });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].headRef, 'story-4741');
    assert.equal(seen[1].headRef, 'story-4741');
    assert.equal(seen[0].baseRef, seen[1].baseRef);
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

/**
 * Over-scope gate inputs. Since Story #5344 the only prediction-time refusal
 * is an un-waivable risk rule, so the fixture is a sensitive footprint rather
 * than a large one.
 */
const OVER_SCOPE = {
  prompt: 'rework the whole billing pipeline end to end',
  refactors: 'src/billing/report.js,src/billing/ledger.js',
  reason: 'claims small but is not',
};

/**
 * Drive `runGateMode` with every side-effecting seam replaced by a spy, so a
 * test can assert not merely that the envelope SAYS nothing was created but
 * that the code never reached the call sites that would create anything.
 *
 * @param {object} values
 * @returns {Promise<{ code: number, terminals: object[], gateEnvelopes: object[], created: number, providers: number, receiptArgs: object[] }>}
 */
async function driveGate(values) {
  const terminals = [];
  const gateEnvelopes = [];
  const receiptArgs = [];
  let created = 0;
  let providers = 0;
  const code = await runGateMode(values, {
    createProviderFn: () => {
      providers += 1;
      return {};
    },
    resolveConfigFn: () => ({}),
    createReceiptFn: async (args) => {
      created += 1;
      receiptArgs.push(args);
      return { storyId: 1, url: 'https://example/1', title: 't' };
    },
    emitFn: (envelope) => gateEnvelopes.push(envelope),
    emitTerminalFn: (envelope) => terminals.push(envelope),
  });
  return { code, terminals, gateEnvelopes, created, providers, receiptArgs };
}

describe('escalate-plan emits a terminal envelope and exits non-zero (AC-1)', () => {
  test('the envelope is schema-valid, escalated, and names the /mandrel-plan next command', async () => {
    const { code, terminals, gateEnvelopes } = await driveGate({
      ...OVER_SCOPE,
    });

    assert.equal(terminals.length, 1, 'exactly one terminal envelope');
    const env = terminals[0];
    assert.equal(validateTerminalEnvelope(env).valid, true);
    assert.equal(env.kind, 'story-deliver-terminal');
    assert.equal(env.status, 'escalated');
    assert.equal(env.phase, 'suitability-gate');
    assert.match(env.nextCommand, /^\/mandrel-plan "/);
    assert.match(env.nextCommand, /billing pipeline/);

    // Non-zero: a caller must not be able to read escalation as success.
    assert.notEqual(code, 0);
    assert.equal(code, 2);

    // The terminal replaces the walk-past-able gate envelope; it does not
    // accompany it. One session, one terminal output.
    assert.equal(gateEnvelopes.length, 0);
  });

  test('the gate reasons survive verbatim into the envelope', async () => {
    const { terminals } = await driveGate({ ...OVER_SCOPE });
    const reasons = terminals[0].escalation.reasons.join(' ');
    assert.match(reasons, /un-waivable/);
    assert.match(reasons, /sensitive-path class\(es\) billing/);
    assert.match(reasons, /fails closed to \/mandrel-plan/);
  });
});

describe('an escalated run starts nothing (AC-2)', () => {
  test('never reaches the receipt-Story call site', async () => {
    const { created, providers } = await driveGate({
      ...OVER_SCOPE,
    });
    assert.equal(created, 0, 'no receipt Story may be authored');
    assert.equal(
      providers,
      0,
      'the escalate path must not even build a provider',
    );
  });

  test('the envelope records no Story, no branch, and no worktree', async () => {
    const { terminals } = await driveGate({ ...OVER_SCOPE });
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
    const cwd = makeTempDir('light-escalate-');
    const result = spawnSync(
      process.execPath,
      [
        DELIVER_LIGHT_SRC,
        '--prompt',
        OVER_SCOPE.prompt,
        '--refactors',
        OVER_SCOPE.refactors,
        '--reason',
        OVER_SCOPE.reason,
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

describe('attended and unattended over-scope both escalate (Story #5313)', () => {
  test('an attended risk refusal is the same terminal — there is no question to wait for', async () => {
    const { code, terminals, gateEnvelopes, created } = await driveGate({
      ...OVER_SCOPE,
    });
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].status, 'escalated');
    assert.equal(gateEnvelopes.length, 0);
    assert.equal(code, 2);
    assert.equal(created, 0);
  });

  test('proceed-light is untouched — receipt authored, no terminal, no warnings channel', async () => {
    const { code, terminals, gateEnvelopes, created } = await driveGate({
      prompt: 'add a bin/hello.js greeter',
      creates: 'bin/hello.js',
      reason: 'single additive file',
    });
    assert.equal(code, 0);
    assert.equal(created, 1);
    assert.equal(terminals.length, 0);
    assert.equal(gateEnvelopes[0].action, 'proceed-light');
    assert.equal(Object.hasOwn(gateEnvelopes[0], 'warnings'), false);
  });

  test('Story #5344: a footprint past every retired ceiling proceeds light silently', async () => {
    const { code, terminals, gateEnvelopes, created } = await driveGate({
      prompt: 'raise the webServer boot timeout',
      refactors:
        'apps/web/playwright.config.ts,apps/staff/playwright.config.ts',
      reason: 'one constant, two identical call sites',
    });
    assert.equal(code, 0);
    assert.equal(created, 1);
    assert.equal(terminals.length, 0);
    assert.equal(gateEnvelopes[0].action, 'proceed-light');
    assert.equal(Object.hasOwn(gateEnvelopes[0], 'warnings'), false);
    assert.equal(
      Object.hasOwn(gateEnvelopes[0], 'override'),
      false,
      'the override record went with the gate it answered',
    );
  });
});

describe('the workflow states escalation is terminal for the path (AC-3)', () => {
  // Prose assertions go through doc-assert: these claims are about what the
  // document SAYS, and a plain `assert.match` would silently also be pinning
  // where the 80-column wrap happens to fall.
  const doc = readDoc(
    path.join(REPO_ROOT, '.agents', 'workflows', 'helpers', 'deliver-light.md'),
  );

  test('names the envelope as the terminal output', () => {
    assertDocMentions(
      doc,
      /envelope IS this session's terminal output for the light path/i,
      'the workflow must state the escalated envelope IS the terminal output',
    );
    assertDocMentions(doc, /status.{0,4}:.{0,4}"?escalated/i);
  });

  test('Story #5344: in-session /mandrel-plan is permitted and seeded, not barred', () => {
    assertDocOmits(
      doc,
      /forbidden/i,
      'the ban is lifted; no clause may still call in-session planning forbidden',
    );
    assertDocMentions(
      doc,
      /in this same session/i,
      'the loosening must be stated in so many words',
    );
    assertDocMentions(
      doc,
      /`escalation\.reasons`/,
      'the seeding instruction must name the field to carry over',
    );
    assertDocMentions(
      doc,
      /fresh session is still the safer default/i,
      'the fresh-session alternative must survive as the recommended default',
    );
  });

  test('records the empirical reason the ban existed, and what now measures it', () => {
    // Without the measurement this is style; with it, it is a finding. Pin
    // the numbers themselves — a doc that kept the word "empirically" but
    // dropped the 1-vs-4 comparison would have lost exactly what makes the
    // history legible to the next session reading it.
    assertDocMentions(doc, /mandrel-bench/i);
    assertDocMentions(
      doc,
      /authored \*\*one\*\* Story against the\s+scenario's 3[–-]5 contract/i,
      'the under-decomposition finding must name what in-session planning produced',
    );
    assertDocMentions(
      doc,
      /fresh `?\/mandrel-plan`? session on the identical\s+seed authored \*\*four\*\*/i,
      'the finding is only legible next to the fresh-session comparison',
    );
    assertDocMentions(doc, /under-decompos/i);
    assertDocMentions(
      doc,
      /light-arm cell of mandrel-bench/i,
      'the doc must name the cell that decides whether the loosening stays',
    );
  });

  test('states that an escalated run leaves no Story, branch, or worktree', () => {
    assertDocMentions(
      doc,
      /no receipt Story, no `story-<id>` branch, and no worktree/i,
      'the workflow must name all three artifacts an escalated run does not create',
    );
  });
});

describe('the workflow gates on risk, not on a declared size (Story #5344)', () => {
  const doc = readDoc(
    path.join(REPO_ROOT, '.agents', 'workflows', 'helpers', 'deliver-light.md'),
  );

  test('states outright that a self-declared size is not a measurement', () => {
    assertDocMentions(
      doc,
      /A size you declare about your own request is not a measurement/i,
      'the workflow must say why the declared axes are gone',
    );
  });

  test('names the one gate and where size is really enforced', () => {
    assertDocMentions(
      doc,
      /one gate/i,
      'a reader must know there is a single prediction-time gate',
    );
    assertDocMentions(
      doc,
      /Size is enforced where ground truth is available/i,
      'the doc must point at the diff backstop as the real enforcement',
    );
  });

  test('does not send the reader back to the retired shape flags', () => {
    assertDocOmits(
      doc,
      /--kinds|--magnitude|--uncertainty|STORY_SHAPE_CEILINGS/,
      'the retired flags and constant must not survive in the procedure',
    );
  });

  test('keeps the sensitivity hard gate stated as absolute', () => {
    assertDocMentions(
      doc,
      /Sensitivity is the exception and stays absolute/i,
      'dropping the size ceilings must not read as relaxing sensitivity',
    );
  });
});

// ---------------------------------------------------------------------------
// AC-7 (as amended by Story #4760) — the light path must NOT project a command
// ---------------------------------------------------------------------------
// This assertion was inverted, not deleted. #4740 shipped `/deliver-light` as
// its own command and pinned that it projected; #4760 folded the prompt path
// into `/mandrel-deliver` precisely so an operator never has to pre-judge which door
// to use, and a surviving `/deliver-light` command would restore that choice.
//
// Projection is also the whole retirement mechanism: `helpers/` is skipped by
// the projector and the orphan-reap removes any command with no source
// workflow, so a consumer's stale `/deliver-light` disappears on their next
// sync with no migration step. This test is what proves that still holds.

describe('the light path does not project a command (AC-7, Story #4760)', () => {
  test('sync-claude-commands writes no deliver-light command', () => {
    const dest = makeTempDir('light-cmd-');
    // Seed the destination with the command a pre-#4760 consumer would have,
    // so this exercises the orphan-reap rather than merely a non-write.
    writeFileSync(path.join(dest, 'deliver-light.md'), '# stale\n');

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
    assert.equal(
      existsSync(path.join(dest, 'deliver-light.md')),
      false,
      'a stale /deliver-light command survived the sync — consumers would keep ' +
        'a second delivery door that no workflow backs',
    );
    assert.ok(
      existsSync(path.join(dest, 'mandrel-deliver.md')),
      'the one delivery door must still project',
    );
  });
});

// ---------------------------------------------------------------------------
// Story #5344 — the predicted-shape gate is gone entirely; so is its warning
// ---------------------------------------------------------------------------

/**
 * The consumer shape that motivated the retired override: one mechanical
 * constant bump at sites that straddle two apps, with the ledgered verdict in
 * place. It used to stop at `ask-operator`, then warned (Story #5313); since
 * Story #5344 it is simply lite.
 */
const SPANNING_SCOPE = Object.freeze({
  predictedChanges: [
    { path: 'apps/web/playwright.config.ts', assumption: 'refactors-existing' },
    {
      path: 'apps/staff/playwright.config.ts',
      assumption: 'refactors-existing',
    },
  ],
  verdict: LITE_VERDICT,
  injectedRules: RULES,
});

describe('the predicted shape no longer objects at all (Story #5344 AC-2)', () => {
  test('a multi-deployable prediction is simply lite — the axis is gone', () => {
    const s = deriveLightSuitability(SPANNING_SCOPE);
    assert.equal(s.suitable, true);
    assert.equal(s.shape.code, null);
    assert.equal('warnings' in s, false);
  });

  test('an unknown footprint is likewise not a stop — the backstop owns it', () => {
    for (const [code, overrides] of [
      ['no-changes', { predictedChanges: [] }],
      [
        'glob-footprint',
        { predictedChanges: [{ path: 'src/**/*.ts', assumption: 'creates' }] },
      ],
    ]) {
      const s = deriveLightSuitability({ ...SPANNING_SCOPE, ...overrides });
      assert.equal(s.shape.code, code, `fixture yields ${code}`);
      assert.equal(s.suitable, true, `${code} must not refuse`);
    }
  });

  test('a risk rule still refuses the same fixture', () => {
    const s = deriveLightSuitability({
      ...SPANNING_SCOPE,
      predictedChanges: [
        ...SPANNING_SCOPE.predictedChanges,
        { path: 'apps/web/auth/session.ts', assumption: 'refactors-existing' },
      ],
    });
    assert.equal(s.suitable, false);
    assert.equal(s.unwaivable.code, 'sensitive-path');
  });

  test('the ledgered verdict still stands on its own', () => {
    for (const verdict of [{ reason: '' }, { reason: '   ' }, undefined]) {
      const s = deriveLightSuitability({ ...SPANNING_SCOPE, verdict });
      assert.equal(s.suitable, false, JSON.stringify(verdict));
      assert.equal(
        resolveLightGateOutcome({ suitability: s }).action,
        'escalate-plan',
      );
    }
  });

  test('the receipt Story carries no override paragraph', () => {
    const ticket = buildReceiptStoryTicket({
      prompt: 'raise the boot timeout',
      changedFiles: ['apps/web/playwright.config.ts'],
    });
    assert.doesNotMatch(ticket.body.spec, /OPERATOR SCOPE OVERRIDE/);
  });
});

describe('deliver-light.js CLI — the retired flags are gone (Story #5344 AC-1)', () => {
  test('--help documents exactly the surviving gate flags', () => {
    const result = spawnSync(process.execPath, [DELIVER_LIGHT_SRC, '--help'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    for (const flag of [
      '--prompt',
      '--creates',
      '--refactors',
      '--reason',
      '--amends',
    ]) {
      assert.ok(result.stdout.includes(flag), `--help must document ${flag}`);
    }
    assert.doesNotMatch(result.stdout, /--operator-proceed-light/);
    assert.doesNotMatch(result.stdout, /ask-operator/);
    assert.doesNotMatch(result.stdout, /--kinds|--magnitude|--uncertainty/);
    assert.doesNotMatch(result.stdout, /--route\b/);
    // Story #5366 — the acceptance-count flag and the unattended marker.
    assert.doesNotMatch(result.stdout, /--acceptance\b/);
    assert.doesNotMatch(result.stdout, /--yes\b/);
  });

  test('each retired flag is REJECTED as unknown, not silently ignored', () => {
    for (const flag of [
      '--kinds',
      '--magnitude',
      '--uncertainty',
      '--route',
      '--acceptance',
    ]) {
      const result = spawnSync(
        process.execPath,
        [DELIVER_LIGHT_SRC, '--prompt', 'x', '--reason', 'y', flag, 'z'],
        { encoding: 'utf8' },
      );
      assert.notEqual(result.status, 0, `${flag} must exit non-zero`);
    }
  });

  test('the parser owns no retired flag — a phantom flag would be silently ignored', () => {
    const src = readFileSync(DELIVER_LIGHT_SRC, 'utf8');
    assert.doesNotMatch(src, /operator-proceed-light/);
    assert.doesNotMatch(src, /ask-operator/);
    const options = src.slice(src.indexOf('const { values } = parseArgs('));
    for (const key of [
      'kinds',
      'magnitude',
      'uncertainty',
      'route',
      'acceptance',
      'yes',
    ]) {
      assert.doesNotMatch(
        options,
        new RegExp(`\\b${key}: \\{ type:`),
        `${key} must not survive as a parser option`,
      );
    }
  });
});

describe('the workflow describes one gate, not a size declaration (Story #5344)', () => {
  const doc = readDoc(
    path.join(REPO_ROOT, '.agents', 'workflows', 'helpers', 'deliver-light.md'),
  );

  test('no longer names a warnings[] channel or the retired answer flag', () => {
    assertDocOmits(
      doc,
      /`warnings\[\]`|ask-operator|--operator-proceed-light/,
      'the retired outcomes and their flags must not survive in prose',
    );
  });

  test('keeps sensitivity and the diff backstop as the hard edges', () => {
    assertDocMentions(
      doc,
      /Sensitivity is the exception and stays absolute/i,
      'dropping the shape gate must not read as relaxing sensitivity',
    );
    assertDocMentions(
      doc,
      /LIGHT_DIFF_CEILINGS/,
      'the backstop is the only remaining size block and must be named',
    );
  });
});

// ---------------------------------------------------------------------------
// Story #4856 — a blocked backstop RECYCLES its receipt instead of orphaning it,
// and both light-path rejections are telemetered
// ---------------------------------------------------------------------------

describe('a blocked backstop recycles the receipt Story (Story #4856)', () => {
  test('the recycle command hands the receipt to /mandrel-plan tickets mode', async () => {
    // Tickets mode already rewrites a ticket into planned Stories and closes it
    // as superseded — so the receipt becomes the plan's INPUT rather than an
    // open issue with no successor.
    const next = await handleBlockedBackstop({
      storyId: 4741,
      result: {
        reasons: ['too big'],
        magnitude: { implFiles: 9, implLines: 4000 },
      },
      emitFn: async () => true,
    });
    assert.equal(next, '/mandrel-plan 4741');
  });

  test('the CLI emits the recycle nextCommand on a blocked backstop', () => {
    // This spawns the REAL CLI at the REAL repository root, so the child
    // resolves the real `.agentrc` and its refusal telemetry
    // (`emitRuntimeFriction` → `appendSignal`) resolves the real tempRoot:
    // without an injected root the fixture Story's friction lands in the
    // operator's live ledger at `temp/standalone/stories/story-999999/`, the
    // retro graduator counts it toward the recurrence threshold, and it files
    // a ticket citing `#999999` as a contributing Story (issue #4870).
    // Injecting an absolute per-test root makes the isolation a property of
    // this spawn rather than of whatever the child infers about its context.
    const scratchRoot = makeTempDir('light-backstop-signals-');
    const liveStream = path.join(
      REPO_ROOT,
      'temp',
      'standalone',
      'stories',
      'story-999999',
      'signals.ndjson',
    );
    const liveSizeBefore = existsSync(liveStream)
      ? statSync(liveStream).size
      : null;
    const res = spawnSync(
      process.execPath,
      [DELIVER_LIGHT_SRC, '--backstop', '--story', '999999'],
      {
        encoding: 'utf8',
        cwd: REPO_ROOT,
        env: { ...process.env, [TEST_TEMP_ROOT_ENV]: scratchRoot },
      },
    );
    // A branch that does not exist yields an unenumerable diff → blocked (3).
    assert.equal(res.status, 3);
    const envelope = JSON.parse(res.stdout.trim().split('\n').pop());
    assert.equal(envelope.blocked, true);
    assert.equal(envelope.nextCommand, '/mandrel-plan 999999');
    // The refusal signal exists — this test would pass vacuously against a
    // child that emitted nothing at all.
    assert.equal(
      existsSync(
        path.join(
          scratchRoot,
          'temp',
          'standalone',
          'stories',
          'story-999999',
          'signals.ndjson',
        ),
      ),
      true,
      'the spawned CLI must write its friction signal into the injected root',
    );
    // …and the live ledger is untouched by it.
    assert.equal(
      existsSync(liveStream) ? statSync(liveStream).size : null,
      liveSizeBefore,
      'a fixture Story id must never grow the repository-root signals tree',
    );
  });

  test('a clean backstop carries no recycle command', async () => {
    // Nothing to recycle when nothing was refused.
    const r = await backstop({
      storyId: 4741,
      injectedRules: RULES,
      computeFn: () => ({ files: ['bin/hello.js'] }),
      readRowsFn: () => [{ additions: 2, deletions: 0, path: 'bin/hello.js' }],
    });
    assert.equal(r.blocked, false);
    assert.equal(r.nextCommand, undefined);
  });

  test('the workflow routes the receipt through /mandrel-plan rather than orphaning it', () => {
    const doc = readDoc(
      path.join(
        REPO_ROOT,
        '.agents',
        'workflows',
        'helpers',
        'deliver-light.md',
      ),
    );
    for (const pattern of [
      /recycle the receipt/,
      /tickets mode/,
      /no successor/,
      /implementation half/,
    ]) {
      assertDocMentions(
        doc,
        pattern,
        'step 4 must route a blocked backstop through /mandrel-plan tickets mode rather than leaving the receipt open',
      );
    }
  });
});

describe('light-path rejections are telemetered (Story #4856)', () => {
  test('a scope rejection emits one light-scope-rejected friction signal', async () => {
    const seen = [];
    const next = await handleBlockedBackstop({
      storyId: 4741,
      result: {
        reasons: ['too big'],
        fileCount: 20,
        magnitude: { implFiles: 9, implLines: 4000 },
        ceilings: { maxImplLines: 1000, maxImplFiles: 15 },
        classes: [],
      },
      emitFn: async (args) => {
        seen.push(args);
        return true;
      },
    });
    assert.equal(next, '/mandrel-plan 4741');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].category, 'light-scope-rejected');
    assert.equal(seen[0].tool, 'deliver-light');
    assert.equal(seen[0].storyId, 4741);
    assert.equal(seen[0].details.surface, 'diff-backstop');
    assert.equal(seen[0].details.implLines, 4000);
    assert.equal(seen[0].details.implFiles, 9);
  });

  test('telemetry never changes the verdict — a throwing emitter is swallowed', async () => {
    const next = await handleBlockedBackstop({
      storyId: 4741,
      result: { reasons: ['too big'] },
      emitFn: async () => {
        throw new Error('signals unwritable');
      },
    });
    assert.equal(next, '/mandrel-plan 4741');
  });

  test('an escalating gate hands the refusal to the recorder', async () => {
    const seen = [];
    const code = await runGateMode(
      {
        prompt: 'rework the whole reporting pipeline end to end',
        refactors: 'apps/api/x.js,apps/web/y.js',
        reason: 'claims small but is not',
        amends: '#4321',
      },
      {
        emitFn: () => {},
        emitTerminalFn: () => {},
        recordRefusalFn: async (args) => {
          seen.push(args);
          return true;
        },
      },
    );
    assert.equal(code, 2);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].gate.action, 'escalate-plan');
    assert.equal(seen[0].amends, '#4321');
  });

  test('the recorder attributes a gate refusal to the --amends Story', async () => {
    const seen = [];
    await recordGateRefusal({
      gate: {
        action: 'escalate-plan',
        outcome: { reasons: ['too big'] },
        suitability: { shape: { code: 'sensitive-path' } },
      },
      amends: '#4321',
      recordFrictionFn: async (args) => {
        seen.push(args);
        return true;
      },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].storyId, 4321);
    assert.equal(seen[0].surface, 'suitability-gate');
    assert.equal(seen[0].details.action, 'escalate-plan');
    assert.equal(seen[0].details.code, 'sensitive-path');
  });

  test('a bare prompt has no Story context to attribute a signal to', async () => {
    // Deliberate: the escalating path creates no receipt, and the signals
    // stream is keyed on a Story id. Attributing it to a fabricated id would be
    // worse than recording nothing.
    const attributions = [];
    for (const amends of [undefined, '#12', '12', 'nonsense', '0']) {
      await recordGateRefusal({
        gate: { action: 'escalate-plan', outcome: { reasons: [] } },
        amends,
        emitFn: async (args) => {
          attributions.push(args.storyId);
          return true;
        },
      });
    }
    assert.deepEqual(attributions, [null, 12, 12, null, null]);
  });
});

// ---------------------------------------------------------------------------
// Story #4875 — the un-waivable verdict is surfaced at PREDICTION time, and a
// refused run leaves its finished work recoverable
// ---------------------------------------------------------------------------

/**
 * A footprint whose recorded objection is the absolute `sensitive-path` rule.
 * Story #5344 removed the ceiling rules that used to be reported ahead of it,
 * but `deriveUnwaivableRisk` still reads the risk facts off the shape rather
 * than trusting the recorded code — an unknown-footprint rejection can still
 * be recorded ahead of a risk rule.
 */
const DOUBLE_OBJECTION_SCOPE = Object.freeze({
  predictedChanges: [
    { path: 'src/auth/session.ts', assumption: 'refactors-existing' },
    { path: 'src/report.ts', assumption: 'creates' },
    { path: 'docs/notes.md', assumption: 'documents' },
  ],
  verdict: LITE_VERDICT,
  injectedRules: RULES,
});

describe('the prediction gate names the un-waivable class up front (AC-1, AC-2)', () => {
  test('the risk class is reported independently of the recorded code', () => {
    const s = deriveLightSuitability(DOUBLE_OBJECTION_SCOPE);
    assert.equal(s.shape.code, 'sensitive-path');
    assert.equal(s.unwaivable.present, true);
    assert.equal(s.unwaivable.code, 'sensitive-path');
    assert.deepEqual(s.unwaivable.classes, ['security']);
    assert.match(s.reasons.join(' '), /un-waivable/);
    assert.match(s.reasons.join(' '), /security/);
  });

  test('a seed that will hit the un-waivable verdict is unsuitable for the light path', () => {
    const s = deriveLightSuitability(DOUBLE_OBJECTION_SCOPE);
    assert.equal(s.suitable, false);
    assert.equal(s.suitable, false);
  });

  test('every objection is a reason string, in one voice', () => {
    const s = deriveLightSuitability(DOUBLE_OBJECTION_SCOPE);
    assert.ok(
      s.reasons.every((r) => typeof r === 'string' && r.trim() !== ''),
      'every objection is prose the gate already prints',
    );
    assert.match(s.reasons.join(' '), /take this to \/mandrel-plan now/);
  });

  test('a clean footprint reports no un-waivable rule at all', () => {
    const s = deriveLightSuitability({
      ...SPANNING_SCOPE,
      predictedChanges: [
        { path: 'apps/web/x.ts', assumption: 'refactors-existing' },
      ],
    });
    assert.equal(s.unwaivable.present, false);
    assert.equal(s.unwaivable.code, null);
    assert.equal(s.suitable, true);
  });

  test('a rejection with no judgeable shape claims no un-waivable rule', () => {
    // `no-changes` never builds a risk shape, so there are no risk facts to
    // read — and inventing one would be worse than reporting nothing.
    const s = deriveLightSuitability({
      ...SPANNING_SCOPE,
      predictedChanges: [],
    });
    assert.equal(s.shape.shape, null);
    assert.equal(s.unwaivable.present, false);
    assert.equal(s.unwaivable.reason, null);
    assert.deepEqual(s.unwaivable.classes, []);
  });

  test('a migration span is reported as un-waivable too', () => {
    const s = deriveLightSuitability({
      ...SPANNING_SCOPE,
      predictedChanges: [
        { path: 'db/migrations/001.sql', assumption: 'creates' },
        { path: 'src/reader.ts', assumption: 'refactors-existing' },
      ],
    });
    assert.equal(s.unwaivable.present, true);
    assert.equal(s.unwaivable.code, 'migration-span');
  });
});

describe('a risk rule escalates and names itself (AC-1)', () => {
  test('the gate escalates and names the un-waivable rule', () => {
    const outcome = resolveLightGateOutcome({
      suitability: deriveLightSuitability(DOUBLE_OBJECTION_SCOPE),
    });
    assert.equal(outcome.action, 'escalate-plan');
    assert.match(
      outcome.reasons.join(' '),
      /un-waivable: the predicted footprint intersects sensitive-path/,
    );
  });

  test('a risk-free footprint proceeds — the risk rule did not widen', () => {
    const outcome = resolveLightGateOutcome({
      suitability: deriveLightSuitability(SPANNING_SCOPE),
    });
    assert.equal(outcome.action, 'proceed-light');
    assert.equal('warnings' in outcome, false);
  });
});

describe('a refused light run leaves its work recoverable (AC-3)', () => {
  test('the story branch is published to origin, and no PR is opened', () => {
    const calls = [];
    const r = preserveRefusedWork({
      storyId: 4741,
      cwd: '/repo',
      gitFn: (cwd, ...args) => {
        calls.push([cwd, ...args]);
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(r.preserved, true);
    assert.equal(r.branch, 'story-4741');
    assert.equal(r.remoteRef, 'origin/story-4741');
    assert.deepEqual(calls, [
      ['/repo', 'push', '--set-upstream', 'origin', 'story-4741'],
    ]);
  });

  test('a failed push is REPORTED, never swallowed and never thrown', () => {
    for (const gitFn of [
      () => ({ status: 128, stdout: '', stderr: 'no upstream configured' }),
      () => {
        throw new Error('git missing');
      },
    ]) {
      const r = preserveRefusedWork({ storyId: 4741, cwd: '/repo', gitFn });
      assert.equal(r.preserved, false);
      assert.equal(r.remoteRef, null);
      assert.match(r.detail, /LOCAL ONLY/);
    }
  });

  test('a blocked backstop preserves before it reports, and says so', async () => {
    const outcome = await resolveBackstopOutcome({
      storyId: 4741,
      injectedRules: RULES,
      computeFn: () => ({ files: ['a.js', 'b.js'] }),
      readRowsFn: () => rowsOf([2000, 500, 'a.js'], [10, 2, 'b.js']),
      handleBlockedFn: async () => '/mandrel-plan 4741',
      preserveFn: ({ storyId }) => ({
        preserved: true,
        branch: `story-${storyId}`,
        remoteRef: `origin/story-${storyId}`,
        detail: `refused work preserved on origin/story-${storyId}`,
      }),
    });
    assert.equal(outcome.result.blocked, true);
    assert.equal(outcome.preservation.preserved, true);
    assert.match(outcome.message, /origin\/story-4741/);
    assert.match(outcome.message, /recycle the receipt/);
  });

  test('a clean backstop preserves nothing — there is nothing to recover', async () => {
    const outcome = await resolveBackstopOutcome({
      storyId: 4741,
      injectedRules: RULES,
      computeFn: () => ({ files: ['bin/hello.js'] }),
      readRowsFn: () => rowsOf([2, 0, 'bin/hello.js']),
      preserveFn: () => {
        throw new Error('must not preserve on a clean backstop');
      },
    });
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.preservation, null);
  });

  test('the refusal telemetry records whether the work was preserved', async () => {
    const seen = [];
    await handleBlockedBackstop({
      storyId: 4741,
      result: { reasons: ['too big'] },
      preservation: { preserved: false },
      emitFn: async (args) => {
        seen.push(args);
        return true;
      },
    });
    assert.equal(seen[0].details.preserved, false);
  });
});

// ---------------------------------------------------------------------------
// Story #5238 — a refusal carries a machine-readable CLASS, and an empty diff
// over uncommitted work names the commit door (issue #5237)
// ---------------------------------------------------------------------------

describe('checkLightDiffBackstop — refusalClass is the machine-readable half', () => {
  test('a clean verdict carries no class', () => {
    const r = checkLightDiffBackstop({
      changedFiles: ['bin/hello.js'],
      magnitude: magnitudeOf(1, 40),
      injectedRules: RULES,
    });
    assert.equal(r.blocked, false);
    assert.equal(r.refusalClass, null);
  });

  test('each blocked cause carries its own distinct class', () => {
    const classOf = (args) =>
      checkLightDiffBackstop({ injectedRules: RULES, ...args }).refusalClass;

    const seen = {
      emptyChangeSet: classOf({
        changedFiles: [],
        magnitude: magnitudeOf(1, 10),
      }),
      unenumerable: classOf({
        changedFiles: null,
        magnitude: magnitudeOf(1, 10),
      }),
      sensitive: classOf({
        changedFiles: ['src/auth/a.js'],
        magnitude: magnitudeOf(1, 10),
      }),
      unmeasurable: classOf({
        changedFiles: ['bin/hello.js'],
        magnitude: null,
      }),
      overCeiling: classOf({
        changedFiles: ['bin/hello.js'],
        magnitude: magnitudeOf(1, 99999),
      }),
    };

    // Every cause resolves to a non-empty class...
    for (const [cause, value] of Object.entries(seen)) {
      assert.equal(typeof value, 'string', `${cause} carries a class`);
      assert.ok(value.length > 0, `${cause} class is non-empty`);
    }
    // ...and the four DISTINCT causes are four distinct classes. An empty and
    // an unenumerable change set deliberately share one: neither can be
    // verified, and both refuse for that same reason.
    assert.equal(seen.emptyChangeSet, seen.unenumerable);
    const distinct = new Set([
      seen.emptyChangeSet,
      seen.sensitive,
      seen.unmeasurable,
      seen.overCeiling,
    ]);
    assert.equal(distinct.size, 4, 'unrelated causes must not share a class');
  });

  test('an unreadable sensitive-path manifest is its own class, not a magnitude verdict', () => {
    // `deriveChangeLevel` answers `{ level: null, classes: [] }` when the rules
    // manifest cannot be read — non-sensitivity is then unproven, which is a
    // different refusal from "too big" and must not aggregate with it.
    const r = checkLightDiffBackstop({
      changedFiles: ['bin/hello.js'],
      magnitude: magnitudeOf(1, 10),
      selectSensitivePathClassesFn: () => {
        throw new Error('audit-rules.json is unreadable');
      },
    });
    assert.equal(r.blocked, true);
    assert.equal(r.refusalClass, LIGHT_REFUSAL_CLASSES.SENSITIVITY_UNKNOWN);
    assert.match(r.reasons.join(' '), /classification unavailable/);
  });

  test('sensitivity wins the class when a diff is BOTH sensitive and over-ceiling', () => {
    const r = checkLightDiffBackstop({
      changedFiles: ['src/auth/a.js'],
      magnitude: magnitudeOf(9, 99999),
      injectedRules: RULES,
    });
    assert.equal(r.blocked, true);
    assert.equal(r.refusalClass, LIGHT_REFUSAL_CLASSES.SENSITIVE_PATH);
    // Both objections are still reported — only the CLASS is singular.
    assert.match(r.reasons.join(' '), /sensitive-path class/);
    assert.match(r.reasons.join(' '), /maxImplLines/);
  });

  test('an enumerated-empty diff over uncommitted work names the commit door, not an escalation', () => {
    const r = checkLightDiffBackstop({
      changedFiles: [],
      magnitude: magnitudeOf(1, 10),
      uncommittedWork: true,
      storyBranch: 'story-4741',
    });
    assert.equal(r.blocked, true, 'blocking is still right');
    assert.equal(r.refusalClass, LIGHT_REFUSAL_CLASSES.UNCOMMITTED_WORK);
    const reason = r.reasons.join(' ');
    assert.match(reason, /commit them on story-4741/);
    assert.match(reason, /re-run the backstop/);
    assert.match(reason, /do NOT escalate/);
  });

  test('an UNENUMERABLE diff stays unverifiable however dirty the tree', () => {
    // `files === null` is a git read that failed outright — the one case where
    // nothing about the change is known, so a friendlier story is not available.
    const r = checkLightDiffBackstop({
      changedFiles: null,
      magnitude: magnitudeOf(1, 10),
      uncommittedWork: true,
      storyBranch: 'story-4741',
    });
    assert.equal(r.refusalClass, LIGHT_REFUSAL_CLASSES.CHANGE_SET_UNKNOWN);
    assert.match(r.reasons.join(' '), /escalate to \/mandrel-plan/);
  });

  test('a commit-first refusal with no branch name still reads as an instruction', () => {
    const r = checkLightDiffBackstop({
      changedFiles: [],
      magnitude: magnitudeOf(1, 10),
      uncommittedWork: true,
    });
    assert.match(r.reasons.join(' '), /commit them on the Story branch/);
  });
});

describe('the light-refusal friction category encodes the refusal class', () => {
  test('a class-less refusal keeps the bare category', () => {
    assert.equal(
      RUNTIME_FRICTION_CATEGORIES.LIGHT_SCOPE_REJECTED,
      'light-scope-rejected',
    );
    assert.equal(
      lightScopeRejectedCategory(null),
      'light-scope-rejected',
      'the suitability gate refuses before any diff exists',
    );
    for (const blank of [undefined, '', '   ', 42]) {
      assert.equal(lightScopeRejectedCategory(blank), 'light-scope-rejected');
    }
  });

  test('a classed refusal files under its own category', () => {
    assert.equal(
      lightScopeRejectedCategory(LIGHT_REFUSAL_CLASSES.SENSITIVE_PATH),
      'light-scope-rejected-sensitive-path',
    );
    assert.notEqual(
      lightScopeRejectedCategory(LIGHT_REFUSAL_CLASSES.SENSITIVE_PATH),
      lightScopeRejectedCategory(LIGHT_REFUSAL_CLASSES.CHANGE_SET_UNKNOWN),
    );
  });

  test('the suitability GATE refusal is unchanged — it still emits the bare category', async () => {
    const seen = [];
    await recordGateRefusal({
      gate: { action: 'escalate-plan', outcome: { reasons: ['too broad'] } },
      amends: '#4741',
      emitFn: async (args) => {
        seen.push(args);
        return true;
      },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].category, 'light-scope-rejected');
    assert.equal(seen[0].details.surface, 'suitability-gate');
  });

  test('the diff-backstop refusal emits the CLASSED category and records the class', async () => {
    const seen = [];
    const emitFor = async (refusalClass) => {
      await handleBlockedBackstop({
        storyId: 4741,
        result: { reasons: ['blocked'], refusalClass },
        preservation: { preserved: true },
        emitFn: async (args) => {
          seen.push(args);
          return true;
        },
      });
    };
    await emitFor(LIGHT_REFUSAL_CLASSES.SENSITIVE_PATH);
    await emitFor(LIGHT_REFUSAL_CLASSES.CHANGE_SET_UNKNOWN);

    assert.equal(seen[0].category, 'light-scope-rejected-sensitive-path');
    assert.equal(seen[1].category, 'light-scope-rejected-change-set-unknown');
    // The class rides in `details` too, so a filed body can name it.
    assert.equal(seen[0].details.refusalClass, 'sensitive-path');
    // Both still start with the shared stem, so a `friction::light-scope-*`
    // filter still finds every light-path refusal.
    for (const signal of seen) {
      assert.match(signal.category, /^light-scope-rejected-/);
    }
  });

  test('an uncommitted-work refusal hands back the backstop RE-RUN, not the recycle command', async () => {
    const next = await handleBlockedBackstop({
      storyId: 4741,
      result: {
        reasons: ['empty but dirty'],
        refusalClass: LIGHT_REFUSAL_CLASSES.UNCOMMITTED_WORK,
      },
      emitFn: async () => true,
    });
    assert.match(next, /--backstop --story 4741/);
    assert.ok(
      !next.includes('/mandrel-plan'),
      'committing is not an escalation',
    );
  });
});

describe('resolveBackstopOutcome — the commit-first refusal end to end', () => {
  /** A `git worktree list --porcelain` block for one branch checkout. */
  const porcelain = (branch, wtPath) =>
    `worktree ${wtPath}\nHEAD abc123\nbranch refs/heads/${branch}\n`;

  test('an empty diff over a dirty Story worktree blocks with commit-first guidance', async () => {
    const outcome = await resolveBackstopOutcome({
      storyId: 4741,
      injectedRules: RULES,
      computeFn: () => ({ files: [] }),
      readRowsFn: () => rowsOf([1, 0, 'bin/hello.js']),
      dirtyProbeFn: () => true,
      preserveFn: () => {
        throw new Error('must not push a branch with nothing committed');
      },
    });

    assert.equal(outcome.result.blocked, true);
    assert.equal(outcome.exitCode, 3);
    assert.equal(
      outcome.result.refusalClass,
      LIGHT_REFUSAL_CLASSES.UNCOMMITTED_WORK,
    );
    assert.equal(outcome.preservation, null);
    assert.match(outcome.message, /commit on story-4741/);
    assert.match(outcome.message, /commit them on story-4741/);
    assert.match(outcome.message, /--backstop --story 4741/);
    assert.ok(
      !outcome.nextCommand.includes('/mandrel-plan'),
      'the receipt is not recycled for work that was merely not committed',
    );
  });

  test('an empty diff over a CLEAN worktree is unchanged — escalate and recycle', async () => {
    const outcome = await resolveBackstopOutcome({
      storyId: 4741,
      injectedRules: RULES,
      computeFn: () => ({ files: [] }),
      readRowsFn: () => rowsOf([1, 0, 'bin/hello.js']),
      dirtyProbeFn: () => false,
      handleBlockedFn: async () => '/mandrel-plan 4741',
      preserveFn: () => ({
        preserved: true,
        branch: 'story-4741',
        remoteRef: 'origin/story-4741',
        detail: 'stub',
      }),
    });

    assert.equal(outcome.exitCode, 3);
    assert.equal(
      outcome.result.refusalClass,
      LIGHT_REFUSAL_CLASSES.CHANGE_SET_UNKNOWN,
    );
    assert.equal(outcome.nextCommand, '/mandrel-plan 4741');
    assert.match(outcome.message, /recycle the receipt/);
    assert.equal(outcome.preservation.preserved, true);
  });

  test('the dirty probe reads the STORY branch worktree, and only when the diff is empty', async () => {
    const calls = [];
    const gitFn = (cwd, ...args) => {
      calls.push({ cwd, args });
      if (args[0] === 'worktree') {
        return {
          status: 0,
          stdout: `${porcelain('main', '/repo')}\n${porcelain('story-4741', '/repo/.worktrees/story-4741')}`,
        };
      }
      return { status: 0, stdout: ' M bin/hello.js\n' };
    };

    const dirty = await resolveBackstopOutcome({
      storyId: 4741,
      cwd: '/repo',
      injectedRules: RULES,
      computeFn: () => ({ files: [] }),
      readRowsFn: () => rowsOf([1, 0, 'bin/hello.js']),
      gitFn,
      preserveFn: () => {
        throw new Error('unreachable');
      },
    });
    assert.equal(
      dirty.result.refusalClass,
      LIGHT_REFUSAL_CLASSES.UNCOMMITTED_WORK,
    );
    // The status read is scoped to the Story branch's own checkout — the main
    // checkout's dirt is not the Story's evidence.
    const status = calls.find((c) => c.args[0] === 'status');
    assert.equal(status.cwd, '/repo/.worktrees/story-4741');

    // A NON-empty diff spends no git calls on the probe at all.
    calls.length = 0;
    await resolveBackstopOutcome({
      storyId: 4741,
      cwd: '/repo',
      injectedRules: RULES,
      computeFn: () => ({ files: ['bin/hello.js'] }),
      readRowsFn: () => rowsOf([1, 0, 'bin/hello.js']),
      gitFn,
    });
    assert.deepEqual(calls, [], 'the probe is skipped when it cannot matter');
  });

  test('an unreadable probe surface answers "clean" — it cannot invent friendlier guidance', async () => {
    const surfaces = [
      // `git worktree list` failed.
      () => ({ status: 1, stdout: '' }),
      // The branch has no checkout at all.
      (_cwd, ...args) =>
        args[0] === 'worktree'
          ? { status: 0, stdout: porcelain('main', '/repo') }
          : { status: 0, stdout: ' M x\n' },
      // `git status` failed in the resolved worktree.
      (_cwd, ...args) =>
        args[0] === 'worktree'
          ? { status: 0, stdout: porcelain('story-4741', '/wt') }
          : { status: 128, stdout: '' },
      // git threw outright.
      () => {
        throw new Error('git exploded');
      },
    ];

    for (const gitFn of surfaces) {
      const outcome = await resolveBackstopOutcome({
        storyId: 4741,
        cwd: '/repo',
        injectedRules: RULES,
        computeFn: () => ({ files: [] }),
        readRowsFn: () => rowsOf([1, 0, 'bin/hello.js']),
        gitFn,
        handleBlockedFn: async () => '/mandrel-plan 4741',
        preserveFn: () => ({
          preserved: true,
          branch: 'story-4741',
          remoteRef: 'origin/story-4741',
          detail: 'stub',
        }),
      });
      assert.equal(
        outcome.result.refusalClass,
        LIGHT_REFUSAL_CLASSES.CHANGE_SET_UNKNOWN,
      );
    }
  });
});

describe('the backstop verdict stays pure (Story #5238)', () => {
  test('light-suitability.js invokes no git and no child process', () => {
    const src = readFileSync(
      path.join(
        REPO_ROOT,
        '.agents',
        'scripts',
        'lib',
        'orchestration',
        'light-suitability.js',
      ),
      'utf8',
    );
    // The dirty-tree probe is I/O and belongs to the wrapper; the verdict must
    // remain a pure function of what it is handed.
    for (const forbidden of [/gitSpawn/, /child_process/, /execFileSync/]) {
      assert.doesNotMatch(src, forbidden);
    }
  });

  test('the workflow tells the agent the backstop reads COMMITTED state', () => {
    const doc = readDoc(
      path.join(
        REPO_ROOT,
        '.agents',
        'workflows',
        'helpers',
        'deliver-light.md',
      ),
    );
    assertDocMentions(
      doc,
      /measures \*\*committed\*\* state/i,
      'deliver-light.md must say the backstop reads committed state',
    );
    assertDocMentions(
      doc,
      /commit on `story-<id>`, then re-run the backstop/i,
      'deliver-light.md must name the commit-first fix',
    );
  });
});

// ---------------------------------------------------------------------------
// Story #5284 — a refusal class must stay nameable as a GitHub label
// ---------------------------------------------------------------------------

/**
 * GitHub's hard cap on a label NAME. Declared here rather than imported: the
 * graduator's `FRICTION_LABEL_PREFIX` is module-private, and exporting a
 * constant only a test consumes is what `check-dead-exports.js --production`
 * reds on. `tests/lib/label-constants.test.js` declares the description-length
 * cap the same way.
 */
const FRICTION_LABEL_MAX_LENGTH = 50;

describe('every refusal class survives the label mint', () => {
  test('no derived friction:: label exceeds the GitHub name cap', () => {
    // A refusal that cannot be labelled is a refusal that never gets filed:
    // `ensureIssueLabels` mints `friction::<category>` from live telemetry at
    // file time, so an over-long name fails the `gh issue create` and the
    // whole feedback loop records nothing for that class (Story #4828). The
    // longest name today is exactly at the cap, which is why this is a test
    // and not a comment.
    const overLong = [];
    for (const refusalClass of Object.values(LIGHT_REFUSAL_CLASSES)) {
      const label = `friction::${lightScopeRejectedCategory(refusalClass)}`;
      if (label.length > FRICTION_LABEL_MAX_LENGTH) {
        overLong.push(`${label} (${label.length})`);
      }
    }

    assert.deepEqual(
      overLong,
      [],
      `a friction:: label over ${FRICTION_LABEL_MAX_LENGTH} characters cannot be minted, so the refusal is never filed — shorten the refusal class`,
    );
  });

  test('the unclassified refusal is labellable too', () => {
    const label = `friction::${lightScopeRejectedCategory(null)}`;

    assert.equal(
      label,
      `friction::${RUNTIME_FRICTION_CATEGORIES.LIGHT_SCOPE_REJECTED}`,
    );
    assert.ok(label.length <= FRICTION_LABEL_MAX_LENGTH);
  });
});
