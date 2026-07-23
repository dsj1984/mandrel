// tests/lib/orchestration/complexity-gate.test.js
//
// Unit tier (Story #4683): the plan-time ceremony-lite complexity gate.
// Pins the deterministic trivial-vs-full routing (AC-1: a trivial seed routes
// `lite`, a multi-capability seed routes `full`), the configuration override
// knob, the conservative fail-toward-`full` posture, and — the AC-2 contract —
// that every `lite` decision preserves the non-negotiables (Story ticket, PR to
// main, repo gates, security baseline) that the collapsed path must never drop.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  AGENT_LABELS,
  TYPE_LABELS,
} from '../../../.agents/scripts/lib/label-constants.js';
import {
  applyPlannerDowngrade,
  buildComplexityRouteSignal,
  LITE_ROUTE_LABEL,
  resolveStoryDispatchMode,
} from '../../../.agents/scripts/lib/orchestration/complexity-gate.js';
import {
  assemblePlanStories,
  createStoryIssues,
} from '../../../.agents/scripts/lib/orchestration/plan-persist/story-ops.js';
import { serialize as serializeStoryBody } from '../../../.agents/scripts/lib/story-body/story-body.js';

describe('buildComplexityRouteSignal — deterministic routing (AC-1)', () => {
  test('a trivial single-artifact seed routes lite', () => {
    const signal = buildComplexityRouteSignal({
      seedText: 'Add a hello-world script that prints "hello" and exits 0.',
    });
    assert.equal(signal.route, 'lite');
    assert.equal(signal.advisory, true);
    assert.ok(Array.isArray(signal.reasons) && signal.reasons.length > 0);
    assert.match(signal.reasons[0], /trivial single-artifact scope/i);
  });

  test('a multi-capability enumerated seed routes full', () => {
    const seedText = [
      'Overhaul the platform:',
      '- add OAuth login',
      '- add a billing dashboard',
      '- add an admin audit log',
    ].join('\n');
    const signal = buildComplexityRouteSignal({ seedText });
    assert.equal(signal.route, 'full');
    assert.match(signal.reasons[0], /multi-capability scope/i);
  });

  test('deterministic — identical input yields an identical decision', () => {
    const seedText = 'Fix the footer copyright year.';
    const a = buildComplexityRouteSignal({ seedText });
    const b = buildComplexityRouteSignal({ seedText });
    assert.deepEqual(a, b);
    assert.equal(a.route, 'lite');
  });

  test('a single enumerated item (≤ maxArtifacts) still routes lite', () => {
    const signal = buildComplexityRouteSignal({
      seedText: 'Tidy the CLI help:\n- rename the --verbose flag to --debug',
    });
    assert.equal(signal.route, 'lite');
  });

  // Story #4707 AC-1: seed word count is a poor complexity proxy, so the
  // raised default (150) must admit a well-written ~70-word trivial seed —
  // the mandrel-bench hello-world shape that the old 60-word ceiling punished
  // with the full two-session ceremony.
  test('a 70-word single-artifact seed routes lite under the raised default', () => {
    const seedText =
      'Add a hello-world command-line script to the repository. The script ' +
      'should live at bin/hello.js, print the exact string "hello world" to ' +
      'standard output followed by a trailing newline, and then exit with ' +
      'status code zero. It takes no arguments and reads no input; any ' +
      'arguments passed on the command line are simply ignored rather than ' +
      'causing an error. Keep the implementation dependency-free plain Node, ' +
      'and document the one-line usage in the script header comment for ' +
      'future maintainers.';
    const wordCount = seedText.split(/\s+/).filter(Boolean).length;
    assert.ok(
      wordCount >= 65 && wordCount <= 150,
      `fixture seed should sit in the 65..150 word band (got ${wordCount})`,
    );
    const signal = buildComplexityRouteSignal({ seedText });
    assert.equal(signal.route, 'lite');
    assert.equal(signal.threshold.maxSeedWords, 150);
  });
});

describe('buildComplexityRouteSignal — conservative fail-toward-full', () => {
  test('an empty seed routes full (triviality cannot be judged)', () => {
    for (const seedText of ['', '   \n\t', undefined, null]) {
      const signal = buildComplexityRouteSignal({ seedText });
      assert.equal(signal.route, 'full');
    }
  });

  test('a seed above the word ceiling routes full', () => {
    const seedText = `refactor ${'word '.repeat(160)}`.trim();
    const signal = buildComplexityRouteSignal({ seedText });
    assert.equal(signal.route, 'full');
    assert.match(signal.reasons[0], /not a trivial scope/i);
  });
});

describe('buildComplexityRouteSignal — configuration override knob (AC-1)', () => {
  test('planning.complexityGate.enabled=false forces every seed to full', () => {
    const signal = buildComplexityRouteSignal({
      seedText: 'trivial one-liner',
      config: { planning: { complexityGate: { enabled: false } } },
    });
    assert.equal(signal.route, 'full');
    assert.match(signal.reasons[0], /complexity gate disabled/i);
  });

  test('lowering maxSeedWords flips a formerly-lite seed to full', () => {
    const seedText = 'Add a small helper that formats a duration string.';
    assert.equal(buildComplexityRouteSignal({ seedText }).route, 'lite');
    const tightened = buildComplexityRouteSignal({
      seedText,
      config: { planning: { complexityGate: { maxSeedWords: 3 } } },
    });
    assert.equal(tightened.route, 'full');
    assert.equal(tightened.threshold.maxSeedWords, 3);
  });

  test('raising maxArtifacts admits a two-item seed to the lite path', () => {
    const seedText = 'Tidy up:\n- rename a flag\n- update its help text';
    assert.equal(buildComplexityRouteSignal({ seedText }).route, 'full');
    const widened = buildComplexityRouteSignal({
      seedText,
      config: { planning: { complexityGate: { maxArtifacts: 2 } } },
    });
    assert.equal(widened.route, 'lite');
    assert.equal(widened.threshold.maxArtifacts, 2);
  });

  test('a malformed/negative ceiling falls back to the conservative default', () => {
    const seedText = 'Add a small helper that formats a duration string.';
    const signal = buildComplexityRouteSignal({
      seedText,
      config: {
        planning: { complexityGate: { maxSeedWords: -5, maxArtifacts: 'x' } },
      },
    });
    // Defaults restored, so the trivial seed still routes lite.
    assert.equal(signal.route, 'lite');
    assert.equal(signal.threshold.maxSeedWords, 150);
    assert.equal(signal.threshold.maxArtifacts, 1);
  });
});

describe('applyPlannerDowngrade — auditable full → lite judgment (Story #4707)', () => {
  const fullSeed = `broad prose scope ${'word '.repeat(200)}`.trim();

  test('a full verdict downgrades to lite only with a recorded reason', () => {
    const full = buildComplexityRouteSignal({ seedText: fullSeed });
    assert.equal(full.route, 'full');
    const downgraded = applyPlannerDowngrade(full, {
      reason: 'single trivial artifact despite verbose seed prose',
    });
    assert.equal(downgraded.route, 'lite');
    assert.deepEqual(downgraded.downgraded, {
      from: 'full',
      reason: 'single trivial artifact despite verbose seed prose',
    });
    assert.ok(Object.isFrozen(downgraded.downgraded));
    assert.match(downgraded.reasons.at(-1), /planner downgrade full → lite/);
    // The lite non-negotiables ride along unchanged.
    assert.equal(downgraded.preserves.repoGates, true);
    // The original signal is never mutated — the gate's verdict survives.
    assert.equal(full.route, 'full');
    assert.equal(full.downgraded, undefined);
  });

  test('absent or empty reason: the deterministic verdict stands', () => {
    const full = buildComplexityRouteSignal({ seedText: fullSeed });
    for (const reason of [undefined, null, '', '   ', 42]) {
      const result = applyPlannerDowngrade(full, { reason });
      assert.equal(result, full, 'signal must be returned unchanged');
      assert.equal(result.route, 'full');
    }
    assert.equal(applyPlannerDowngrade(full), full);
  });

  test('a non-full signal is returned unchanged (nothing to downgrade)', () => {
    const lite = buildComplexityRouteSignal({ seedText: 'trivial fix' });
    assert.equal(lite.route, 'lite');
    assert.equal(applyPlannerDowngrade(lite, { reason: 'noop' }), lite);
    assert.equal(applyPlannerDowngrade(null, { reason: 'noop' }), null);
    assert.equal(
      applyPlannerDowngrade(undefined, { reason: 'noop' }),
      undefined,
    );
  });
});

describe('resolveStoryDispatchMode — lite-route inline dispatch (Story #4707)', () => {
  test('a Story carrying the route::lite marker executes inline', () => {
    const decision = resolveStoryDispatchMode({
      labels: ['type::story', 'agent::ready', LITE_ROUTE_LABEL],
    });
    assert.equal(decision.mode, 'inline');
    assert.match(decision.reasons[0], /route::lite/);
    assert.match(decision.reasons[0], /close gates unchanged/i);
  });

  test('a Story without the marker takes the standard sub-agent path', () => {
    const decision = resolveStoryDispatchMode({
      labels: ['type::story', 'agent::ready'],
    });
    assert.equal(decision.mode, 'subagent');
  });

  test('missing or malformed labels default conservatively to subagent', () => {
    for (const labels of [undefined, null, 'route::lite', [42, {}]]) {
      assert.equal(resolveStoryDispatchMode({ labels }).mode, 'subagent');
    }
    assert.equal(resolveStoryDispatchMode().mode, 'subagent');
  });

  test('the marker constant is the persisted label shape /deliver reads', () => {
    assert.equal(LITE_ROUTE_LABEL, 'route::lite');
  });
});

describe('buildComplexityRouteSignal — lite-path non-negotiables (AC-2)', () => {
  const NON_NEGOTIABLES = [
    'storyTicket',
    'prToMain',
    'repoGates',
    'securityBaseline',
  ];

  test('every lite decision preserves the Story ticket, PR-to-main, gates, and security baseline', () => {
    const signal = buildComplexityRouteSignal({
      seedText: 'Add a hello-world script that prints "hello".',
    });
    assert.equal(signal.route, 'lite');
    assert.ok(signal.preserves && typeof signal.preserves === 'object');
    for (const key of NON_NEGOTIABLES) {
      assert.equal(
        signal.preserves[key],
        true,
        `lite path must preserve ${key}`,
      );
    }
  });

  test('the full route carries the same non-negotiables — no route ever drops one', () => {
    const signal = buildComplexityRouteSignal({
      seedText: 'Overhaul:\n- a\n- b\n- c',
    });
    assert.equal(signal.route, 'full');
    for (const key of NON_NEGOTIABLES) {
      assert.equal(signal.preserves[key], true);
    }
  });

  test('the preserves contract is immutable (frozen)', () => {
    const signal = buildComplexityRouteSignal({ seedText: 'trivial' });
    assert.ok(Object.isFrozen(signal.preserves));
  });
});

// AC-2 asks for the lite-path guarantee to be "contract-asserted on a fixture
// repo or injected provider" — not merely a self-attesting boolean. The check
// below drives a lite-routed seed through the SAME persist engine a
// full-ceremony Story uses, backed by an injected `createIssue` provider, and
// asserts a real `type::story` ticket is produced. Because the lite route forks
// no delivery code — the produced ticket is an ordinary Story that `/deliver`
// picks up and `single-story-close.js` PRs to `main` and gates unchanged — a
// Story ticket carrying `type::story` (and no gate-bypass marker) is the honest
// evidence that the lite path still lands through the gated PR-to-main pipeline.
describe('ceremony-lite path produces a real Story ticket via an injected provider (AC-2)', () => {
  test('a lite-routed trivial seed yields a type::story ticket through the unchanged persist engine', async () => {
    const seedText = 'Add a hello-world script that prints "hello".';
    const route = buildComplexityRouteSignal({ seedText });
    assert.equal(route.route, 'lite');

    // The lite path authors one minimal Story and hands it to the standard
    // persist + close engine (no forked delivery path).
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

    // A Story ticket was actually produced through the injected provider.
    assert.equal(created.length, 1);
    assert.equal(calls.length, 1);

    // storyTicket invariant: it is a `type::story` issue, which is exactly what
    // `/deliver` consumes to open a PR to `main` and run the repo gates.
    assert.ok(calls[0].labels.includes(TYPE_LABELS.STORY));

    // The lite route introduces NO gate bypass: no lite-specific / skip label on
    // the created Story, and it is not born `agent::ready` (the standard
    // terminal-flip contract), so the collapsed path cannot shortcut delivery.
    assert.deepEqual(
      calls[0].labels.filter((l) => /lite|skip|no-?gate/i.test(l)),
      [],
    );
    assert.ok(!calls[0].labels.includes(AGENT_LABELS.READY));

    // And the route signal itself is advisory-only, carrying no executable
    // gate-skip field — its whole surface is {route, reasons, threshold,
    // preserves, advisory}. The preserves contract binds the non-negotiables the
    // unchanged close still runs.
    assert.equal(route.advisory, true);
    assert.deepEqual(Object.keys(route).sort(), [
      'advisory',
      'preserves',
      'reasons',
      'route',
      'threshold',
    ]);
    assert.equal(route.preserves.prToMain, true);
    assert.equal(route.preserves.repoGates, true);
    assert.equal(route.preserves.securityBaseline, true);
  });
});
