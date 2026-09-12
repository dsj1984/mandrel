// tests/lib/orchestration/complexity-gate.test.js
//
// Unit tier (Story #4722): shape-derived complexity routing. Pins that
// complexity routes on the objective shape of the authored work — never on
// seed word count (AC-1) — via four staged surfaces:
//
//   - `buildComplexitySignals`      — advisory plan-time signals with no
//                                     routing authority (AC-2);
//   - (retired by Story #5312) the planner's authored verdict, lite
//                                     only with a recorded reason (AC-2);
//   - `deriveStoryShape`            — the deterministic shape backstop over
//                                     the authored Story (AC-3, AC-6);
//   - `resolveStoryDispatchMode`    — `/mandrel-deliver`'s body-derived dispatch
//                                     decision; the `route::lite` label is a
//                                     hint, never the control signal
//                                     (AC-4, AC-5).

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { resolveCeremonyForRisk } from '../../../.agents/scripts/lib/orchestration/ceremony-routing.js';
import {
  buildComplexitySignals,
  deriveStoryShape,
  resolveStoryDispatchMode,
  SHAPE_CODES,
} from '../../../.agents/scripts/lib/orchestration/complexity-gate.js';
import { deriveChangeLevel } from '../../../.agents/scripts/lib/orchestration/review-depth.js';
import {
  parse as parseStoryBody,
  serialize as serializeStoryBody,
} from '../../../.agents/scripts/lib/story-body/story-body.js';

/** Stand-in sensitive-path manifest, mirroring the review-depth fixtures. */
const RULES = {
  sensitivePaths: {
    security: { filePatterns: ['**/auth/**'] },
    billing: { filePatterns: ['**/billing/**'] },
  },
};

/** A genuinely trivial shape: one created artifact, one criterion. */
const TRIVIAL = {
  changes: [{ path: 'bin/hello.js', assumption: 'creates' }],
  acceptance: ['prints hello and exits 0'],
  injectedRules: RULES,
};

function storyBody({ changes, acceptance, spec }) {
  return serializeStoryBody({
    goal: 'Deliver the change.',
    ...(spec ? { spec } : {}),
    changes,
    acceptance,
    verify: ['npm test (unit)'],
  });
}

describe('buildComplexitySignals — signals, not routing (AC-1, AC-2)', () => {
  test('emits no route and no routing authority, regardless of word count', () => {
    for (const seedText of [
      'Fix the footer year.',
      `refactor ${'word '.repeat(400)}`.trim(),
    ]) {
      const signals = buildComplexitySignals({ seedText });
      assert.equal(signals.route, undefined, 'signals must carry no route');
      assert.equal(signals.routingAuthority, false);
      assert.equal(signals.advisory, true);
    }
  });

  test('classifies predicted paths against the sensitive-path taxonomy and repo state', () => {
    const signals = buildComplexitySignals({
      seedText:
        'Tweak src/auth/session.js and add the new src/widgets/list.js helper.',
      injectedRules: RULES,
      // path.resolve produces platform separators — normalize before the
      // suffix match so the probe also fires on Windows (backslash paths).
      pathExistsFn: (abs) =>
        abs.replaceAll('\\', '/').endsWith('src/auth/session.js'),
    });
    assert.deepEqual(signals.predictedPaths, [
      'src/auth/session.js',
      'src/widgets/list.js',
    ]);
    assert.deepEqual(signals.sensitivePathClasses, ['security']);
    assert.deepEqual(signals.repoState, {
      existingPaths: ['src/auth/session.js'],
      missingPaths: ['src/widgets/list.js'],
    });
  });

  test('reports the enumerated-artifact count with no threshold beside it (Story #5312)', () => {
    const signals = buildComplexitySignals({
      seedText: 'Overhaul:\n- add login\n- add billing\n- add audit log',
    });
    assert.equal(signals.artifactCount, 3);
    assert.equal('maxArtifacts' in signals, false);
    assert.equal('riskHeuristicHits' in signals, false);
    assert.equal('gate' in signals, false);
  });

  test('is total: an empty seed yields empty signals, never a throw', () => {
    for (const seedText of ['', undefined, null]) {
      const signals = buildComplexitySignals({ seedText });
      assert.equal(signals.artifactCount, 0);
      assert.deepEqual(signals.predictedPaths, []);
      assert.deepEqual(signals.sensitivePathClasses, []);
    }
  });
});

describe('deriveStoryShape — the deterministic backstop (AC-1, AC-3)', () => {
  test('a genuinely small Story derives lite, with the shape as evidence', () => {
    const derived = deriveStoryShape(TRIVIAL);
    assert.equal(derived.route, 'lite');
    assert.match(derived.reasons[0], /trivial shape/i);
    assert.deepEqual(derived.shape, {
      siteCount: 1,
      changeKinds: ['creates'],
      kindCount: 1,
      magnitude: 'moderate',
      uncertainty: 'determined',
      acceptanceCount: 1,
      deployables: [],
      migrationSpan: false,
      sensitiveClasses: [],
    });
  });

  test('AC-1: a terse Story with clearly-epic scope derives full — words never route', () => {
    // Two deployables behind a shared contract, described in three words:
    // word count would call this trivial.
    const derived = deriveStoryShape({
      changes: [
        { path: 'apps/api/src/handler.js', assumption: 'refactors-existing' },
        { path: 'apps/web/src/page.js', assumption: 'refactors-existing' },
      ],
      acceptance: ['works'],
      injectedRules: RULES,
    });
    assert.equal(derived.route, 'full');
    assert.match(derived.reasons[0], /> maxDeployables/);
  });

  test('AC-1: a verbose-but-trivial Story derives lite — prose length is not shape', () => {
    // A long spec around a one-create footprint: word count would call this
    // complex; the shape says lite because prose is not one of its inputs.
    const derived = deriveStoryShape({
      changes: [{ path: 'bin/hello.js', assumption: 'creates' }],
      acceptance: ['prints hello'],
      injectedRules: RULES,
    });
    assert.equal(derived.route, 'lite');
  });

  test('Story #4764: criterion count is contract detail, not effort — it no longer routes', () => {
    const derived = deriveStoryShape({
      ...TRIVIAL,
      acceptance: ['a', 'b', 'c', 'd', 'e'],
    });
    assert.equal(derived.route, 'lite');
  });

  test('more distinct change KINDS than the ceiling fails to full', () => {
    const derived = deriveStoryShape({
      changes: [
        { path: 'src/one.js', assumption: 'refactors-existing' },
        { path: 'src/two.js', assumption: 'deletes' },
        { path: 'src/three.js', assumption: 'creates' },
      ],
      acceptance: ['works'],
      injectedRules: RULES,
    });
    assert.equal(derived.route, 'full');
    assert.match(derived.reasons[0], /> maxChangeKinds/);
  });

  test('an unknown footprint is conservative full: empty, missing, glob, or unreadable', () => {
    for (const changes of [undefined, null, []]) {
      assert.equal(
        deriveStoryShape({ changes, acceptance: ['x'] }).route,
        'full',
      );
    }
    const glob = deriveStoryShape({
      ...TRIVIAL,
      changes: [{ path: 'src/**', assumption: 'creates' }],
    });
    assert.equal(glob.route, 'full');
    assert.match(glob.reasons[0], /glob/i);
    const unreadable = deriveStoryShape({
      ...TRIVIAL,
      changes: [{ notAPath: true }],
    });
    assert.equal(unreadable.route, 'full');
  });

  test('a Story with no acceptance criteria cannot be judged trivial', () => {
    assert.equal(
      deriveStoryShape({ ...TRIVIAL, acceptance: [] }).route,
      'full',
    );
  });

  test('the ceilings are frozen framework constants, carried on every decision', () => {
    const derived = deriveStoryShape(TRIVIAL);
    assert.ok(Object.isFrozen(derived.ceilings));
    assert.deepEqual(derived.ceilings, {
      maxChangeKinds: 2,
      maxMagnitude: 'moderate',
      maxUncertainty: 'determined',
      maxDeployables: 1,
    });
    assert.equal(deriveStoryShape({}).ceilings, derived.ceilings);
  });
});

// ---------------------------------------------------------------------------
// Story #4764 — effort and risk, never artifact cardinality
// ---------------------------------------------------------------------------
// The old ceilings counted the DECLARED footprint (maxChanges / maxAcceptance /
// maxNonCreateChanges). Cardinality gets triviality backwards in both
// directions, and the count is read off a guess the model makes before doing
// the work. These describes pin the replacement axes and — as load-bearing as
// the new rejections — pin that marginal small work is no longer rejected.

describe('effort, not artifact count (Story #4764 AC-1)', () => {
  test('three instances of ONE mechanical edit across three files is light', () => {
    // The case counting got backwards: high file count, trivial work. One kind
    // at three sites, so one kind.
    const derived = deriveStoryShape({
      changes: [
        { path: 'src/a.js', assumption: 'refactors-existing' },
        { path: 'src/b.js', assumption: 'refactors-existing' },
        { path: 'src/c.js', assumption: 'refactors-existing' },
      ],
      acceptance: ['every call site passes the new flag'],
      kinds: ['add-flag-to-call-site'],
      magnitude: 'trivial',
      injectedRules: RULES,
    });
    assert.equal(derived.route, 'lite');
    assert.equal(derived.shape.kindCount, 1);
    assert.equal(derived.shape.siteCount, 3);
  });

  test('an explicit kinds[] declaration is unnecessary — assumptions collapse to kinds', () => {
    const derived = deriveStoryShape({
      changes: ['a', 'b', 'c', 'd'].map((p) => ({
        path: `src/${p}.js`,
        assumption: 'refactors-existing',
      })),
      acceptance: ['works'],
      injectedRules: RULES,
    });
    assert.equal(derived.route, 'lite');
    assert.deepEqual(derived.shape.changeKinds, ['refactors-existing']);
  });

  test('a single SUBSTANTIAL rewrite of one file is NOT light — the other direction', () => {
    const derived = deriveStoryShape({
      changes: [{ path: 'src/reporting.js', assumption: 'refactors-existing' }],
      acceptance: ['the report renders identically'],
      magnitude: 'substantial',
      injectedRules: RULES,
    });
    assert.equal(derived.route, 'full');
    assert.match(derived.reasons[0], /maxMagnitude/);
  });

  test('undeclared magnitude carries no signal; a malformed one fails closed', () => {
    const absent = deriveStoryShape({ ...TRIVIAL, magnitude: undefined });
    assert.equal(absent.route, 'lite');
    assert.equal(absent.shape.magnitude, 'moderate');

    // Declared but unrecognized is a claim that cannot be verified as small,
    // so it takes the worst bucket on the scale rather than the default.
    for (const magnitude of ['enormous', 42, {}]) {
      assert.equal(
        deriveStoryShape({ ...TRIVIAL, magnitude }).route,
        'full',
        `magnitude ${JSON.stringify(magnitude)}`,
      );
    }
    // Case and padding are normalized, never rejected.
    assert.equal(
      deriveStoryShape({ ...TRIVIAL, magnitude: ' TRIVIAL ' }).route,
      'lite',
    );
  });

  test('open design decisions route full however small the footprint', () => {
    const derived = deriveStoryShape({
      ...TRIVIAL,
      uncertainty: 'needs-design',
    });
    assert.equal(derived.route, 'full');
    assert.match(
      derived.reasons[0],
      /design decisions \/mandrel-plan exists to resolve/,
    );
  });
});

describe('the prediction gate rejects only clearly-epic work (Story #4764 AC-3)', () => {
  test('marginal small work is no longer rejected on counts alone', () => {
    // Five files, four acceptance criteria, all refactors: over EVERY retired
    // ceiling (maxChanges 2, maxAcceptance 3, maxNonCreateChanges 1) and yet
    // plainly not epic.
    const derived = deriveStoryShape({
      changes: ['a', 'b', 'c', 'd', 'e'].map((p) => ({
        path: `src/widgets/${p}.js`,
        assumption: 'refactors-existing',
      })),
      acceptance: ['a works', 'b works', 'c works', 'd works'],
      injectedRules: RULES,
    });
    assert.equal(derived.route, 'lite');
  });

  const epicShapes = [
    {
      name: 'multiple deployables',
      args: {
        changes: [
          { path: 'apps/web/src/page.js', assumption: 'refactors-existing' },
          {
            path: 'services/sync/src/job.js',
            assumption: 'refactors-existing',
          },
        ],
        acceptance: ['both sides agree'],
      },
      reason: /maxDeployables/,
    },
    {
      name: 'a migration plus its consumers',
      args: {
        changes: [
          { path: 'db/migrations/0007_add_column.sql', assumption: 'creates' },
          { path: 'src/reports/query.js', assumption: 'refactors-existing' },
        ],
        acceptance: ['the report reads the new column'],
      },
      reason: /migration with its consumers/,
    },
    {
      name: 'an explicit multi-capability enumeration',
      args: {
        changes: [
          { path: 'src/one.js', assumption: 'creates' },
          { path: 'src/two.js', assumption: 'refactors-existing' },
          { path: 'src/three.js', assumption: 'refactors-existing' },
        ],
        acceptance: ['all three capabilities work'],
        kinds: ['new-endpoint', 'schema-widening', 'telemetry-rename'],
      },
      reason: /multi-capability enumeration/,
    },
  ];

  for (const { name, args, reason } of epicShapes) {
    test(`${name} still escalates`, () => {
      const derived = deriveStoryShape({ ...args, injectedRules: RULES });
      assert.equal(derived.route, 'full');
      assert.match(derived.reasons[0], reason);
    });
  }
});

describe('the benchmark rungs land on the right side (Story #4764 AC-5, AC-6)', () => {
  test('AC-5: the hello-world scenario is light — one create, one edit, one test, 4 criteria', () => {
    const derived = deriveStoryShape({
      changes: [
        { path: 'src/server.js', assumption: 'creates' },
        { path: 'package.json', assumption: 'refactors-existing' },
        { path: 'tests/server.test.js', assumption: 'creates' },
      ],
      acceptance: [
        'GET / returns 200',
        'the response body is "hello world"',
        'the server listens on the configured port',
        'npm test passes',
      ],
      magnitude: 'trivial',
      injectedRules: RULES,
    });
    assert.equal(
      derived.route,
      'lite',
      'the trivial bench rung must no longer sit structurally over the ceiling',
    );
  });

  test('AC-6: the epic-scope scenario still escalates — deployables behind a shared contract', () => {
    const derived = deriveStoryShape({
      changes: [
        { path: 'packages/contract/src/schema.js', assumption: 'creates' },
        { path: 'apps/api/src/handler.js', assumption: 'refactors-existing' },
        {
          path: 'apps/worker/src/consumer.js',
          assumption: 'refactors-existing',
        },
      ],
      acceptance: ['both deployables validate against the shared contract'],
      injectedRules: RULES,
    });
    assert.equal(derived.route, 'full');
    assert.match(derived.reasons[0], /deployables/);
  });
});

describe('deriveStoryShape — sensitivity wins (AC-6)', () => {
  test('a lite-shaped footprint intersecting a sensitive class derives full', () => {
    const derived = deriveStoryShape({
      changes: [{ path: 'src/auth/banner.js', assumption: 'creates' }],
      acceptance: ['shows the banner'],
      injectedRules: RULES,
    });
    assert.equal(derived.route, 'full');
    assert.deepEqual(derived.shape.sensitiveClasses, ['security']);
    assert.match(derived.reasons[0], /sensitivity wins/i);
    assert.match(derived.reasons[0], /fresh acceptance critic retained/i);
  });

  test('the full route keeps the fresh critic via the shared close taxonomy', () => {
    // The same taxonomy at both read points: the predicted footprint derives
    // `high` exactly as the landed diff would, and ceremony routing turns a
    // high level into a fresh-context critic — sensitivity overrides the lite
    // inline default end to end.
    const { level } = deriveChangeLevel({
      changedFiles: ['src/auth/banner.js'],
      injectedRules: RULES,
    });
    assert.equal(level, 'high');
    assert.equal(resolveCeremonyForRisk({ derivedLevel: level }).mode, 'fresh');
  });

  test('an unreadable sensitive-path manifest never buys lite', () => {
    const derived = deriveStoryShape({
      ...TRIVIAL,
      injectedRules: undefined,
      selectSensitivePathClassesFn: () => {
        throw new Error('manifest unreadable');
      },
    });
    assert.equal(derived.route, 'full');
  });
});

describe('resolveStoryDispatchMode — topology only (Story #5006)', () => {
  /**
   * AC-4's core claim: the dispatch decision reads `storyCount` and nothing
   * else. Proven structurally rather than by example — a probe object whose
   * every other key is an accessor records any read, so a future
   * reintroduction of the body parse fails here instead of quietly costing a
   * parse per Story.
   */
  function dispatchWithProbe(storyCount) {
    const touched = [];
    const probe = { storyCount };
    for (const key of [
      'body',
      'labels',
      'config',
      'injectedRules',
      'selectSensitivePathClassesFn',
    ]) {
      Object.defineProperty(probe, key, {
        enumerable: true,
        get() {
          touched.push(key);
          return undefined;
        },
      });
    }
    return { decision: resolveStoryDispatchMode(probe), touched };
  }

  test('AC-4: a single-Story run is inline, reading no body', () => {
    const { decision, touched } = dispatchWithProbe(1);
    assert.equal(decision.mode, 'inline');
    assert.deepEqual(
      touched,
      [],
      'dispatch must read storyCount alone — no body, label, config or rules access',
    );
  });

  test('AC-4: a multi-Story run is subagent, reading no body', () => {
    for (const storyCount of [2, 3, 12]) {
      const { decision, touched } = dispatchWithProbe(storyCount);
      assert.equal(decision.mode, 'subagent');
      assert.deepEqual(touched, []);
    }
  });

  test("AC-4: the verdict carries no route — the shape is the caller's to derive", () => {
    // `deriveStoryShape` is still the shape SSOT (persist and the light path
    // call it). What is gone is dispatch deriving a route no consumer read.
    assert.equal('route' in resolveStoryDispatchMode({ storyCount: 1 }), false);
    assert.equal('route' in resolveStoryDispatchMode({ storyCount: 4 }), false);
  });

  test('the label is inert: it is not even an argument any more', () => {
    const withLabel = resolveStoryDispatchMode({
      storyCount: 2,
      labels: ['type::story', 'route::lite'],
    });
    const without = resolveStoryDispatchMode({ storyCount: 2 });
    assert.deepEqual(withLabel, without);
  });
});

/**
 * Story #4736 — run topology decides ahead of shape.
 *
 * The premise under test: sub-agent isolation is load-bearing only against a
 * CONCURRENTLY-dispatched sibling (two workers sharing a checkout race on
 * worktrees and branch refs). A one-Story run has no sibling, so the spawn
 * premium buys nothing — and that is a fact about the run, not the work, which
 * is why it sits ahead of every shape read including the gate kill-switch.
 */
describe('resolveStoryDispatchMode — run topology (Story #4736)', () => {
  const fullBody = storyBody({
    changes: [
      { path: 'apps/api/src/handler.js', assumption: 'refactors-existing' },
      { path: 'apps/web/src/page.js', assumption: 'refactors-existing' },
    ],
    acceptance: ['a works', 'b works', 'c works', 'd works'],
  });
  const sensitiveBody = storyBody({
    changes: [{ path: 'src/billing/banner.js', assumption: 'creates' }],
    acceptance: ['shows the banner'],
  });

  test('AC-1: a single-Story run is inline even for a full-shaped Story', () => {
    const decision = resolveStoryDispatchMode({ storyCount: 1 });
    assert.equal(decision.mode, 'inline');
    assert.match(decision.reasons[0], /single-Story run/i);
    assert.match(
      decision.reasons[0],
      /concurrent/i,
      'the reason must name the premise — isolation only matters against a concurrent sibling',
    );
  });

  test('AC-1: a multi-Story run still dispatches sub-agents for full-shaped Stories', () => {
    for (const storyCount of [2, 3, 12]) {
      const decision = resolveStoryDispatchMode({ storyCount });
      assert.equal(
        decision.mode,
        'subagent',
        `a ${storyCount}-Story run must retain role-scoped sub-agent dispatch`,
      );
    }
  });

  test('AC-2: inline changes WHERE the engine runs, never the shape of the work', () => {
    // The shape SSOT is unaffected by the dispatch verdict: a full-shaped and
    // a sensitive-footprint Story both still derive `full`, and a run that
    // dispatches them inline does not launder either to lite.
    for (const body of [fullBody, sensitiveBody]) {
      const parsed = parseStoryBody(body).body;
      const derived = deriveStoryShape({
        changes: parsed.changes,
        acceptance: parsed.acceptance,
        injectedRules: RULES,
      });
      assert.equal(derived.route, 'full');
      assert.equal(resolveStoryDispatchMode({ storyCount: 1 }).mode, 'inline');
    }
  });

  test('an unknown or non-single run size is conservative sub-agent dispatch', () => {
    for (const storyCount of [undefined, null, 0, '1', 1.5, -1]) {
      const decision = resolveStoryDispatchMode({ storyCount });
      assert.equal(
        decision.mode,
        'subagent',
        `storyCount=${String(storyCount)} must never be read as a single-Story run`,
      );
    }
  });
});

/**
 * Story #4829 — an `inline` verdict must mean the engine can actually run
 * inline.
 *
 * `inline` names the router's OWN session (deliver-digest § 1). The shape path
 * used to return it for any lite-shaped body in a multi-Story run, inheriting
 * none of the topology guard the one-Story rule states for itself. Measured
 * twice on 2026-07-29 — `/mandrel-deliver 4824 4825` and `/mandrel-deliver 4828 4829 4830` —
 * every Story came back `inline` while `stories-wave-tick.js` reported the
 * whole set ready under a concurrency cap of five. A router following both
 * literally runs two or three engines over one session and one checkout. Both
 * runs were rescued by an operator serialising by hand, which is the invariant
 * being held by judgment rather than by code.
 *
 * These tests pin the two measured cases and the general law behind them.
 */
describe('resolveStoryDispatchMode — inline is one session, so one Story (#4829)', () => {
  /** The shape that used to buy `inline` unconditionally. */
  const liteBody = storyBody({
    changes: [{ path: 'bin/hello.js', assumption: 'creates' }],
    acceptance: ['prints hello'],
  });
  const fullBody = storyBody({
    changes: [
      { path: 'apps/api/src/handler.js', assumption: 'refactors-existing' },
      { path: 'apps/web/src/page.js', assumption: 'refactors-existing' },
    ],
    acceptance: ['both sides agree'],
  });

  test('AC-1: the measured two-Story and three-Story runs no longer claim the session', () => {
    for (const storyCount of [2, 3]) {
      // The body that used to buy `inline` unconditionally is still lite by
      // shape — it just no longer reaches the dispatch decision at all.
      const parsed = parseStoryBody(liteBody).body;
      assert.equal(
        deriveStoryShape({
          changes: parsed.changes,
          acceptance: parsed.acceptance,
          injectedRules: RULES,
        }).route,
        'lite',
      );

      const decision = resolveStoryDispatchMode({ storyCount });
      assert.equal(
        decision.mode,
        'subagent',
        `a lite-shaped Story in a ${storyCount}-Story run must not be told to run in the router's own session`,
      );
      assert.match(
        decision.reasons[0],
        /concurrent sibling/i,
        'the reason must name the premise, so a reader sees WHY a lite shape did not buy inline',
      );
    }
  });

  test('AC-2: the single-Story inline rule is untouched, whatever the shape', () => {
    // The shapes are enumerated to make the point explicit even though the
    // rule cannot see them: none of them can change a one-Story verdict.
    for (const _body of [liteBody, fullBody, '   ']) {
      const decision = resolveStoryDispatchMode({ storyCount: 1 });
      assert.equal(decision.mode, 'inline');
      assert.match(decision.reasons[0], /single-Story run/i);
    }
  });

  test('AC-3: inline implies a resolved set of exactly one — no input contradicts a ready set', () => {
    // The law, not an example: across every shape, label, gate setting and run
    // size, an `inline` verdict can only come back for a one-Story run. A ready
    // set of N > 1 therefore cannot coexist with a Story owning the session.
    const bodies = [liteBody, fullBody, '', undefined];
    const labelSets = [[], ['route::lite'], ['type::story']];
    const configs = [
      undefined,
      { planning: { complexityGate: { enabled: false } } },
    ];
    let inlineSeen = 0;
    for (const storyCount of [1, 2, 3, 4, 5]) {
      for (const body of bodies) {
        for (const labels of labelSets) {
          for (const config of configs) {
            // Every retired input is still passed: an argument the rule
            // ignores must stay unable to conjure a second session.
            const { mode } = resolveStoryDispatchMode({
              body,
              labels,
              config,
              storyCount,
              injectedRules: RULES,
            });
            if (mode === 'inline') {
              inlineSeen += 1;
              assert.equal(
                storyCount,
                1,
                `inline returned for a ${storyCount}-Story run (body=${String(body).slice(0, 24)}, labels=${labels.join('|')}) — the router cannot give one session to ${storyCount} Stories`,
              );
            }
          }
        }
      }
    }
    assert.ok(
      inlineSeen > 0,
      'no inline verdict was produced at all — the law would hold vacuously and prove nothing',
    );
  });
});

// ---------------------------------------------------------------------------
// Story #4815 — every decision carries a stable machine-readable `code`
// ---------------------------------------------------------------------------

describe('deriveStoryShape — a stable code names WHICH rule objected', () => {
  /** Minimal args that clear every rule, so a fixture varies one thing. */
  const LITE_ARGS = {
    changes: [{ path: 'src/one.ts', assumption: 'refactors-existing' }],
    acceptance: ['it works'],
    injectedRules: RULES,
  };

  test('a lite route carries no code — there is nothing to name', () => {
    const derived = deriveStoryShape(LITE_ARGS);
    assert.equal(derived.route, 'lite');
    assert.equal(derived.code, null);
  });

  const CASES = [
    [
      SHAPE_CODES.CHANGE_KINDS,
      { kinds: ['add-endpoint', 'migrate-schema', 'rewrite-client'] },
    ],
    [SHAPE_CODES.MAGNITUDE, { magnitude: 'substantial' }],
    [SHAPE_CODES.UNCERTAINTY, { uncertainty: 'needs-design' }],
    [
      SHAPE_CODES.DEPLOYABLE_SPAN,
      {
        changes: [
          { path: 'apps/web/a.ts', assumption: 'refactors-existing' },
          { path: 'apps/api/b.ts', assumption: 'refactors-existing' },
        ],
      },
    ],
    [
      SHAPE_CODES.MIGRATION_SPAN,
      {
        changes: [
          { path: 'db/migrations/001.sql', assumption: 'creates' },
          { path: 'src/reader.ts', assumption: 'refactors-existing' },
        ],
      },
    ],
    [
      SHAPE_CODES.SENSITIVE_PATH,
      { changes: [{ path: 'src/auth/session.ts', assumption: 'creates' }] },
    ],
    [SHAPE_CODES.NO_CHANGES, { changes: [] }],
    [
      SHAPE_CODES.GLOB_FOOTPRINT,
      { changes: [{ path: 'src/**/*.ts', assumption: 'creates' }] },
    ],
    [SHAPE_CODES.NO_ACCEPTANCE, { acceptance: [] }],
    [
      SHAPE_CODES.CLASSIFICATION_UNAVAILABLE,
      {
        selectSensitivePathClassesFn: () => {
          throw new Error('unreadable sensitive-path manifest');
        },
      },
    ],
  ];

  for (const [code, overrides] of CASES) {
    test(`routes full with code "${code}"`, () => {
      const derived = deriveStoryShape({ ...LITE_ARGS, ...overrides });
      assert.equal(derived.route, 'full');
      assert.equal(derived.code, code);
    });
  }

  test('the code is the branch surface, not the prose', () => {
    // The reason text is written for a human reading a gate envelope and is
    // free to be re-worded; a caller keying off it would break on a copy-edit.
    // This is why the light path's operator override reads `code` instead.
    const derived = deriveStoryShape({
      ...LITE_ARGS,
      changes: [
        { path: 'apps/web/a.ts', assumption: 'refactors-existing' },
        { path: 'apps/api/b.ts', assumption: 'refactors-existing' },
      ],
    });
    assert.equal(derived.code, SHAPE_CODES.DEPLOYABLE_SPAN);
    assert.equal(derived.reasons.length, 1);
    assert.match(derived.reasons[0], /maxDeployables/);
  });

  test('adding the code left every pre-existing field intact', () => {
    const derived = deriveStoryShape(LITE_ARGS);
    assert.deepEqual(Object.keys(derived).sort(), [
      'ceilings',
      'code',
      'preserves',
      'reasons',
      'route',
      'shape',
    ]);
    assert.equal(derived.ceilings.maxDeployables, 1);
    assert.equal(derived.preserves.repoGates, true);
    assert.equal(derived.shape.siteCount, 1);
  });
});
