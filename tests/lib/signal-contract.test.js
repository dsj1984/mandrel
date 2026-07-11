/**
 * Producer↔consumer contract tests for the canonical NDJSON signal
 * envelope (Epic #4406 / Story #4413).
 *
 * These tests are the binding evidence for the "one envelope written by
 * every emitter, read by every consumer" contract. For each live writer we
 * assert the emitted record:
 *   1. validates against `.agents/schemas/signal-event.schema.json`, and
 *   2. round-trips through its live consumers (perf-aggregator
 *      frictionByCategory / reworkScore / retryDensity, the retro routed
 *      extraction, and the baseline-friction windowing) producing
 *      correctly-keyed, non-empty output.
 *
 * The schema is compiled once with the same AJV settings the writer's
 * `signal-validator.js` uses, so the contract test and the write-time
 * validator agree by construction.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  computeEpicPerfReport,
  computeStoryPerfSummary,
  computeWaveParallelismRows,
} from '../../.agents/scripts/lib/observability/perf-aggregator.js';
import { aggregateBaselineFrictionFromSignals } from '../../.agents/scripts/lib/observability/perf-report-readers.js';
import { storyTempDir } from '../../.agents/scripts/lib/config/temp-paths.js';
import { readSignalRejectCount } from '../../.agents/scripts/lib/observability/signal-validator.js';
import {
  appendSignal,
  forEachLine,
} from '../../.agents/scripts/lib/observability/signals-writer.js';
import {
  extractExitCode,
  handlePost,
} from '../../.agents/scripts/lib/observability/tool-trace-hook.js';
import { buildAcceptanceEvalSignal } from '../../.agents/scripts/lib/orchestration/acceptance-eval-decision.js';
import { composeRoutedProposals } from '../../.agents/scripts/lib/orchestration/retro-proposals.js';
import { detectRetry } from '../../.agents/scripts/lib/signals/detectors/retry.js';
import { detectRework } from '../../.agents/scripts/lib/signals/detectors/rework.js';
import { hasCommonEnvelope } from '../../.agents/scripts/lib/signals/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '.agents',
  'schemas',
  'signal-event.schema.json',
);

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
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

describe('signal contract — round-trips through live consumers', () => {
  it('categorized friction buckets under its real category (no Unknown) in computeStoryPerfSummary', () => {
    const summary = computeStoryPerfSummary([diagnoseFriction, gateFriction], {
      storyId: 4413,
      epicId: 4406,
    });
    assert.deepEqual(summary.frictionByCategory, {
      'Execution Error': 1,
      maintainability: 1,
    });
    assert.equal(
      Object.hasOwn(summary.frictionByCategory, 'Unknown'),
      false,
      'a record carrying a category must NOT bucket under Unknown',
    );
  });

  it('rework detector output round-trips through reworkScore (non-empty)', async () => {
    const rework = {
      ts: NOW,
      kind: 'rework',
      emitter: { tool: 'rework-detector' },
      epicId: 4406,
      storyId: 4413,
      taskId: null,
      details: { targetHash: 'sha256:file', editCount: 5, threshold: 3 },
    };
    assertValid(rework, 'rework');
    const summary = computeStoryPerfSummary([rework], {
      storyId: 4413,
      epicId: 4406,
    });
    assert.equal(summary.reworkScore.filesEditedBeyondThreshold, 1);
    assert.equal(summary.reworkScore.topPath, 'sha256:file');
    assert.equal(summary.reworkScore.topPathEdits, 5);
  });

  it('retry detector output round-trips through retryDensity (non-empty hash cardinality)', () => {
    const retry = {
      ts: NOW,
      kind: 'retry',
      emitter: { tool: 'retry-detector' },
      epicId: 4406,
      storyId: 4413,
      taskId: null,
      details: {
        commandHash: 'sha256:cmd',
        failureCount: 3,
        threshold: 2,
        normalizationRules: [],
      },
    };
    assertValid(retry, 'retry');
    const summary = computeStoryPerfSummary([retry], {
      storyId: 4413,
      epicId: 4406,
    });
    assert.equal(summary.retryDensity.retries, 1);
    assert.equal(summary.retryDensity.uniqueCommands, 1);
  });

  it('friction records route through the retro extraction (top-level category + string source)', () => {
    // gather-signals reads top-level `category` and the string `source`
    // classifier tag; feed the extracted pairs to the composer.
    const signals = [
      { category: 'flaky-thing', source: 'framework' },
      { category: 'flaky-thing', source: 'framework' },
      { category: 'one-off', source: 'consumer' },
    ];
    const routed = composeRoutedProposals({
      epicId: 4406,
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

  it('baseline friction windowing reads canonical `ts`', async () => {
    const workRoot = mkdtempSync(path.join(tmpdir(), 'sig-window-'));
    const cfg = { project: { paths: { tempRoot: workRoot } } };
    try {
      await appendSignal({
        epicId: 4406,
        storyId: 4413,
        signal: {
          kind: 'friction',
          ts: NOW,
          epicId: 4406,
          storyId: 4413,
          category: 'baseline-refresh-regression',
          emitter: { tool: 'auto-refresh-runner' },
          details: { message: 'refused' },
          regressedFiles: [{ file: 'lib/x.js' }],
        },
        config: cfg,
      });
      const out = await aggregateBaselineFrictionFromSignals({
        epicId: 4406,
        storyIds: [4413],
        config: cfg,
        windowDays: 30,
        now: () => new Date('2026-07-11T01:00:00.000Z'),
      });
      assert.ok(
        out.totalRecords >= 1,
        'windowing includes the ts-stamped record',
      );
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
  });
});

describe('signal contract — appendSignal classifier + provenance (item 3)', () => {
  let workRoot;
  let cfg;
  beforeEach(() => {
    workRoot = mkdtempSync(path.join(tmpdir(), 'sig-classify-'));
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

describe('signal contract — write-time validation + reject tally (item 6)', () => {
  let workRoot;
  let cfg;
  beforeEach(() => {
    workRoot = mkdtempSync(path.join(tmpdir(), 'sig-reject-'));
    cfg = { project: { paths: { tempRoot: workRoot } } };
  });
  afterEach(() => rmSync(workRoot, { recursive: true, force: true }));

  it('drops a schema-invalid record, never throws, and persists a reject tally readable cross-process', async () => {
    // Missing `ts` and `details` is a bare string → invalid.
    const before = await readSignalRejectCount({ epicId: 4406, config: cfg });
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
    // The reject tally incremented and is readable from a fresh read.
    const after = await readSignalRejectCount({ epicId: 4406, config: cfg });
    assert.equal(
      after,
      before + 1,
      'reject tally increments under the Epic temp tree',
    );
    // Cross-process readable: the tally lives as a JSON file on disk.
    const tallyPath = path.join(workRoot, 'epic-4406', 'signal-rejects.json');
    const raw = JSON.parse(await fs.readFile(tallyPath, 'utf8'));
    assert.equal(raw.count, after);
    assert.equal(typeof raw.lastField, 'string');
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

describe('signal contract — waveParallelism is truthful (item 8)', () => {
  it('renders real, non-empty rows from a canonical wave-start(index)+state-transition+wave-complete stream', () => {
    const events = [
      waveStart,
      {
        ts: '2026-07-11T00:00:01.000Z',
        kind: 'state-transition',
        epicId: 4406,
        storyId: 4413,
        details: { to: 'agent::executing' },
      },
      {
        ts: '2026-07-11T00:00:05.000Z',
        kind: 'state-transition',
        epicId: 4406,
        storyId: 4413,
        details: { to: 'agent::done' },
      },
      {
        ts: '2026-07-11T00:00:06.000Z',
        epicId: 4406,
        kind: 'wave-complete',
        index: 0,
      },
    ];
    const rows = computeWaveParallelismRows(events, { concurrencyCap: 2 });
    assert.equal(
      rows.length,
      1,
      'the bucketer produces a real row (not structurally empty)',
    );
    const [row] = rows;
    assert.equal(row.waveIndex, 0);
    assert.equal(row.storyCount, 1);
    assert.ok(row.wallClockMs > 0, 'wall-clock is real');
    assert.ok(row.summedStoryMs > 0, 'per-Story window time is real');

    // And the full report surfaces the rows (no structurally-empty table).
    const report = computeEpicPerfReport([], { epicId: 4406, events });
    assert.equal(report.waveParallelism.length, 1);
    assert.ok(report.waveParallelism[0].wallClockMs > 0);
  });
});

describe('signal contract — trace hook records exitCode (item 4)', () => {
  it('extractExitCode reads the Bash tool_response exit code', () => {
    assert.equal(extractExitCode({ tool_response: { exitCode: 1 } }), 1);
    assert.equal(extractExitCode({ tool_response: { exit_code: 2 } }), 2);
    assert.equal(extractExitCode({ tool_response: { code: 0 } }), 0);
    assert.equal(extractExitCode({ tool_response: {} }), null);
  });

  it('handlePost records details.exitCode for a Bash PostToolUse event and omits it for a non-Bash tool', async () => {
    const workRoot = mkdtempSync(path.join(tmpdir(), 'sig-trace-'));
    // handlePost writes through the default writer, whose temp root is
    // anchored at the main checkout root (git rev-parse). A freshly-minted
    // temp dir is not a git repo, so chdir'ing into it makes the writer
    // resolve `temp/` relative to workRoot — hermetic and collision-free.
    const origCwd = process.cwd();
    const readLastTrace = async (storyId) => {
      const dir = storyTempDir(4406, storyId);
      const raw = await fs.readFile(path.join(dir, 'traces.ndjson'), 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean);
      return JSON.parse(lines[lines.length - 1]);
    };
    try {
      process.chdir(workRoot);

      // Bash PostToolUse: details.exitCode is recorded verbatim — the write
      // that makes detectRetry's `exitCode !== 0` failure predicate fireable.
      await handlePost(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_use_id: 't1',
          tool_input: { command: 'false' },
          tool_response: { exitCode: 1 },
        },
        { epicId: 4406, storyId: 4413 },
      );
      const bashTrace = await readLastTrace(4413);
      assert.equal(bashTrace.kind, 'trace');
      assert.equal(bashTrace.emitter.tool, 'Bash');
      assert.equal(bashTrace.details.exitCode, 1);

      // Non-Bash PostToolUse (Read): the field is omitted entirely so a
      // non-Bash exit summary can never leak into retry detection.
      await handlePost(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_use_id: 't2',
          tool_input: { file_path: '/etc/hosts' },
          tool_response: { exitCode: 0 },
        },
        { epicId: 4406, storyId: 4414 },
      );
      const readTrace = await readLastTrace(4414);
      assert.equal(readTrace.emitter.tool, 'Read');
      assert.equal(
        Object.hasOwn(readTrace.details, 'exitCode'),
        false,
        'non-Bash trace must omit details.exitCode',
      );
    } finally {
      process.chdir(origCwd);
      rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it('detectRetry fires when the failed-repeat count strictly exceeds the threshold', async () => {
    const workRoot = mkdtempSync(path.join(tmpdir(), 'sig-retry-'));
    const tracesPath = path.join(workRoot, 'traces.ndjson');
    try {
      // Three failed (exitCode 1) Bash invocations of the same command
      // identity; threshold 2 → 3 > 2 → one retry signal.
      const line = (extra) =>
        `${JSON.stringify({
          ts: NOW,
          kind: 'trace',
          emitter: { tool: 'Bash' },
          epicId: 4406,
          storyId: 4413,
          details: { targetHash: 'sha256:cmd', exitCode: 1, ...extra },
        })}\n`;
      await fs.writeFile(tracesPath, line() + line() + line(), 'utf8');
      const signals = await detectRetry({
        tracesPath,
        epicId: 4406,
        storyId: 4413,
        threshold: 2,
        nowFn: () => NOW,
      });
      assert.equal(
        signals.length,
        1,
        'one retry signal for the offending identity',
      );
      assert.equal(signals[0].kind, 'retry');
      assert.equal(signals[0].details.failureCount, 3);
      assertValid(signals[0], 'retry signal');
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
  });
});
