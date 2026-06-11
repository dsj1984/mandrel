// tests/lib/orchestration/ticket-validator-cross-cutting.test.js
//
// Story #2962 — contract tests for the two new cross-cutting rules in
// the decomposer validator:
//
//   1. `cross-cutting-registries` finding when two or more concurrent
//      Stories add new files that would be imported by a registry / barrel
//      file (e.g. `lib/orchestration/lifecycle/listeners/index.js`), or
//      directly edit the registry.
//   2. `fan-out-warning` finding when a Story declares a deletion whose
//      call-site fan-out exceeds the configured threshold (counted via
//      the injectable `fanOutCounter` probe).
//
// 2-tier (Epic #3238): each Story is its own implementation unit and
// carries the `body` (goal / changes / acceptance / verify) that the
// conflict pass scans, plus the top-level `acceptance[]` + `verify[]`
// inline contract the validator requires. Registry / fan-out findings are
// keyed by the Story slug.
//
// Run: node --test tests/lib/orchestration/ticket-validator-cross-cutting.test.js

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runDecomposePhase } from '../../../.agents/scripts/lib/orchestration/epic-plan-decompose/phases/persist.js';
import { validateAndNormalizeTickets } from '../../../.agents/scripts/lib/orchestration/ticket-validator.js';
import {
  _internal,
  computeConflictFindings,
} from '../../../.agents/scripts/lib/orchestration/ticket-validator-conflicts.js';

function makeStory(slug, body = {}, extras = {}) {
  return {
    type: 'story',
    slug,
    title: `Story ${slug}`,
    acceptance: ['observable criterion'],
    verify: ['npm test (unit)'],
    body: {
      goal: `Goal for ${slug}.`,
      changes: ['src/default.js: edit'],
      acceptance: ['observable criterion'],
      verify: ['npm test (unit)'],
      ...body,
    },
    ...extras,
  };
}

/**
 * Benign filler sibling so single-Story fixtures still satisfy the
 * `assertNoSingleStoryFeature` invariant (Story #3777). Touches a unique
 * path so it adds no registry / conflict / fan-out findings of its own.
 */
const SIBLING = makeStory('s-x-filler', {
  changes: ['src/cross-cutting-filler.js: edit'],
});

describe('cross-cutting-registries finding (Story #2962)', () => {
  it('emits crossCuttingRegistries when 2+ Stories create new files under the listeners registry directory', () => {
    const tickets = [
      makeStory('s-a', {
        changes: [
          {
            path: 'lib/orchestration/lifecycle/listeners/foo-listener.js',
            assumption: 'creates',
          },
          // The registry path itself must be in scope; declare it as
          // refactors-existing so the rule recognises the parent dir.
          {
            path: 'lib/orchestration/lifecycle/listeners/index.js',
            assumption: 'refactors-existing',
          },
        ],
      }),
      makeStory('s-b', {
        changes: [
          {
            path: 'lib/orchestration/lifecycle/listeners/bar-listener.js',
            assumption: 'creates',
          },
        ],
      }),
    ];
    const result = validateAndNormalizeTickets(tickets);
    const registry = result.findings.filter(
      (f) => f.kind === 'cross-cutting-registries',
    );
    assert.equal(registry.length, 1, 'one registry finding');
    assert.equal(
      registry[0].registryPath,
      'lib/orchestration/lifecycle/listeners/index.js',
    );
    assert.deepEqual(registry[0].storySlugs, ['s-a', 's-b']);
    assert.equal(registry[0].severity, 'soft');
    assert.deepEqual(result.errors, []);
  });

  it('suppresses the finding when a depends_on chain serialises the Stories', () => {
    const tickets = [
      makeStory('s-a', {
        changes: [
          {
            path: 'lib/orchestration/lifecycle/listeners/foo-listener.js',
            assumption: 'creates',
          },
          {
            path: 'lib/orchestration/lifecycle/listeners/index.js',
            assumption: 'refactors-existing',
          },
        ],
      }),
      makeStory(
        's-b',
        {
          changes: [
            {
              path: 'lib/orchestration/lifecycle/listeners/bar-listener.js',
              assumption: 'creates',
            },
          ],
        },
        { depends_on: ['s-a'] },
      ),
    ];
    const result = validateAndNormalizeTickets(tickets);
    const registry = result.findings.filter(
      (f) => f.kind === 'cross-cutting-registries',
    );
    assert.deepEqual(registry, []);
  });

  it('failOnRegistryConflicts=true upgrades the finding to hard and renders an errors[] line', () => {
    const tickets = [
      makeStory('s-a', {
        changes: [
          {
            path: 'lib/orchestration/lifecycle/listeners/index.js',
            assumption: 'refactors-existing',
          },
        ],
      }),
      makeStory('s-b', {
        changes: [
          {
            path: 'lib/orchestration/lifecycle/listeners/index.js',
            assumption: 'refactors-existing',
          },
        ],
      }),
    ];
    const result = validateAndNormalizeTickets(tickets, {
      conflictPolicy: { failOnRegistryConflicts: true },
    });
    const registry = result.findings.filter(
      (f) => f.kind === 'cross-cutting-registries',
    );
    assert.equal(registry.length, 1);
    assert.equal(registry[0].severity, 'hard');
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Cross-cutting registry conflict/);
    assert.match(
      result.errors[0],
      /lib\/orchestration\/lifecycle\/listeners\/index\.js/,
    );
  });

  it('matchRegistryPattern matches both explicit and **/ suffix patterns', () => {
    const { matchRegistryPattern } = _internal;
    assert.equal(
      matchRegistryPattern(
        'lib/orchestration/lifecycle/listeners/index.js',
        'lib/orchestration/lifecycle/listeners/index.js',
      ),
      true,
    );
    assert.equal(
      matchRegistryPattern('src/app/handlers/index.js', '**/handlers/index.js'),
      true,
    );
    assert.equal(
      matchRegistryPattern('handlers/index.js', '**/handlers/index.js'),
      true,
    );
    assert.equal(
      matchRegistryPattern('src/app/handlers/main.js', '**/handlers/index.js'),
      false,
    );
  });
});

describe('fan-out-warning finding (Story #2962)', () => {
  it('emits fan-out-warning when a deletes-assumption Story exceeds the threshold', () => {
    const tickets = [
      makeStory('s-a', {
        changes: [{ path: 'lib/legacy/old-shim.js', assumption: 'deletes' }],
      }),
      SIBLING,
    ];
    const result = validateAndNormalizeTickets(tickets, {
      conflictPolicy: {
        largeFanOutThreshold: 10,
        fanOutCounter: () => 50,
      },
    });
    const fanOut = result.findings.filter((f) => f.kind === 'fan-out-warning');
    assert.equal(fanOut.length, 1);
    assert.equal(fanOut[0].path, 'lib/legacy/old-shim.js');
    assert.equal(fanOut[0].callSiteCount, 50);
    assert.equal(fanOut[0].threshold, 10);
    assert.equal(fanOut[0].taskSlug, 's-a');
    assert.equal(fanOut[0].severity, 'soft');
  });

  it('does not emit when the call-site count is within the threshold', () => {
    const tickets = [
      makeStory('s-a', {
        changes: [{ path: 'lib/legacy/old-shim.js', assumption: 'deletes' }],
      }),
      SIBLING,
    ];
    const result = validateAndNormalizeTickets(tickets, {
      conflictPolicy: {
        largeFanOutThreshold: 10,
        fanOutCounter: () => 3,
      },
    });
    const fanOut = result.findings.filter((f) => f.kind === 'fan-out-warning');
    assert.deepEqual(fanOut, []);
  });

  it('skips the fan-out probe entirely when no counter is injected', () => {
    const findings = computeConflictFindings({
      stories: [
        makeStory('s-a', {
          changes: [{ path: 'lib/x.js', assumption: 'deletes' }],
        }),
      ],
      policy: { largeFanOutThreshold: 10 },
    });
    assert.deepEqual(
      findings.filter((f) => f.kind === 'fan-out-warning'),
      [],
    );
  });
});

describe('fan-out persist gate (Story #2962)', () => {
  // runDecomposePhase MUST refuse to persist when a fan-out-warning is
  // present and `allowLargeFanOut` is not set. Mirrors the over-budget
  // gate the persist phase already enforces.
  const buildEpic = () => ({
    id: 1,
    title: 'E',
    body: '',
    labels: ['type::epic'],
    linkedIssues: { prd: 10, techSpec: 11 },
  });

  const buildProvider = (epic) => ({
    async getEpic() {
      return epic;
    },
    async getTicket(id) {
      return { id, body: 'b' };
    },
    async updateTicket() {},
    async createTicket() {
      return { id: 999, url: 'u' };
    },
    async getTickets() {
      return [];
    },
    async getTicketComments() {
      return [];
    },
    async createTicketComment() {
      return { id: 1 };
    },
    async updateTicketComment() {
      return { id: 1 };
    },
  });

  const buildFanOutTickets = () => [
    makeStory('s-a', {
      changes: [{ path: 'lib/legacy/widely-used.js', assumption: 'deletes' }],
    }),
    SIBLING,
  ];

  it('throws a deterministic fan-out error when the threshold is exceeded and --allow-large-fan-out is not set', async () => {
    const epic = buildEpic();
    const provider = buildProvider(epic);
    const tickets = buildFanOutTickets();
    await assert.rejects(
      () =>
        runDecomposePhase(
          1,
          provider,
          { tickets },
          { planning: { maxTickets: 60, largeFanOutThreshold: 10 } },
          { fanOutCounter: () => 50 },
        ),
      /large-fan-out|--allow-large-fan-out|50 call site/i,
    );
  });

  it('lets the persist phase proceed past the fan-out gate when allowLargeFanOut is set', async () => {
    const epic = buildEpic();
    const provider = buildProvider(epic);
    const tickets = buildFanOutTickets();
    let err;
    try {
      await runDecomposePhase(
        1,
        provider,
        { tickets },
        { planning: { maxTickets: 60, largeFanOutThreshold: 10 } },
        { fanOutCounter: () => 50, allowLargeFanOut: true },
      );
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'persist will throw downstream (no spec writer wired)');
    assert.ok(
      !/large-fan-out|--allow-large-fan-out/i.test(err.message),
      `allow-large-fan-out run must NOT be rejected for fan-out reasons (got: ${err.message})`,
    );
  });
});

describe('soft conflict surfacing in Phase 8 (Story #3957)', () => {
  // A real shared-editor hazard lands as `'soft'` because
  // `failOnSharedEditors` defaults to `false`. `runDecomposePhase` MUST log
  // each soft cross-Story conflict finding on the Logger.warn channel so the
  // operator sees it during the Phase-8 review, even though it never reaches
  // the AC-visible `errors[]` path.
  const buildEpic = () => ({
    id: 1,
    title: 'E',
    body: '',
    labels: ['type::epic'],
    linkedIssues: { prd: 10, techSpec: 11 },
  });

  const buildProvider = (epic) => ({
    async getEpic() {
      return epic;
    },
    async getTicket(id) {
      return { id, body: 'b' };
    },
    async updateTicket() {},
    async createTicket() {
      return { id: 999, url: 'u' };
    },
    async getTickets() {
      return [];
    },
    async getTicketComments() {
      return [];
    },
    async createTicketComment() {
      return { id: 1 };
    },
    async updateTicketComment() {
      return { id: 1 };
    },
  });

  it('logs object-form shared-editor soft findings on the warn channel', async () => {
    const epic = buildEpic();
    const provider = buildProvider(epic);
    const tickets = [
      makeStory('s-a', {
        changes: [
          {
            path: 'apps/api/src/routes/v1/teams/feed.ts',
            assumption: 'creates',
          },
        ],
      }),
      makeStory('s-b', {
        changes: [
          {
            path: 'apps/api/src/routes/v1/teams/feed.ts',
            assumption: 'refactors-existing',
          },
        ],
      }),
    ];

    const warned = [];
    const originalWarn = console.warn;
    console.warn = (msg) => warned.push(String(msg));
    try {
      // Run will throw downstream (no spec writer wired); the soft-finding
      // surfacing runs before that throw, so we only need to capture warnings.
      await runDecomposePhase(
        1,
        provider,
        { tickets },
        { planning: { maxTickets: 60 } },
        { fanOutCounter: () => 0 },
      ).catch(() => {});
    } finally {
      console.warn = originalWarn;
    }

    const softLines = warned.filter((l) => /soft conflict:/.test(l));
    assert.ok(
      softLines.length >= 1,
      `expected a soft-conflict warn line, got: ${JSON.stringify(warned)}`,
    );
    assert.ok(
      softLines.some(
        (l) =>
          /Shared-editor conflict/.test(l) &&
          /apps\/api\/src\/routes\/v1\/teams\/feed\.ts/.test(l),
      ),
      `expected shared-editor soft line for the feed route, got: ${JSON.stringify(softLines)}`,
    );
  });
});

describe('2-tier inline-contract guard (Epic #3238)', () => {
  it('rejects a Story that lacks an inline acceptance + verify contract', () => {
    assert.throws(
      () =>
        validateAndNormalizeTickets([
          {
            type: 'story',
            slug: 's-no-contract',
                    title: 'Story without inline contract',
            body: { goal: 'Goal.', changes: ['src/x.js: edit'] },
          },
          SIBLING,
        ]),
      /lack an inline acceptance \+ verify contract/,
    );
  });
});
