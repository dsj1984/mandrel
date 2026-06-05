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
} from '../.agents/scripts/lib/dynamic-workflow/audit-orchestrator.js';

const READ_ONLY = Object.freeze(['Read', 'Grep', 'Glob']);

/**
 * Build a recording stub `ctx`. `agent` returns a deterministic output keyed
 * to the prompt and records every call; `phase` records phase names and runs
 * the callback (so the real fan-out executes). `synthesisReport` is what the
 * synthesis agent "writes" — defaults to a conformant report so the contract
 * self-check passes.
 */
function makeCtx({ synthesisReport = 'CONFORMANT' } = {}) {
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
