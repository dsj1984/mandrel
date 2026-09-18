// tests/dynamic-workflow-audit-orchestrator.test.js
//
// Unit tier (Epic #3597, Story #3609): the shared audit-lens orchestration
// engine `runAuditOrchestration`. These tests exercise the three-phase
// fan-out wiring (analyze → adversarial cross-check → synthesis + contract
// self-check) in isolation with stub `agent` / `phase`, so the engine is
// verifiable without a live Claude Code dynamic-workflow runtime. Pure logic,
// all I/O (the sub-agent spawns) mocked, per `.agents/rules/testing-standards.md`.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultContractError,
  ORCHESTRATION_PHASES,
  runAuditOrchestration,
  SYNTHESIS_WRITE_TOOL,
} from '../scripts/lib/dynamic-workflow/audit-orchestrator.js';

const READ_ONLY = Object.freeze(['Read', 'Grep', 'Glob']);

/**
 * Build a recording stub `ctx`. `agent` returns a deterministic output keyed
 * to the prompt and records every call; `phase` records phase names and runs
 * the callback (so the real fan-out executes). `synthesisReport` is what the
 * synthesis agent "writes" — defaults to a conformant report so the contract
 * self-check passes.
 */
function makeCtx({ synthesisReport = 'CONFORMANT', failWhen = null } = {}) {
  const agentCalls = [];
  const phaseNames = [];
  let agentSeq = 0;

  const ctx = {
    inputs: {},
    async agent(opts) {
      agentCalls.push(opts);
      // The synthesis agent is the only one granted the write tool.
      if (opts.allowedTools?.includes(SYNTHESIS_WRITE_TOOL)) {
        return { output: synthesisReport };
      }
      const failure = failWhen?.(opts.prompt);
      if (failure) throw new Error(failure);
      agentSeq += 1;
      return { output: `out-${agentSeq}:${opts.prompt}` };
    },
    async phase(name, fn) {
      phaseNames.push(name);
      return fn();
    },
  };

  return { ctx, agentCalls, phaseNames };
}

/** A spec factory with simple deterministic builders. */
function makeSpec(ctx, overrides = {}) {
  return {
    ctx,
    dimensions: ['Alpha', 'Beta'],
    readOnlyTools: READ_ONLY,
    buildDimensionPrompt: (d) => `DIM:${d}`,
    buildCrossCheckPrompt: (d, findings) => `XCHECK:${d}:${findings}`,
    buildSynthesisPrompt: (blocks) => `SYNTH:${blocks.join('|')}`,
    assertReportContract: () => ({
      conformant: true,
      missingSections: [],
      hasTitle: true,
    }),
    ...overrides,
  };
}

test('runAuditOrchestration: runs the three phases in canonical order', async () => {
  const { ctx, phaseNames } = makeCtx();
  await runAuditOrchestration(makeSpec(ctx));
  assert.deepEqual(phaseNames, [
    ORCHESTRATION_PHASES.ANALYZE,
    ORCHESTRATION_PHASES.CROSS_CHECK,
    ORCHESTRATION_PHASES.SYNTHESIZE,
  ]);
});

test('runAuditOrchestration: fans out one analysis agent per dimension', async () => {
  const { ctx, agentCalls } = makeCtx();
  await runAuditOrchestration(makeSpec(ctx, { dimensions: ['A', 'B', 'C'] }));
  const analysisPrompts = agentCalls
    .map((c) => c.prompt)
    .filter((p) => p.startsWith('DIM:'));
  assert.deepEqual(analysisPrompts, ['DIM:A', 'DIM:B', 'DIM:C']);
});

test('runAuditOrchestration: cross-check sees each dimension’s analysis output', async () => {
  const { ctx, agentCalls } = makeCtx();
  await runAuditOrchestration(makeSpec(ctx, { dimensions: ['Alpha'] }));
  const xcheck = agentCalls.find((c) => c.prompt.startsWith('XCHECK:'));
  // The cross-check prompt embeds the dimension name and the raw analysis
  // output produced by the corresponding analysis agent.
  assert.ok(xcheck.prompt.startsWith('XCHECK:Alpha:'));
  assert.ok(xcheck.prompt.includes('out-1:DIM:Alpha'));
});

test('runAuditOrchestration: synthesis prompt assembles every cross-checked block', async () => {
  const { ctx, agentCalls } = makeCtx();
  await runAuditOrchestration(makeSpec(ctx, { dimensions: ['Alpha', 'Beta'] }));
  const synth = agentCalls.find((c) => c.prompt.startsWith('SYNTH:'));
  // out-2 / out-3 are the two cross-check outputs (out-1 is Alpha analysis,
  // out-2 Beta analysis are interleaved by Promise.all order, but both
  // cross-check outputs must be present and joined by '|').
  assert.ok(synth.prompt.includes('|'));
  const blocks = synth.prompt.slice('SYNTH:'.length).split('|');
  assert.equal(blocks.length, 2);
});

test('runAuditOrchestration: analysis + cross-check agents are read-only', async () => {
  const { ctx, agentCalls } = makeCtx();
  await runAuditOrchestration(makeSpec(ctx));
  const nonSynth = agentCalls.filter((c) => !c.prompt.startsWith('SYNTH:'));
  for (const call of nonSynth) {
    assert.deepEqual(call.allowedTools, [...READ_ONLY]);
    assert.ok(!call.allowedTools.includes(SYNTHESIS_WRITE_TOOL));
  }
});

test('runAuditOrchestration: only the synthesis agent is granted Write', async () => {
  const { ctx, agentCalls } = makeCtx();
  await runAuditOrchestration(makeSpec(ctx));
  const writers = agentCalls.filter((c) =>
    c.allowedTools?.includes(SYNTHESIS_WRITE_TOOL),
  );
  assert.equal(writers.length, 1);
  assert.deepEqual(writers[0].allowedTools, [
    ...READ_ONLY,
    SYNTHESIS_WRITE_TOOL,
  ]);
});

test('runAuditOrchestration: returns { report } by default', async () => {
  const { ctx } = makeCtx({ synthesisReport: 'THE REPORT' });
  const result = await runAuditOrchestration(makeSpec(ctx));
  assert.deepEqual(result, { report: 'THE REPORT' });
});

test('runAuditOrchestration: buildResult shapes the return value from the report', async () => {
  const { ctx } = makeCtx({ synthesisReport: 'BODY' });
  const result = await runAuditOrchestration(
    makeSpec(ctx, {
      buildResult: (report) => ({ artifact: 'x.md', len: report.length }),
    }),
  );
  assert.deepEqual(result, { artifact: 'x.md', len: 4 });
});

test('runAuditOrchestration: throws when the report fails the contract self-check', async () => {
  const { ctx } = makeCtx();
  await assert.rejects(
    runAuditOrchestration(
      makeSpec(ctx, {
        assertReportContract: () => ({
          conformant: false,
          missingSections: ['Technical Debt Backlog'],
          hasTitle: true,
        }),
      }),
    ),
    /Technical Debt Backlog/,
  );
});

test('runAuditOrchestration: a non-conformant report short-circuits the return', async () => {
  const { ctx } = makeCtx();
  let returned = false;
  try {
    await runAuditOrchestration(
      makeSpec(ctx, {
        buildResult: () => {
          returned = true;
          return {};
        },
        assertReportContract: () => ({
          conformant: false,
          missingSections: [],
          hasTitle: false,
        }),
      }),
    );
  } catch {
    // expected
  }
  assert.equal(returned, false, 'buildResult must not run on non-conformance');
});

test('runAuditOrchestration: lens-supplied formatContractError phrases the throw', async () => {
  const { ctx } = makeCtx();
  await assert.rejects(
    runAuditOrchestration(
      makeSpec(ctx, {
        assertReportContract: () => ({
          conformant: false,
          missingSections: ['Foo'],
          hasTitle: true,
        }),
        formatContractError: () => 'LENS-SPECIFIC MESSAGE',
      }),
    ),
    /LENS-SPECIFIC MESSAGE/,
  );
});

// --- partial-failure posture (Story #4783) -----------------------------------
//
// One rejected dimension used to discard every sibling's completed work
// (`Promise.all`). The fan-out is now settled and partitioned: survivors flow
// on, casualties are named in the report.

/** A conformant report skeleton with the Executive Summary the note targets. */
const REPORT_WITH_SUMMARY = [
  '# Audit Report',
  '',
  '## Executive Summary',
  '',
  'Everything analysed looked fine.',
  '',
  '## Detailed Findings',
  '',
  'None.',
].join('\n');

test('runAuditOrchestration: one rejected dimension does not discard its siblings', async () => {
  const { ctx, agentCalls } = makeCtx({
    failWhen: (prompt) =>
      prompt === 'DIM:Beta' ? 'beta analysis blew up' : null,
    synthesisReport: REPORT_WITH_SUMMARY,
  });

  const result = await runAuditOrchestration(
    makeSpec(ctx, { dimensions: ['Alpha', 'Beta', 'Gamma'] }),
  );

  // Synthesis still ran, and it saw the two surviving dimensions.
  const synth = agentCalls.find((c) => c.prompt.startsWith('SYNTH:'));
  assert.ok(synth, 'synthesis must still run when one dimension rejects');
  const blocks = synth.prompt.slice('SYNTH:'.length).split('|');
  assert.equal(blocks.length, 2);
  assert.ok(blocks.some((b) => b.includes('DIM:Alpha')));
  assert.ok(blocks.some((b) => b.includes('DIM:Gamma')));
  assert.ok(!blocks.some((b) => b.includes('DIM:Beta')));
  assert.ok(result.report.includes('Detailed Findings'));
});

test('runAuditOrchestration: the rejected dimension never reaches cross-check', async () => {
  const { ctx, agentCalls } = makeCtx({
    failWhen: (prompt) => (prompt === 'DIM:Beta' ? 'beta failed' : null),
    synthesisReport: REPORT_WITH_SUMMARY,
  });

  await runAuditOrchestration(makeSpec(ctx, { dimensions: ['Alpha', 'Beta'] }));

  const xchecks = agentCalls.filter((c) => c.prompt.startsWith('XCHECK:'));
  assert.equal(xchecks.length, 1);
  assert.ok(xchecks[0].prompt.startsWith('XCHECK:Alpha:'));
});

test('runAuditOrchestration: the Executive Summary names the failed dimension', async () => {
  const { ctx } = makeCtx({
    failWhen: (prompt) =>
      prompt === 'DIM:Beta' ? 'context window exhausted' : null,
    synthesisReport: REPORT_WITH_SUMMARY,
  });

  const { report } = await runAuditOrchestration(
    makeSpec(ctx, { dimensions: ['Alpha', 'Beta', 'Gamma'] }),
  );

  const lines = report.split('\n');
  const summaryIndex = lines.indexOf('## Executive Summary');
  const bodyIndex = lines.indexOf('## Detailed Findings');
  const noteIndex = lines.findIndex((l) => l.includes('Degraded coverage'));

  assert.ok(noteIndex > summaryIndex, 'note sits under the Executive Summary');
  assert.ok(noteIndex < bodyIndex, 'note precedes the findings body');
  assert.match(report, /Degraded coverage/);
  assert.match(report, /1 of 3 analysis dimension did not complete/);
  assert.match(report, /\*\*Beta\*\* \(analyze: context window exhausted\)/);
  // The surviving dimensions must not be implicated.
  assert.doesNotMatch(report, /\*\*Alpha\*\*/);
});

test('runAuditOrchestration: a cross-check rejection is partitioned and named too', async () => {
  const { ctx, agentCalls } = makeCtx({
    failWhen: (prompt) =>
      prompt.startsWith('XCHECK:Beta:') ? 'reviewer timed out' : null,
    synthesisReport: REPORT_WITH_SUMMARY,
  });

  const { report } = await runAuditOrchestration(
    makeSpec(ctx, { dimensions: ['Alpha', 'Beta'] }),
  );

  const synth = agentCalls.find((c) => c.prompt.startsWith('SYNTH:'));
  assert.equal(synth.prompt.slice('SYNTH:'.length).split('|').length, 1);
  assert.match(report, /\*\*Beta\*\* \(cross-check: reviewer timed out\)/);
});

test('runAuditOrchestration: the degraded list is handed to buildSynthesisPrompt', async () => {
  const { ctx } = makeCtx({
    failWhen: (prompt) => (prompt === 'DIM:Beta' ? 'nope' : null),
    synthesisReport: REPORT_WITH_SUMMARY,
  });

  let seen = null;
  await runAuditOrchestration(
    makeSpec(ctx, {
      dimensions: ['Alpha', 'Beta'],
      buildSynthesisPrompt: (blocks, degraded) => {
        seen = degraded;
        return `SYNTH:${blocks.join('|')}`;
      },
    }),
  );

  assert.deepEqual(seen, [
    { dimension: 'Beta', phase: 'analyze', reason: 'nope' },
  ]);
});

test('runAuditOrchestration: a full-coverage run carries no degraded note', async () => {
  const { ctx } = makeCtx({ synthesisReport: REPORT_WITH_SUMMARY });
  const { report } = await runAuditOrchestration(
    makeSpec(ctx, { dimensions: ['Alpha', 'Beta'] }),
  );
  assert.equal(report, REPORT_WITH_SUMMARY);
  assert.doesNotMatch(report, /Degraded coverage/);
});

test('runAuditOrchestration: a total loss throws rather than emitting an empty report', async () => {
  const { ctx, agentCalls } = makeCtx({ failWhen: () => 'all agents down' });
  await assert.rejects(
    runAuditOrchestration(makeSpec(ctx, { dimensions: ['Alpha', 'Beta'] })),
    /every audit dimension failed:.*Alpha.*Beta/s,
  );
  assert.equal(
    agentCalls.filter((c) => c.prompt.startsWith('SYNTH:')).length,
    0,
    'synthesis must not run when nothing survived',
  );
});

test('runAuditOrchestration: a report without an Executive Summary is prefixed with the note', async () => {
  const { ctx } = makeCtx({
    failWhen: (prompt) => (prompt === 'DIM:Beta' ? 'gone' : null),
    synthesisReport: 'NO HEADINGS HERE',
  });
  const { report } = await runAuditOrchestration(
    makeSpec(ctx, { dimensions: ['Alpha', 'Beta'] }),
  );
  assert.ok(report.startsWith('> ⚠️ **Degraded coverage**'));
  assert.ok(report.endsWith('NO HEADINGS HERE'));
});

// --- default helpers ---------------------------------------------------------

test('defaultContractError: names missing title and sections', () => {
  const msg = defaultContractError({
    conformant: false,
    hasTitle: false,
    missingSections: ['A', 'B'],
  });
  assert.match(msg, /missing title;/);
  assert.match(msg, /sections=\[A, B\]/);
});

test('defaultContractError: omits the title clause when the title is present', () => {
  const msg = defaultContractError({
    conformant: false,
    hasTitle: true,
    missingSections: ['Only'],
  });
  assert.doesNotMatch(msg, /title;/);
  assert.match(msg, /sections=\[Only\]/);
});

test('ORCHESTRATION_PHASES + SYNTHESIS_WRITE_TOOL expose the canonical strings', () => {
  assert.equal(ORCHESTRATION_PHASES.ANALYZE, 'analyze-dimensions');
  assert.equal(ORCHESTRATION_PHASES.CROSS_CHECK, 'adversarial-cross-check');
  assert.equal(ORCHESTRATION_PHASES.SYNTHESIZE, 'synthesize-report');
  assert.equal(SYNTHESIS_WRITE_TOOL, 'Write');
});
