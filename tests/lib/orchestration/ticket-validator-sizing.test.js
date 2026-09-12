/**
 * tests/lib/orchestration/ticket-validator-sizing.test.js
 *
 * Story #5312 deleted the numeric sizing model this file used to exercise —
 * `DEFAULT_MODEL_CAPACITY`, the `wide` declaration, `estimateStorySessionMass`
 * and the `oversized-task` / `soft-session-pressure` / `wide-undeclared` /
 * `merge-candidate` / `unanchored-constant` / `missing-reason-to-exist`
 * findings. What survives is the authoring guidance the prompt and the
 * `core/scope-triage` skill both cite, and the validator no longer scores a
 * Story's size at all: a 3000-word Spec with a broad footprint validates
 * exactly like a one-liner.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { validateAndNormalizeTickets } from '../../../.agents/scripts/lib/orchestration/ticket-validator.js';
import * as sizing from '../../../.agents/scripts/lib/orchestration/ticket-validator-sizing.js';
import { serialize as serializeStoryBody } from '../../../.agents/scripts/lib/story-body/story-body.js';

const { AUTHORING_ALTITUDE_GUIDANCE, DELIVERABLE_GRANULARITY_GUIDANCE } =
  sizing;

describe('authoring guidance constants — the surviving surface', () => {
  test('DELIVERABLE_GRANULARITY_GUIDANCE carries the three prose rules, frozen', () => {
    assert.ok(Object.isFrozen(DELIVERABLE_GRANULARITY_GUIDANCE));
    for (const key of ['definition', 'singleConsumerRule', 'envelopeFloor']) {
      assert.equal(typeof DELIVERABLE_GRANULARITY_GUIDANCE[key], 'string');
      assert.ok(DELIVERABLE_GRANULARITY_GUIDANCE[key].length > 40, key);
    }
    assert.match(
      DELIVERABLE_GRANULARITY_GUIDANCE.definition,
      /capability slice a frontier model delivers/,
    );
  });

  test('AUTHORING_ALTITUDE_GUIDANCE states the binding-vs-advisory split and the warning-shaped probes', () => {
    assert.ok(Object.isFrozen(AUTHORING_ALTITUDE_GUIDANCE));
    assert.match(AUTHORING_ALTITUDE_GUIDANCE.altitude, /binding contract/);
    assert.match(
      AUTHORING_ALTITUDE_GUIDANCE.advisoryCaveat,
      /dry-run warning/,
      'the caveat names the demoted probes as warnings, not refusals',
    );
    assert.match(
      AUTHORING_ALTITUDE_GUIDANCE.advisoryCaveat,
      /`deletes` naming a path absent at base is refused/,
    );
    assert.match(AUTHORING_ALTITUDE_GUIDANCE.newFileContract, /creates/);
  });

  test('the numeric sizing model is gone — no capacity constant, no mass estimator', () => {
    for (const retired of [
      'DEFAULT_MODEL_CAPACITY',
      'resolveCapacityCeilings',
      'estimateStorySessionMass',
      'computeSizingFindings',
      'renderHardFindingError',
    ]) {
      assert.equal(retired in sizing, false, `${retired} must not be exported`);
    }
  });
});

describe('the validator scores no Story size (Story #5312)', () => {
  function story(overrides = {}) {
    const body = {
      goal: 'Deliver the whole cutover in one pass.',
      spec: 'Contract prose. '.repeat(2000),
      changes: Array.from({ length: 60 }, (_, i) => ({
        path: `lib/module-${i}.js`,
        assumption: 'refactors-existing',
      })),
      acceptance: ['the cutover lands'],
      verify: ['npm test'],
      ...overrides,
    };
    return {
      slug: 'wide-story',
      type: 'story',
      title: 'Wide story',
      acceptance: body.acceptance,
      verify: body.verify,
      body: serializeStoryBody(body),
    };
  }

  test('a Story with a 3000+ word Spec and sixty changes validates with zero findings and zero errors', () => {
    const validated = validateAndNormalizeTickets([story()]);
    assert.deepEqual(validated.errors, []);
    assert.deepEqual(validated.warnings, []);
    assert.deepEqual(
      validated.findings.filter((f) => f.severity === 'hard'),
      [],
    );
    assert.ok(
      validated.findings.every(
        (f) =>
          ![
            'oversized-task',
            'soft-session-pressure',
            'wide-undeclared',
            'merge-candidate',
            'unanchored-constant',
            'missing-reason-to-exist',
            'spec-word-budget',
          ].includes(f.kind),
      ),
      'no retired sizing finding kind survives',
    );
  });

  test('an acceptance criterion naming a bare constant ("within the retention window") is not a finding', () => {
    const validated = validateAndNormalizeTickets([
      story({
        acceptance: ['expired rows are purged within the retention window'],
      }),
    ]);
    assert.deepEqual(validated.findings, []);
  });

  test('a thin depends_on fragment is not a merge candidate', () => {
    const tickets = [
      { ...story(), slug: 'producer' },
      {
        ...story({
          spec: '',
          changes: [{ path: 'lib/tail.js', assumption: 'creates' }],
        }),
        slug: 'consumer',
        depends_on: ['producer'],
      },
    ];
    const validated = validateAndNormalizeTickets(tickets);
    assert.equal(
      validated.findings.some((f) => f.kind === 'merge-candidate'),
      false,
    );
  });
});
