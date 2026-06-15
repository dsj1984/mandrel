/**
 * tests/defect-class-retro-loop.test.js — Story #4135 (Epic #4131, F11)
 *
 * The defect-class retro→planner loop:
 *   1. `deriveDefectClasses` (retro side) lifts the recurring-defect-class
 *      signal from the routed-proposal actionable items the retro composer
 *      produced — these are review/deliver-caught friction categories that
 *      recurred ≥2 times (or were force-flagged by an unresolved blocker).
 *   2. The routed-proposals composer stamps each proposed `gh issue create`
 *      command with a `friction::<class>` label, so the filed meta issue
 *      carries the class as a durable, GitHub-side substrate.
 *   3. `extractRecurringDefectClasses` (fetcher side) reads those
 *      `friction::<class>` labels back off the open meta feedback issues, so
 *      the `/plan` Phase 0 prior-feedback fetcher surfaces the recurring
 *      classes to the decompose-author guidance.
 *
 * Both helpers are pure (no I/O, no spawn); the end-to-end test drives the
 * full loop with deterministic fixtures.
 */

import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import {
  extractRecurringDefectClasses,
  fetchPriorFeedback,
} from '../.agents/scripts/lib/feedback-loop/prior-feedback-fetcher.js';
import { composeRoutedProposals } from '../.agents/scripts/lib/orchestration/retro-proposals.js';
import { deriveDefectClasses } from '../.agents/scripts/lib/orchestration/retro-runner.js';

/**
 * Build a `spawnImpl` stub mirroring the prior-feedback-fetcher test seam:
 * the `responder` receives the args array and returns `{ stdout, stderr, code }`.
 */
function makeSpawnStub(responder) {
  return function spawnImpl(_cmd, args) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const result = responder(args);
    queueMicrotask(() => {
      if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
      child.emit('close', result.code);
    });
    return child;
  };
}

function flagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

describe('deriveDefectClasses (retro side)', () => {
  it('lifts recurring (≥2 occurrence) friction categories from routed proposals', () => {
    // Two `lint-loop` consumer-source frictions + three `flaky-test`
    // framework-source frictions → both are actionable (≥2). A single
    // `typo` friction is discarded by the composer and must NOT surface.
    const routedProposals = composeRoutedProposals({
      epicId: 4131,
      frameworkRepo: 'dsj1984/mandrel',
      consumerRepo: 'acme/app',
      signals: [
        { category: 'lint-loop', source: 'consumer' },
        { category: 'lint-loop', source: 'consumer' },
        { category: 'flaky-test', source: 'framework' },
        { category: 'flaky-test', source: 'framework' },
        { category: 'flaky-test', source: 'framework' },
        { category: 'typo', source: 'consumer' },
      ],
    });

    const classes = deriveDefectClasses(routedProposals);

    assert.deepEqual(
      classes.map((c) => c.category),
      ['flaky-test', 'lint-loop'],
      'recurring classes are sorted by category ASC',
    );
    const flaky = classes.find((c) => c.category === 'flaky-test');
    assert.equal(flaky.occurrences, 3);
    assert.equal(flaky.source, 'framework');
    assert.equal(
      flaky.label,
      'friction::flaky-test',
      'each class carries the friction::<class> join label',
    );
    const lint = classes.find((c) => c.category === 'lint-loop');
    assert.equal(lint.occurrences, 2);
    assert.equal(lint.source, 'consumer');
    assert.ok(
      !classes.some((c) => c.category === 'typo'),
      'single-occurrence (discarded) friction is not a recurring defect class',
    );
  });

  it('is no-op-safe: empty / clean-sprint / malformed routed proposals yield []', () => {
    assert.deepEqual(deriveDefectClasses(null), []);
    assert.deepEqual(deriveDefectClasses(undefined), []);
    assert.deepEqual(deriveDefectClasses('nope'), []);
    assert.deepEqual(deriveDefectClasses([]), []);
    assert.deepEqual(
      deriveDefectClasses({
        framework: [],
        consumer: [],
        memory: [],
        discarded: [],
      }),
      [],
      'a clean sprint with no actionable proposals derives no defect classes',
    );
  });
});

describe('extractRecurringDefectClasses (fetcher side)', () => {
  it('counts friction::<class> labels across feedback issues, recurring first', () => {
    const issues = [
      { number: 10, labels: ['meta::framework-gap', 'friction::flaky-test'] },
      {
        number: 11,
        labels: ['meta::consumer-improvement', 'friction::flaky-test'],
      },
      { number: 12, labels: ['meta::framework-gap', 'friction::lint-loop'] },
      { number: 13, labels: ['meta::consumer-improvement'] }, // no friction label
    ];

    const classes = extractRecurringDefectClasses(issues);

    assert.deepEqual(
      classes,
      [
        { class: 'flaky-test', count: 2, issues: [10, 11] },
        { class: 'lint-loop', count: 1, issues: [12] },
      ],
      'classes ordered by descending recurrence count, ties by name ASC',
    );
  });

  it('is no-op-safe: no friction labels / empty / non-array yields []', () => {
    assert.deepEqual(extractRecurringDefectClasses([]), []);
    assert.deepEqual(extractRecurringDefectClasses(null), []);
    assert.deepEqual(
      extractRecurringDefectClasses([
        { number: 1, labels: ['meta::framework-gap'] },
        { number: 2, labels: [] },
        { number: 3 },
      ]),
      [],
      'issues without a friction::* label contribute nothing',
    );
  });

  it('ignores empty/whitespace friction class suffixes', () => {
    const classes = extractRecurringDefectClasses([
      { number: 1, labels: ['friction::'] },
      { number: 2, labels: ['friction::   '] },
    ]);
    assert.deepEqual(classes, []);
  });
});

describe('fetchPriorFeedback envelope surfaces recurringDefectClasses (planner Phase 0)', () => {
  it('attaches recurringDefectClasses derived from the deduped feedback issues', async () => {
    const responder = (args) => {
      const label = flagValue(args, '--label');
      if (label === 'meta::framework-gap') {
        return {
          stdout: JSON.stringify([
            {
              number: 100,
              title: 'Flaky test recurrence',
              url: '',
              labels: [
                { name: 'meta::framework-gap' },
                { name: 'friction::flaky-test' },
              ],
            },
          ]),
          stderr: '',
          code: 0,
        };
      }
      if (label === 'meta::consumer-improvement') {
        return {
          stdout: JSON.stringify([
            {
              number: 200,
              title: 'Another flaky-test report',
              url: '',
              labels: [
                { name: 'meta::consumer-improvement' },
                { name: 'friction::flaky-test' },
              ],
            },
          ]),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '[]', stderr: '', code: 0 };
    };

    const result = await fetchPriorFeedback({
      owner: 'o',
      repo: 'r',
      spawnImpl: makeSpawnStub(responder),
    });

    assert.equal(result.errors.length, 0);
    assert.ok(
      Array.isArray(result.recurringDefectClasses),
      'envelope must carry a recurringDefectClasses array',
    );
    assert.deepEqual(result.recurringDefectClasses, [
      { class: 'flaky-test', count: 2, issues: [100, 200] },
    ]);
  });

  it('surfaces an empty recurringDefectClasses array when no friction labels are present', async () => {
    const result = await fetchPriorFeedback({
      owner: 'o',
      repo: 'r',
      spawnImpl: makeSpawnStub(() => ({ stdout: '[]', stderr: '', code: 0 })),
    });
    assert.deepEqual(result.recurringDefectClasses, []);
  });

  it('still carries recurringDefectClasses (empty) on the missing-owner/repo error path', async () => {
    const result = await fetchPriorFeedback({});
    assert.ok(result.errors.length >= 2);
    assert.deepEqual(
      result.recurringDefectClasses,
      [],
      'error path must not drop the recurringDefectClasses key',
    );
  });
});

describe('end-to-end retro → planner defect-class loop', () => {
  it('a class lifted by the retro side resurfaces through the fetcher side', () => {
    // Retro side: derive a recurring class from routed proposals.
    const routedProposals = composeRoutedProposals({
      epicId: 4131,
      frameworkRepo: 'dsj1984/mandrel',
      consumerRepo: 'acme/app',
      signals: [
        { category: 'merge-conflict', source: 'framework' },
        { category: 'merge-conflict', source: 'framework' },
      ],
    });
    const defectClasses = deriveDefectClasses(routedProposals);
    assert.equal(defectClasses.length, 1);
    const { label } = defectClasses[0];
    assert.equal(label, 'friction::merge-conflict');

    // The composer stamps that same friction label onto the proposed
    // `gh issue create` command — assert the join key actually appears in
    // the command operators paste, so the loop is wired (not just parallel).
    const proposed = [
      ...routedProposals.framework,
      ...routedProposals.consumer,
    ];
    assert.ok(
      proposed.some((p) => p.command.includes(label)),
      'the routed proposal command must carry the friction::<class> label',
    );

    // Planner side: a future Epic files that issue with the friction label;
    // the fetcher reads it back and surfaces the recurring class.
    const filedIssue = {
      number: 500,
      labels: ['meta::framework-gap', label],
    };
    const surfaced = extractRecurringDefectClasses([filedIssue]);
    assert.deepEqual(surfaced, [
      { class: 'merge-conflict', count: 1, issues: [500] },
    ]);
  });
});
