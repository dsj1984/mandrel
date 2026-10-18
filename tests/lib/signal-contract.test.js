/**
 * Producer↔consumer contract tests for the canonical NDJSON signal
 * envelope (Epic #4406 / Story #4413).
 *
 * These tests are the binding evidence for the "one envelope written by
 * every emitter, read by every consumer" contract. For each live writer we
 * assert the emitted record:
 *   1. validates against `.agents/schemas/signal-event.schema.json`, and
 *   2. round-trips through its live consumers (the retro routed extraction)
 *      producing correctly-keyed, non-empty output.
 *
 * The schema is compiled once with the same AJV settings the writer's
 * `signal-validator.js` uses, so the contract test and the write-time
 * validator agree by construction.
 */

import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  appendSignal,
  forEachLine,
} from '../../.agents/scripts/lib/observability/signals-writer.js';
import { buildAcceptanceEvalSignal } from '../../.agents/scripts/lib/orchestration/acceptance-eval-decision.js';
import { composeRoutedProposals } from '../../.agents/scripts/lib/orchestration/retro-proposals.js';
import { hasCommonEnvelope } from '../../.agents/scripts/lib/signals/schema.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { createAjv } from '../../.agents/scripts/lib/util/ajv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '.agents',
  'schemas',
  'signal-event.schema.json',
);

const ajv = createAjv({ allErrors: true, strict: false });
const validate = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));

const NOW = '2026-07-11T00:00:00.000Z';

function assertValid(record, label) {
  const ok = validate(record);
  assert.equal(
    ok,
    true,
    `${label} must validate against signal-event.schema.json — errors: ${JSON.stringify(
      validate.errors,
    )}`,
  );
}

// ---------------------------------------------------------------------------
// Canonical records as each live writer emits them (post-cutover shape).
// ---------------------------------------------------------------------------

const diagnoseFriction = {
  kind: 'friction',
  ts: NOW,
  epicId: 4406,
  storyId: 4413,
  taskId: null,
  category: 'Execution Error',
  emitter: { tool: 'diagnose-friction.js', command: 'npm test' },
  details: { errorPreview: 'SyntaxError: unexpected token' },
};

const gateFriction = {
  kind: 'friction',
  ts: NOW,
  epicId: 4406,
  storyId: 4413,
  category: 'maintainability',
  emitter: { tool: 'check-maintainability.js' },
  details: { message: 'MI floor breached' },
};

const autoRefreshFriction = {
  kind: 'friction',
  ts: NOW,
  epicId: 4406,
  storyId: 4413,
  category: 'baseline-refresh-regression',
  emitter: { tool: 'auto-refresh-runner' },
  details: { message: 'Auto-refresh refused' },
  miOverCap: [{ path: 'lib/a.js', method: 'foo' }],
  crapOverCap: [],
};

const reapFriction = {
  kind: 'friction',
  ts: NOW,
  epicId: 4406,
  storyId: 4413,
  category: 'reap-failure',
  emitter: { tool: 'story-close.js' },
  details: { message: 'Worktree reap failed: locked' },
  reason: 'locked',
};

const lifecycleFriction = {
  kind: 'friction',
  ts: NOW,
  epicId: 4406,
  category: 'lifecycle-listener-failure',
  emitter: { tool: 'lifecycle-emit.js' },
  severity: 'high',
  event: 'story.close',
  details: { message: 'listener failed', outcomes: [] },
};

const waveStart = {
  ts: NOW,
  epicId: 4406,
  kind: 'wave-start',
  index: 0,
  stories: [{ id: 4413, title: 'contract' }],
};

const traceBash = {
  ts: NOW,
  kind: 'trace',
  emitter: { tool: 'Bash' },
  epicId: 4406,
  storyId: 4413,
  taskId: null,
  phase: 'implement',
  details: {
    durationMs: 12,
    targetHash: 'sha256:abc',
    normalizedHash: 'sha256:def',
    exitCode: 1,
  },
};

describe('signal contract — every live writer validates against the schema', () => {
  const cases = [
    ['diagnose-friction', diagnoseFriction],
    ['gates/friction', gateFriction],
    ['auto-refresh refusal', autoRefreshFriction],
    ['worktree-reap', reapFriction],
    ['lifecycle-emit friction', lifecycleFriction],
    ['acceptance-eval', null], // filled below
    ['wave tick (epic-level)', waveStart],
    ['trace hook (Bash)', traceBash],
  ];

  for (const [label, record] of cases) {
    if (record === null) continue;
    it(`${label} emits a schema-valid record`, () => {
      assertValid(record, label);
      assert.equal(hasCommonEnvelope(record), true, `${label} envelope`);
    });
  }

  it('acceptance-eval buildAcceptanceEvalSignal (with ts) validates', () => {
    const built = buildAcceptanceEvalSignal({
      storyId: 4413,
      epicId: 4406,
      outcome: {
        decision: 'proceed',
        round: 1,
        cap: 3,
        totalCriteria: 4,
        metCount: 4,
        notMet: [],
      },
    });
    const record = { ...built, ts: NOW };
    assertValid(record, 'acceptance-eval');
  });
});

// Story #4545 — the perf round-trips that used to live here (frictionByCategory
// / reworkScore / retryDensity via computeStoryPerfSummary, and the baseline
// windowing via aggregateBaselineFrictionFromSignals) went with the
// execution-analysis surface. Those consumers had no production caller: the
// only CLI that drove them, analyze-execution.js, hard-failed without an Epic
// id and no workflow invoked it. The retro extraction below is the remaining
// live consumer of the envelope.
describe('signal contract — round-trips through live consumers', () => {
  it('friction records route through the retro extraction (top-level category + string source)', () => {
    // gather-signals reads top-level `category` and the string `source`
    // classifier tag; feed the extracted pairs to the composer.
    const signals = [
      { category: 'flaky-thing', source: 'framework' },
      { category: 'flaky-thing', source: 'framework' },
      { category: 'one-off', source: 'consumer' },
    ];
    const routed = composeRoutedProposals({
      anchorId: 4406,
      anchorKind: 'run',
      frameworkRepo: 'dsj1984/mandrel',
      consumerRepo: 'acme/app',
      signals,
      unresolvedBlockedEvents: [],
    });
    assert.equal(
      routed.framework.length,
      1,
      'recurring framework friction routes',
    );
    assert.equal(
      routed.discarded.length,
      1,
      'single-occurrence friction discarded',
    );
    assert.equal(Object.hasOwn(routed, 'memory'), false, 'memory pane is gone');
  });
});

describe('signal contract — appendSignal classifier + provenance (item 3)', () => {
  let workRoot;
  let cfg;
  beforeEach(() => {
    workRoot = makeTempDir('sig-classify-');
    cfg = { project: { paths: { tempRoot: workRoot } } };
  });
  afterEach(() => rmSync(workRoot, { recursive: true, force: true }));

  it('appended friction carries string source (classifier ran) and emitter provenance', async () => {
    const ok = await appendSignal({
      epicId: 4406,
      storyId: 4413,
      signal: {
        kind: 'friction',
        ts: NOW,
        epicId: 4406,
        storyId: 4413,
        category: 'Execution Error',
        emitter: {
          tool: 'diagnose-friction.js',
          command: 'node .agents/scripts/x.js',
        },
        details: { errorPreview: 'boom' },
      },
      config: cfg,
    });
    assert.equal(ok, true);
    const records = [];
    await forEachLine(4406, 4413, (r) => records.push(r), cfg);
    assert.equal(records.length, 1);
    const [rec] = records;
    assert.ok(
      rec.source === 'framework' || rec.source === 'consumer',
      `source must be a string classifier tag, got ${JSON.stringify(rec.source)}`,
    );
    // The command names `.agents/scripts`, so it classifies as framework.
    assert.equal(rec.source, 'framework');
    assert.equal(rec.emitter.tool, 'diagnose-friction.js');
  });
});

describe('signal contract — write-time validation drops invalid records (item 6)', () => {
  let workRoot;
  let cfg;
  beforeEach(() => {
    workRoot = makeTempDir('sig-reject-');
    cfg = { project: { paths: { tempRoot: workRoot } } };
  });
  afterEach(() => rmSync(workRoot, { recursive: true, force: true }));

  it('drops a schema-invalid record and never throws', async () => {
    let ok;
    await assert.doesNotReject(async () => {
      ok = await appendSignal({
        epicId: 4406,
        storyId: 4413,
        signal: {
          kind: 'friction',
          epicId: 4406,
          storyId: 4413,
          category: 'x',
          details: 'a bare string is not allowed',
        },
        config: cfg,
      });
    });
    assert.equal(
      ok,
      false,
      'invalid record must be dropped (appendSignal returns false)',
    );
    // Nothing was written to the signals file.
    const records = [];
    await forEachLine(4406, 4413, (r) => records.push(r), cfg);
    assert.equal(records.length, 0, 'the invalid record must not be appended');
  });

  // Story #5003 — the persisted per-Epic reject tally was keyed on a positive
  // `epicId`, and v2 Stories are standalone, so no row was ever written and
  // its only reader could never see one. Both halves are gone; pin their
  // absence so the write-only limb cannot be reintroduced.
  it('exposes no persisted reject-tally surface', async () => {
    const validator = await import(
      '../../.agents/scripts/lib/observability/signal-validator.js'
    );
    assert.equal(validator.recordSignalReject, undefined);
    assert.equal(validator.readSignalRejectCount, undefined);
  });
});

describe('signal contract — wave-level canonical envelope (item 5)', () => {
  it('the epic-level wave record uses one epic-id key (`epicId`, never `epic`) and validates', () => {
    assertValid(waveStart, 'wave-start');
    assert.equal(
      Object.hasOwn(waveStart, 'epic'),
      false,
      'no legacy `epic` alias',
    );
    assert.equal(waveStart.epicId, 4406);
    // The reader's envelope guard requires the canonical `epicId`; a
    // record carrying only the legacy `epic` alias is rejected.
    assert.equal(
      hasCommonEnvelope({ kind: 'wave-start', ts: NOW, epic: 4406 }),
      false,
      'the legacy `epic` alias no longer satisfies the envelope guard',
    );
    assert.equal(hasCommonEnvelope(waveStart), true);
  });
});
