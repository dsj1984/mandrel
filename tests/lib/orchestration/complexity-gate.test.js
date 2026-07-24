// tests/lib/orchestration/complexity-gate.test.js
//
// Unit tier (Story #4722): shape-derived complexity routing. Pins that
// complexity routes on the objective shape of the authored work — never on
// seed word count (AC-1) — via four staged surfaces:
//
//   - `buildComplexitySignals`      — advisory plan-time signals with no
//                                     routing authority (AC-2);
//   - `resolvePlannerRouteVerdict`  — the planner's authored verdict, lite
//                                     only with a recorded reason (AC-2);
//   - `deriveStoryShape`            — the deterministic shape backstop over
//                                     the authored Story (AC-3, AC-6);
//   - `resolveStoryDispatchMode`    — `/deliver`'s body-derived dispatch
//                                     decision; the `route::lite` label is a
//                                     hint, never the control signal
//                                     (AC-4, AC-5).

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  AGENT_LABELS,
  TYPE_LABELS,
} from '../../../.agents/scripts/lib/label-constants.js';
import { resolveCeremonyForRisk } from '../../../.agents/scripts/lib/orchestration/ceremony-routing.js';
import {
  buildComplexitySignals,
  deriveStoryShape,
  LITE_ROUTE_LABEL,
  resolvePlannerRouteVerdict,
  resolveStoryDispatchMode,
} from '../../../.agents/scripts/lib/orchestration/complexity-gate.js';
import {
  assemblePlanStories,
  createStoryIssues,
} from '../../../.agents/scripts/lib/orchestration/plan-persist/story-ops.js';
import { deriveChangeLevel } from '../../../.agents/scripts/lib/orchestration/review-depth.js';
import { serialize as serializeStoryBody } from '../../../.agents/scripts/lib/story-body/story-body.js';

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
    reason_to_exist: 'Test fixture.',
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

  test('reports the enumerated-artifact count with the configured threshold beside it', () => {
    const signals = buildComplexitySignals({
      seedText: 'Overhaul:\n- add login\n- add billing\n- add audit log',
      config: { planning: { complexityGate: { maxArtifacts: 2 } } },
    });
    assert.equal(signals.artifactCount, 3);
    assert.equal(signals.maxArtifacts, 2);
  });

  test('reports planning.riskHeuristics phrases present in the seed', () => {
    const signals = buildComplexitySignals({
      seedText: 'Touches the payment flow and adds a schema migration.',
      riskHeuristics: ['payment flow', 'schema migration', 'auth token'],
    });
    assert.deepEqual(signals.riskHeuristicHits, [
      'payment flow',
      'schema migration',
    ]);
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

  test('is total: an empty seed yields empty signals, never a throw', () => {
    for (const seedText of ['', undefined, null]) {
      const signals = buildComplexitySignals({ seedText });
      assert.equal(signals.artifactCount, 0);
      assert.deepEqual(signals.predictedPaths, []);
      assert.deepEqual(signals.riskHeuristicHits, []);
    }
  });
});

describe('resolvePlannerRouteVerdict — the authored verdict, ledgerable (AC-2)', () => {
  test('lite only with a recorded reason, frozen for the checkpoint ledger', () => {
    const verdict = resolvePlannerRouteVerdict({
      reason: 'single trivial artifact despite verbose seed prose',
    });
    assert.equal(verdict.route, 'lite');
    assert.deepEqual(verdict.authored, {
      route: 'lite',
      reason: 'single trivial artifact despite verbose seed prose',
    });
    assert.ok(Object.isFrozen(verdict.authored));
    assert.equal(verdict.preserves.repoGates, true);
  });

  test('absent or empty reason: the conservative full default stands', () => {
    for (const reason of [undefined, null, '', '   ', 42]) {
      const verdict = resolvePlannerRouteVerdict({ reason });
      assert.equal(verdict.route, 'full');
      assert.equal(verdict.authored, null);
    }
    assert.equal(resolvePlannerRouteVerdict().route, 'full');
  });
});

describe('deriveStoryShape — the deterministic backstop (AC-1, AC-3)', () => {
  test('a genuinely small Story derives lite, with the shape as evidence', () => {
    const derived = deriveStoryShape(TRIVIAL);
    assert.equal(derived.route, 'lite');
    assert.match(derived.reasons[0], /trivial shape/i);
    assert.deepEqual(derived.shape, {
      changeCount: 1,
      acceptanceCount: 1,
      createCount: 1,
      nonCreateCount: 0,
      sensitiveClasses: [],
    });
  });

  test('AC-1: a terse Story with a wide footprint derives full — words never route', () => {
    // Five changes, described tersely: word count would call this trivial.
    const derived = deriveStoryShape({
      changes: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'].map((p) => ({
        path: `src/${p}`,
        assumption: 'refactors-existing',
      })),
      acceptance: ['works'],
      injectedRules: RULES,
    });
    assert.equal(derived.route, 'full');
    assert.match(derived.reasons[0], /> maxChanges/);
  });

  test('AC-1: a verbose-but-trivial Story derives lite — prose length is not shape', () => {
    // A long spec around a one-create footprint: word count would call this
    // complex; the shape (derived from the serialized body) says lite.
    const decision = resolveStoryDispatchMode({
      body: storyBody({
        spec: `Context and constraints. ${'Detail sentence about the trivial script. '.repeat(60)}`,
        changes: [{ path: 'bin/hello.js', assumption: 'creates' }],
        acceptance: ['prints hello'],
      }),
      injectedRules: RULES,
    });
    assert.equal(decision.route.route, 'lite');
    assert.equal(decision.mode, 'inline');
  });

  test('exceeding the acceptance-criteria ceiling fails to full', () => {
    const derived = deriveStoryShape({
      ...TRIVIAL,
      acceptance: ['a', 'b', 'c', 'd'],
    });
    assert.equal(derived.route, 'full');
    assert.match(derived.reasons[0], /> maxAcceptance/);
  });

  test('a mostly-refactoring mix fails to full (creates-vs-refactors)', () => {
    const derived = deriveStoryShape({
      changes: [
        { path: 'src/one.js', assumption: 'refactors-existing' },
        { path: 'src/two.js', assumption: 'deletes' },
      ],
      acceptance: ['works'],
      injectedRules: RULES,
    });
    assert.equal(derived.route, 'full');
    assert.match(derived.reasons[0], /> maxNonCreateChanges/);
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
      maxChanges: 2,
      maxAcceptance: 3,
      maxNonCreateChanges: 1,
    });
    assert.equal(deriveStoryShape({}).ceilings, derived.ceilings);
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

describe('resolveStoryDispatchMode — body-derived dispatch (AC-4, AC-5)', () => {
  const liteBody = storyBody({
    changes: [{ path: 'bin/hello.js', assumption: 'creates' }],
    acceptance: ['prints hello'],
  });
  const fullBody = storyBody({
    changes: ['a', 'b', 'c'].map((p) => ({
      path: `src/${p}.js`,
      assumption: 'refactors-existing',
    })),
    acceptance: ['a works', 'b works', 'c works'],
  });

  test('AC-5: a lite-shaped Story executes inline with the route::lite label ABSENT', () => {
    const decision = resolveStoryDispatchMode({
      body: liteBody,
      labels: ['type::story', 'agent::ready'],
      injectedRules: RULES,
    });
    assert.equal(decision.mode, 'inline');
    assert.equal(decision.route.route, 'lite');
    assert.match(decision.reasons[0], /close gates unchanged/i);
    assert.match(
      decision.reasons.at(-1),
      /hint only/i,
      'the label is reported as a hint, never the control signal',
    );
  });

  test('the label present on a lite-shaped Story is consistent — still inline', () => {
    const decision = resolveStoryDispatchMode({
      body: liteBody,
      labels: ['type::story', LITE_ROUTE_LABEL],
      injectedRules: RULES,
    });
    assert.equal(decision.mode, 'inline');
  });

  test('the label NEVER routes: a full-shaped Story with route::lite dispatches subagent', () => {
    const decision = resolveStoryDispatchMode({
      body: fullBody,
      labels: ['type::story', LITE_ROUTE_LABEL],
      injectedRules: RULES,
    });
    assert.equal(decision.mode, 'subagent');
    assert.equal(decision.route.route, 'full');
  });

  test('AC-6: a sensitive-footprint Story dispatches subagent (fresh critic path)', () => {
    const decision = resolveStoryDispatchMode({
      body: storyBody({
        changes: [{ path: 'src/billing/banner.js', assumption: 'creates' }],
        acceptance: ['shows the banner'],
      }),
      labels: [LITE_ROUTE_LABEL],
      injectedRules: RULES,
    });
    assert.equal(decision.mode, 'subagent');
    assert.match(decision.reasons[0], /sensitivity wins/i);
  });

  test('a missing or unparseable body is conservative subagent — labels alone never route', () => {
    for (const body of [undefined, null, '', '   ']) {
      const decision = resolveStoryDispatchMode({
        body,
        labels: [LITE_ROUTE_LABEL],
        injectedRules: RULES,
      });
      assert.equal(decision.mode, 'subagent');
    }
    assert.equal(resolveStoryDispatchMode().mode, 'subagent');
  });

  test('planning.complexityGate.enabled=false disables inline dispatch everywhere', () => {
    const decision = resolveStoryDispatchMode({
      body: liteBody,
      labels: [LITE_ROUTE_LABEL],
      config: { planning: { complexityGate: { enabled: false } } },
      injectedRules: RULES,
    });
    assert.equal(decision.mode, 'subagent');
    assert.match(decision.reasons[0], /disabled/i);
  });

  test('the hint label constant keeps its persisted shape', () => {
    assert.equal(LITE_ROUTE_LABEL, 'route::lite');
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
    changes: ['a', 'b', 'c', 'd'].map((p) => ({
      path: `src/${p}.js`,
      assumption: 'refactors-existing',
    })),
    acceptance: ['a works', 'b works', 'c works', 'd works'],
  });
  const sensitiveBody = storyBody({
    changes: [{ path: 'src/billing/banner.js', assumption: 'creates' }],
    acceptance: ['shows the banner'],
  });

  test('AC-1: a single-Story run is inline even for a full-shaped Story', () => {
    const decision = resolveStoryDispatchMode({
      body: fullBody,
      labels: ['type::story'],
      storyCount: 1,
      injectedRules: RULES,
    });
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
      const decision = resolveStoryDispatchMode({
        body: fullBody,
        labels: ['type::story'],
        storyCount,
        injectedRules: RULES,
      });
      assert.equal(
        decision.mode,
        'subagent',
        `a ${storyCount}-Story run must retain role-scoped sub-agent dispatch`,
      );
    }
  });

  test('AC-2: the derived route is still reported inline, so ceremony reads the same shape', () => {
    const decision = resolveStoryDispatchMode({
      body: fullBody,
      storyCount: 1,
      injectedRules: RULES,
    });
    assert.equal(
      decision.route.route,
      'full',
      'inline changes WHERE the engine runs, never what the shape says about it',
    );

    const sensitive = resolveStoryDispatchMode({
      body: sensitiveBody,
      storyCount: 1,
      injectedRules: RULES,
    });
    assert.equal(sensitive.mode, 'inline');
    assert.equal(
      sensitive.route.route,
      'full',
      'a sensitive footprint still derives full — inline dispatch does not launder it to lite',
    );
  });

  test('a single-Story run is inline with an unparseable body (route reports null)', () => {
    const decision = resolveStoryDispatchMode({
      body: '   ',
      storyCount: 1,
      injectedRules: RULES,
    });
    assert.equal(decision.mode, 'inline');
    assert.equal(decision.route, null);
  });

  test('the shape kill-switch does not reach the topology rule', () => {
    const decision = resolveStoryDispatchMode({
      body: fullBody,
      storyCount: 1,
      config: { planning: { complexityGate: { enabled: false } } },
      injectedRules: RULES,
    });
    assert.equal(
      decision.mode,
      'inline',
      'planning.complexityGate governs shape derivation, not run topology',
    );
  });

  test('an unknown or non-single run size falls through to the shape decision', () => {
    for (const storyCount of [undefined, null, 0, '1', 1.5, -1]) {
      const decision = resolveStoryDispatchMode({
        body: fullBody,
        storyCount,
        injectedRules: RULES,
      });
      assert.equal(
        decision.mode,
        'subagent',
        `storyCount=${String(storyCount)} must never be read as a single-Story run`,
      );
    }
  });
});

// The lite path forks no delivery code: a lite-shaped Story is an ordinary
// `type::story` ticket that `/deliver` picks up and `single-story-close.js`
// PRs to `main` and gates unchanged. Driving a lite-shaped Story through the
// SAME persist engine (injected provider) and asserting a real, bypass-free
// Story ticket comes out is the honest evidence the non-negotiables hold.
describe('lite-shaped Stories land through the unchanged persist engine', () => {
  test('a lite-shaped Story yields a type::story ticket with no gate-bypass marker', async () => {
    const ticket = {
      slug: 'hello-world',
      type: 'story',
      title: 'Add hello-world script',
      body: serializeStoryBody({
        goal: 'Print hello and exit 0.',
        changes: [{ path: 'bin/hello.js', assumption: 'creates' }],
        acceptance: ['prints hello'],
        verify: ['node bin/hello.js (validate)'],
        reason_to_exist: 'Deliver a hello-world script.',
      }),
    };
    const { stories } = assemblePlanStories([ticket]);
    const derived = deriveStoryShape({
      changes: stories[0].bodyObject.changes,
      acceptance: stories[0].acceptance,
      injectedRules: RULES,
    });
    assert.equal(derived.route, 'lite');
    // Both routes preserve the non-negotiables — no route ever drops one.
    for (const key of [
      'storyTicket',
      'prToMain',
      'repoGates',
      'securityBaseline',
    ]) {
      assert.equal(derived.preserves[key], true);
      assert.equal(deriveStoryShape({}).preserves[key], true);
    }
    assert.ok(Object.isFrozen(derived.preserves));

    const calls = [];
    const provider = {
      createIssue: async (payload) => {
        calls.push(payload);
        return {
          id: 4200 + calls.length,
          url: `https://example/${calls.length}`,
        };
      },
    };
    const { created } = await createStoryIssues({ provider, stories });

    assert.equal(created.length, 1);
    assert.ok(calls[0].labels.includes(TYPE_LABELS.STORY));
    // No lite-specific / skip label on the created Story, and it is not born
    // `agent::ready` — the collapsed path cannot shortcut delivery.
    assert.deepEqual(
      calls[0].labels.filter((l) => /lite|skip|no-?gate/i.test(l)),
      [],
    );
    assert.ok(!calls[0].labels.includes(AGENT_LABELS.READY));
  });
});

// Persist and deliver read the SAME Story through two representations:
// persist feeds `deriveStoryShape` the assembled objects
// (`bodyObject.changes` / `acceptance`), deliver feeds
// `resolveStoryDispatchMode` the serialized body markdown and re-parses it.
// The docstring's claim that the two read points can never disagree is a
// contract, not a hope — pin it round-trip: assemble once, derive both ways,
// assert one route.
describe('persist ↔ deliver route round-trip — one shape, two read points', () => {
  const cases = [
    {
      name: 'a lite-shaped Story routes lite from both representations',
      ticket: {
        slug: 'lite-round-trip',
        type: 'story',
        title: 'Add a helper',
        body: storyBody({
          changes: [{ path: 'bin/helper.js', assumption: 'creates' }],
          acceptance: ['helper prints and exits 0'],
        }),
      },
      expectedRoute: 'lite',
      expectedMode: 'inline',
    },
    {
      name: 'a refactor-mix Story routes full from both representations',
      ticket: {
        slug: 'full-round-trip',
        type: 'story',
        title: 'Refactor two modules',
        body: storyBody({
          changes: [
            { path: 'src/one.js', assumption: 'refactors-existing' },
            { path: 'src/two.js', assumption: 'refactors-existing' },
          ],
          acceptance: ['both modules keep their contracts'],
        }),
      },
      expectedRoute: 'full',
      expectedMode: 'subagent',
    },
    {
      name: 'a sensitive-footprint Story routes full from both representations',
      ticket: {
        slug: 'sensitive-round-trip',
        type: 'story',
        title: 'Add an auth banner',
        body: storyBody({
          changes: [{ path: 'src/auth/banner.js', assumption: 'creates' }],
          acceptance: ['banner shows on the login page'],
        }),
      },
      expectedRoute: 'full',
      expectedMode: 'subagent',
    },
  ];

  for (const { name, ticket, expectedRoute, expectedMode } of cases) {
    test(name, () => {
      const { stories } = assemblePlanStories([ticket]);

      // Persist's read point: the assembled objects.
      const persistSide = deriveStoryShape({
        changes: stories[0].bodyObject.changes,
        acceptance: stories[0].acceptance,
        injectedRules: RULES,
      });
      // Deliver's read point: the serialized body markdown, re-parsed.
      const deliverSide = resolveStoryDispatchMode({
        body: stories[0].body,
        labels: [],
        injectedRules: RULES,
      });

      assert.equal(persistSide.route, expectedRoute);
      assert.equal(
        deliverSide.route.route,
        persistSide.route,
        'persist and deliver derived different routes from the same Story',
      );
      assert.equal(deliverSide.mode, expectedMode);
    });
  }
});
