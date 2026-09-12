import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AGENT_BOOT_CEILING_BYTES,
  agentBootDrift,
  agentBootOverflow,
  budgetFailureCount,
  buildBaseline,
  diffBudget,
  GATED_TIERS,
  loadBaseline,
  parseArgv,
  renderDiff,
  renderReachable,
  runCli,
} from '../.agents/scripts/check-context-budget.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';

/**
 * Unit coverage for the context-budget ratchet (Story #4438).
 *
 * Exercises the pure helpers, then drives `runCli` end-to-end against tmpdir
 * fixtures: a seeded budget passes; an artificial byte increase beyond
 * tolerance to an always-loaded file fails naming the tier; a missing budget
 * and an empty resolved tier are clean no-ops.
 */

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeSink() {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join('') };
}

/**
 * Materialize a fixture repo with a CLAUDE.md closure + a context doc under a
 * fresh tmpdir. Returns `{ root, config }`.
 */
function makeRepo({
  withClaude = true,
  docsContextFiles = ['architecture.md'],
  withWorkflows = false,
} = {}) {
  const root = makeTempDir('ctx-budget-');
  const write = (rel, body) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  if (withClaude) {
    write('CLAUDE.md', '@AGENTS.md\n');
    write('AGENTS.md', 'onboarding context\n');
  }
  if (withWorkflows) {
    write(
      '.agents/workflows/mandrel-deliver.md',
      '---\ndescription: fixture\nmandatoryReads: [helpers/digest.md]\n---\n\n# /mandrel-deliver\n\n[digest](helpers/digest.md) [appendix](helpers/appendix.md)\n',
    );
    write('.agents/workflows/helpers/digest.md', '# Digest\n');
    write('.agents/workflows/helpers/appendix.md', '# Appendix\n');
  }
  write('docs/architecture.md', 'architecture doc body\n');
  const config = {
    project: { paths: { docsRoot: 'docs' }, docsContextFiles },
  };
  return { root, config, write };
}

// ---------------------------------------------------------------------------
// parseArgv
// ---------------------------------------------------------------------------

test('parseArgv reads baseline, root, update, json', () => {
  assert.deepEqual(
    parseArgv(['--baseline', 'b.json', '--root', 'r', '--update', '--json']),
    { baselinePath: 'b.json', rootPath: 'r', update: true, json: true },
  );
  assert.deepEqual(parseArgv([]), {
    baselinePath: null,
    rootPath: null,
    update: false,
    json: false,
  });
});

// ---------------------------------------------------------------------------
// diffBudget / buildBaseline / renderDiff pure helpers
// ---------------------------------------------------------------------------

test('diffBudget flags growth beyond tolerance and names the tier', () => {
  const tierMap = {
    tiers: {
      alwaysLoaded: [{ path: 'CLAUDE.md', bytes: 5000 }],
      mandatoryRead: [],
    },
  };
  const baseline = {
    toleranceBytes: 100,
    tiers: {
      alwaysLoaded: { totalBytes: 4000 },
      mandatoryRead: { totalBytes: 0 },
    },
  };
  const diff = diffBudget(tierMap, baseline);
  assert.equal(diff.grown.length, 1);
  assert.equal(diff.grown[0].tier, 'alwaysLoaded');
  assert.equal(diff.grown[0].delta, 1000);
  // mandatoryRead resolved empty → skipped, not failed.
  assert.ok(diff.skipped.includes('mandatoryRead'));
});

test('diffBudget treats within-tolerance growth as clean and reports shrink without failing (Story #5313)', () => {
  const baseline = {
    toleranceBytes: 500,
    tiers: { alwaysLoaded: { totalBytes: 4000 } },
  };
  const within = diffBudget(
    { tiers: { alwaysLoaded: [{ path: 'x', bytes: 4200 }] } },
    baseline,
  );
  assert.deepEqual(within.grown, []);
  assert.deepEqual(within.shrunk, []);

  const shrunk = diffBudget(
    { tiers: { alwaysLoaded: [{ path: 'x', bytes: 3000 }] } },
    baseline,
  );
  assert.equal(shrunk.grown.length, 0);
  assert.equal(shrunk.shrunk.length, 1);
  assert.equal(shrunk.shrunk[0].tier, 'alwaysLoaded');
  assert.equal(shrunk.shrunk[0].delta, 1000);
  // AC-8: a tier below its recorded total passes — the close writes the
  // lower total back instead of the gate going red (reverses Story #4872).
  assert.equal(budgetFailureCount(shrunk), 0);
});

test('diffBudget applies tolerance upward only — a sub-tolerance shrink is still reported', () => {
  // Mirroring the tolerance downward would hide a gain from the write-back
  // that locks it in; the report stays zero-tolerance, the gate stays green.
  const diff = diffBudget(
    { tiers: { alwaysLoaded: [{ path: 'x', bytes: 3999 }] } },
    { toleranceBytes: 500, tiers: { alwaysLoaded: { totalBytes: 4000 } } },
  );
  assert.equal(diff.shrunk.length, 1);
  assert.equal(diff.shrunk[0].delta, 1);
  assert.equal(budgetFailureCount(diff), 0);
});

test('AC-8: growth past tolerance still fails while a shrunk sibling tier does not', () => {
  const diff = diffBudget(
    {
      tiers: {
        alwaysLoaded: [{ path: 'x', bytes: 5000 }],
        workflow: [{ path: 'w', bytes: 100 }],
      },
    },
    {
      toleranceBytes: 500,
      tiers: {
        alwaysLoaded: { totalBytes: 4000 },
        workflow: { totalBytes: 900 },
      },
    },
  );
  assert.equal(diff.grown.length, 1);
  assert.equal(diff.shrunk.length, 1);
  assert.equal(budgetFailureCount(diff), 1);
});

test('diffBudget reports a recorded row naming a path the tier no longer contains', () => {
  const diff = diffBudget(
    { tiers: { workflow: [{ path: 'a.md', bytes: 100 }] } },
    {
      toleranceBytes: 0,
      tiers: {
        workflow: {
          totalBytes: 100,
          files: [
            { path: 'a.md', bytes: 100 },
            { path: 'deleted.md', bytes: 0 },
          ],
        },
      },
    },
  );
  // The total still agrees — only the row-level check can see this one.
  assert.deepEqual(diff.grown, []);
  assert.deepEqual(diff.shrunk, []);
  assert.equal(diff.absent.length, 1);
  assert.equal(diff.absent[0].path, 'deleted.md');
  assert.equal(diff.absent[0].tier, 'workflow');
  assert.equal(budgetFailureCount(diff), 1);
});

test('diffBudget reports no absent rows when every recorded path is still measured', () => {
  const diff = diffBudget(
    { tiers: { workflow: [{ path: 'a.md', bytes: 100 }] } },
    {
      toleranceBytes: 0,
      tiers: {
        workflow: { totalBytes: 100, files: [{ path: 'a.md', bytes: 100 }] },
      },
    },
  );
  assert.deepEqual(diff.absent, []);
  assert.equal(budgetFailureCount(diff), 0);
});

test('buildBaseline records only the gated tiers with totals', () => {
  const envelope = buildBaseline(
    {
      tiers: {
        alwaysLoaded: [{ path: 'CLAUDE.md', bytes: 10 }],
        mandatoryRead: [{ path: 'docs/a.md', bytes: 20 }],
        digestVisible: [{ path: 'docs/s.md', bytes: 999 }],
        onDemand: [{ path: '.agents/rules/x.md', bytes: 999 }],
      },
    },
    2048,
  );
  assert.deepEqual(Object.keys(envelope.tiers).sort(), [...GATED_TIERS].sort());
  assert.equal(envelope.tiers.alwaysLoaded.totalBytes, 10);
  assert.equal(envelope.tiers.mandatoryRead.totalBytes, 20);
  assert.equal(envelope.toleranceBytes, 2048);
});

test('renderDiff tags a gate fail and a clean pass', () => {
  assert.match(
    renderDiff({
      grown: [
        {
          tier: 'alwaysLoaded',
          current: 1,
          baseline: 0,
          tolerance: 0,
          delta: 1,
        },
      ],
      shrunk: [],
      absent: [],
      skipped: [],
    }),
    /\(gate fail\)/,
  );
  assert.match(
    renderDiff({ grown: [], shrunk: [], absent: [], skipped: [] }),
    /\(ok\)/,
  );
});

test('renderDiff reports shrinkage as ok and an absent row as a gate failure', () => {
  const shrink = renderDiff({
    grown: [],
    shrunk: [{ tier: 'workflow', current: 900, baseline: 1000, delta: 100 }],
    absent: [],
    skipped: [],
  });
  assert.match(shrink, /\(ok\)/);
  assert.match(shrink, /- workflow: 900 bytes is under the recorded 1000/);
  assert.match(shrink, /writes the lower total back/);

  const missing = renderDiff({
    grown: [],
    shrunk: [],
    absent: [{ tier: 'workflow', path: 'gone.md', bytes: 12 }],
    skipped: [],
  });
  assert.match(missing, /\(gate fail\)/);
  assert.match(missing, /recorded row gone\.md names a path/);
  assert.match(missing, /absent=1/);
});

// ---------------------------------------------------------------------------
// agentBootOverflow / buildBaseline agentBoot section
// ---------------------------------------------------------------------------

test('agentBootOverflow flags only role defs above the per-file ceiling', () => {
  const tierMap = {
    tiers: {
      agentBoot: [
        { path: '.agents/agents/story-worker.md', bytes: 7000 },
        { path: '.agents/agents/huge.md', bytes: 9000 },
      ],
    },
  };
  const over = agentBootOverflow(tierMap, 8192);
  assert.equal(over.length, 1);
  assert.equal(over[0].path, '.agents/agents/huge.md');
  assert.equal(over[0].ceiling, 8192);
});

test('agentBootOverflow is empty when there are no agent defs', () => {
  assert.deepEqual(agentBootOverflow({ tiers: {} }), []);
  assert.equal(AGENT_BOOT_CEILING_BYTES, 8192);
});

test('buildBaseline records the agentBoot ceiling + files top-level (not under tiers)', () => {
  const envelope = buildBaseline(
    {
      tiers: {
        alwaysLoaded: [{ path: 'CLAUDE.md', bytes: 10 }],
        mandatoryRead: [],
        agentBoot: [{ path: '.agents/agents/retro.md', bytes: 1800 }],
      },
    },
    2048,
  );
  // agentBoot MUST NOT leak into the ratcheted `tiers` set.
  assert.deepEqual(Object.keys(envelope.tiers).sort(), [...GATED_TIERS].sort());
  assert.equal(envelope.agentBoot.ceilingBytes, 8192);
  // The recorded row carries the headroom an author sizing an edit needs, so
  // reading the row does not require re-deriving it against the ceiling.
  assert.deepEqual(envelope.agentBoot.files, [
    {
      path: '.agents/agents/retro.md',
      bytes: 1800,
      headroomBytes: AGENT_BOOT_CEILING_BYTES - 1800,
    },
  ]);
});

// ---------------------------------------------------------------------------
// agentBootDrift — a recorded row that disagrees with the tree (Story #4830)
// ---------------------------------------------------------------------------

/** Build a `{ tierMap, baseline }` pair from `[path, recorded, actual]` rows. */
function driftFixture(rows) {
  return {
    tierMap: {
      tiers: {
        agentBoot: rows.map(([p, , actual]) => ({ path: p, bytes: actual })),
      },
    },
    baseline: {
      agentBoot: {
        ceilingBytes: AGENT_BOOT_CEILING_BYTES,
        files: rows
          .filter(([, recorded]) => recorded !== null)
          .map(([p, recorded]) => ({
            path: p,
            bytes: recorded,
            headroomBytes: AGENT_BOOT_CEILING_BYTES - recorded,
          })),
      },
    },
  };
}

test('agentBootDrift is empty when every recorded row matches the tree', () => {
  const { tierMap, baseline } = driftFixture([
    ['.agents/agents/a.md', 4000, 4000],
    ['.agents/agents/b.md', 1234, 1234],
  ]);
  assert.deepEqual(agentBootDrift(tierMap, baseline), []);
});

test('agentBootDrift calls a row that understates its file permissive and reports the real headroom', () => {
  const { tierMap, baseline } = driftFixture([
    ['.agents/agents/story-worker.md', 7317, 8143],
  ]);
  const drift = agentBootDrift(tierMap, baseline);
  assert.equal(drift.length, 1);
  assert.deepEqual(drift[0], {
    path: '.agents/agents/story-worker.md',
    recorded: 7317,
    actual: 8143,
    delta: 826,
    direction: 'permissive',
    recordedHeadroom: AGENT_BOOT_CEILING_BYTES - 7317,
    headroomBytes: AGENT_BOOT_CEILING_BYTES - 8143,
  });
});

test('agentBootDrift calls a row that overstates its file restrictive — self-correcting, never a gate fail', () => {
  const { tierMap, baseline } = driftFixture([
    ['.agents/agents/a.md', 5000, 4000],
  ]);
  const drift = agentBootDrift(tierMap, baseline);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].direction, 'restrictive');
  assert.equal(drift[0].delta, -1000);
});

test('agentBootDrift treats an unrecorded boot context as permissive — no row promises unbounded headroom', () => {
  const { tierMap, baseline } = driftFixture([
    ['.agents/agents/new.md', null, 3000],
  ]);
  const drift = agentBootDrift(tierMap, baseline);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].direction, 'permissive');
  assert.equal(drift[0].recorded, null);
  assert.equal(drift[0].recordedHeadroom, null);
});

test('agentBootDrift catches a stale recorded headroom even when the byte count agrees', () => {
  const drift = agentBootDrift(
    { tiers: { agentBoot: [{ path: '.agents/agents/a.md', bytes: 4000 }] } },
    {
      agentBoot: {
        ceilingBytes: AGENT_BOOT_CEILING_BYTES,
        files: [
          { path: '.agents/agents/a.md', bytes: 4000, headroomBytes: 9999 },
        ],
      },
    },
  );
  assert.equal(drift.length, 1);
  assert.equal(drift[0].direction, 'permissive');
  assert.equal(drift[0].headroomBytes, AGENT_BOOT_CEILING_BYTES - 4000);
});

test('the committed baseline carries no agentBoot drift against this repo tree', () => {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const baseline = loadBaseline(
    path.join(repoRoot, 'baselines', 'context-budget.json'),
  );
  const tierMap = {
    tiers: {
      agentBoot: (baseline.agentBoot?.files ?? []).map((f) => ({
        path: f.path,
        bytes: fs.statSync(path.join(repoRoot, f.path)).size,
      })),
    },
  };
  assert.deepEqual(agentBootDrift(tierMap, baseline), []);
});

// ---------------------------------------------------------------------------
// runCli end-to-end
// ---------------------------------------------------------------------------

test('runCli --update then a clean run exits 0', async () => {
  const { root, config } = makeRepo();
  const stdout = makeSink();
  const updateCode = await runCli({
    argv: ['--update'],
    cwd: root,
    config,
    stdout,
    stderr: makeSink(),
  });
  assert.equal(updateCode, 0);
  assert.ok(fs.existsSync(path.join(root, 'baselines', 'context-budget.json')));

  const check = await runCli({
    argv: [],
    cwd: root,
    config,
    stdout: makeSink(),
    stderr: makeSink(),
  });
  assert.equal(check, 0);
});

test('runCli exits 1 naming the tier that grew beyond tolerance (always-loaded file bloat)', async () => {
  const { root, config } = makeRepo();
  await runCli({
    argv: ['--update'],
    cwd: root,
    config,
    stdout: makeSink(),
    stderr: makeSink(),
  });

  // Artificially bloat an always-loaded file by more than the tolerance.
  const baseline = loadBaseline(
    path.join(root, 'baselines', 'context-budget.json'),
  );
  const bloat = 'x'.repeat(baseline.toleranceBytes + 1000);
  fs.appendFileSync(path.join(root, 'AGENTS.md'), bloat);

  const stdout = makeSink();
  const stderr = makeSink();
  const code = await runCli({ argv: [], cwd: root, config, stdout, stderr });
  assert.equal(code, 1);
  assert.match(stdout.text(), /\+ alwaysLoaded:/);
  assert.match(stderr.text(), /grew beyond tolerance/);
});

test('runCli exits 1 when a role-agent boot context exceeds the per-file ceiling', async () => {
  const { root, config } = makeRepo();
  // A role def larger than the 8192-byte per-agent ceiling.
  fs.mkdirSync(path.join(root, '.agents', 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.agents', 'agents', 'huge.md'),
    'x'.repeat(AGENT_BOOT_CEILING_BYTES + 500),
  );
  // Seed a baseline (records the ceiling); update itself never fails.
  await runCli({
    argv: ['--update'],
    cwd: root,
    config,
    stdout: makeSink(),
    stderr: makeSink(),
  });

  const stdout = makeSink();
  const stderr = makeSink();
  const code = await runCli({ argv: [], cwd: root, config, stdout, stderr });
  assert.equal(code, 1);
  assert.match(stdout.text(), /agentBoot: \.agents\/agents\/huge\.md/);
  assert.match(stderr.text(), /per-agent ceiling/);
});

test('runCli passes when role-agent boot contexts are within the ceiling', async () => {
  const { root, config } = makeRepo();
  fs.mkdirSync(path.join(root, '.agents', 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.agents', 'agents', 'ok.md'),
    'x'.repeat(4000),
  );
  await runCli({
    argv: ['--update'],
    cwd: root,
    config,
    stdout: makeSink(),
    stderr: makeSink(),
  });
  const code = await runCli({
    argv: [],
    cwd: root,
    config,
    stdout: makeSink(),
    stderr: makeSink(),
  });
  assert.equal(code, 0);
});

test('runCli exits 1 when a recorded row understates its boot context, even though the file is under the ceiling', async () => {
  const { root, config } = makeRepo();
  const bootFile = path.join(root, '.agents', 'agents', 'ok.md');
  fs.mkdirSync(path.dirname(bootFile), { recursive: true });
  fs.writeFileSync(bootFile, 'x'.repeat(4000));
  await runCli({
    argv: ['--update'],
    cwd: root,
    config,
    stdout: makeSink(),
    stderr: makeSink(),
  });

  // Grow the boot context by 1000 bytes — still far below the 8192 ceiling, so
  // the overflow gate stays silent and only the drift check can see it.
  fs.appendFileSync(bootFile, 'y'.repeat(1000));

  const stdout = makeSink();
  const stderr = makeSink();
  const code = await runCli({ argv: [], cwd: root, config, stdout, stderr });
  assert.equal(code, 1);
  assert.match(stdout.text(), /\+ agentBoot drift: \.agents\/agents\/ok\.md/);
  assert.match(stdout.text(), /records 4000 bytes but the file is 5000/);
  // The real remaining headroom is stated, not left to the reader.
  assert.match(stdout.text(), /real headroom 3192/);
  assert.match(stderr.text(), /overstates the headroom/);
});

test('runCli exits 0 with an informational marker when a recorded row overstates its boot context', async () => {
  const { root, config } = makeRepo();
  const bootFile = path.join(root, '.agents', 'agents', 'ok.md');
  fs.mkdirSync(path.dirname(bootFile), { recursive: true });
  fs.writeFileSync(bootFile, 'x'.repeat(4000));
  await runCli({
    argv: ['--update'],
    cwd: root,
    config,
    stdout: makeSink(),
    stderr: makeSink(),
  });

  // The file shrank: the row is now conservative, and a conservative row can
  // only make an author under-spend — it never buys headroom that is not there.
  fs.writeFileSync(bootFile, 'x'.repeat(3000));

  const stdout = makeSink();
  const code = await runCli({
    argv: [],
    cwd: root,
    config,
    stdout,
    stderr: makeSink(),
  });
  assert.equal(code, 0);
  assert.match(stdout.text(), /- agentBoot drift: \.agents\/agents\/ok\.md/);
});

// ---------------------------------------------------------------------------
// Workflow mandatory-closure ratchet (Story #4752)
// ---------------------------------------------------------------------------

test('the workflow mandatory closure is a gated tier', () => {
  assert.ok(GATED_TIERS.includes('workflow'));
});

test('--update records the workflow tier and the per-entry-point reachable closure', async () => {
  const { root, config } = makeRepo({ withWorkflows: true });
  await runCli({
    argv: ['--update'],
    cwd: root,
    config,
    stdout: makeSink(),
    stderr: makeSink(),
  });
  const baseline = loadBaseline(
    path.join(root, 'baselines', 'context-budget.json'),
  );
  assert.ok(baseline.tiers.workflow.totalBytes > 0);
  assert.deepEqual(
    baseline.tiers.workflow.files.map((f) => f.path),
    [
      '.agents/workflows/helpers/digest.md',
      '.agents/workflows/mandrel-deliver.md',
    ],
  );
  // Reachable is recorded alongside the gated tiers, never inside them.
  assert.ok(
    baseline.workflowClosure.reachableTotalBytes >
      baseline.tiers.workflow.totalBytes,
  );
  assert.deepEqual(
    baseline.workflowClosure.entryPoints.map((e) => e.path),
    ['.agents/workflows/mandrel-deliver.md'],
  );
  assert.ok(baseline.workflowClosure.entryPoints[0].reachableBytes > 0);
});

test('runCli exits 1 when a mandatory workflow read grows beyond tolerance', async () => {
  const { root, config } = makeRepo({ withWorkflows: true });
  await runCli({
    argv: ['--update'],
    cwd: root,
    config,
    stdout: makeSink(),
    stderr: makeSink(),
  });
  const baseline = loadBaseline(
    path.join(root, 'baselines', 'context-budget.json'),
  );
  fs.appendFileSync(
    path.join(root, '.agents', 'workflows', 'helpers', 'digest.md'),
    'x'.repeat(baseline.toleranceBytes + 1000),
  );
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await runCli({ argv: [], cwd: root, config, stdout, stderr });
  assert.equal(code, 1);
  assert.match(stdout.text(), /\+ workflow:/);
  assert.match(stderr.text(), /grew beyond tolerance/);
});

test('a promoted on-demand read trips the ratchet — the marker, not the bytes, is the signal', async () => {
  const { root, config, write } = makeRepo({ withWorkflows: true });
  await runCli({
    argv: ['--update'],
    cwd: root,
    config,
    stdout: makeSink(),
    stderr: makeSink(),
  });
  // Same bytes on disk; the appendix is merely re-declared as a mandatory read.
  write(
    '.agents/workflows/helpers/appendix.md',
    `---\ndescription: appendix\n---\n\n# Appendix\n${'y'.repeat(4000)}\n`,
  );
  await runCli({
    argv: ['--update'],
    cwd: root,
    config,
    stdout: makeSink(),
    stderr: makeSink(),
  });
  write(
    '.agents/workflows/mandrel-deliver.md',
    '---\ndescription: fixture\nmandatoryReads: [helpers/digest.md, helpers/appendix.md]\n---\n\n# /mandrel-deliver\n\n[digest](helpers/digest.md) [appendix](helpers/appendix.md)\n',
  );
  const stdout = makeSink();
  const code = await runCli({
    argv: [],
    cwd: root,
    config,
    stdout,
    stderr: makeSink(),
  });
  assert.equal(code, 1);
  assert.match(stdout.text(), /\+ workflow:/);
});

test('growth in the reachable-only closure is reported but never gates', async () => {
  const { root, config } = makeRepo({ withWorkflows: true });
  await runCli({
    argv: ['--update'],
    cwd: root,
    config,
    stdout: makeSink(),
    stderr: makeSink(),
  });
  // The appendix is reachable but not mandatory — bloat it far past tolerance.
  fs.appendFileSync(
    path.join(root, '.agents', 'workflows', 'helpers', 'appendix.md'),
    'z'.repeat(50_000),
  );
  const stdout = makeSink();
  const code = await runCli({
    argv: [],
    cwd: root,
    config,
    stdout,
    stderr: makeSink(),
  });
  assert.equal(code, 0);
  assert.match(stdout.text(), /workflow reachable closure: \d+ bytes/);
  assert.match(stdout.text(), /never gated/);
});

test('AC-8: a shrunken workflow tier exits 0 and is reported, not failed', async () => {
  const { root, config, write } = makeRepo({ withWorkflows: true });
  write('.agents/workflows/helpers/digest.md', `# Digest\n${'q'.repeat(3000)}`);
  await runCli({
    argv: ['--update'],
    cwd: root,
    config,
    stdout: makeSink(),
    stderr: makeSink(),
  });
  write('.agents/workflows/helpers/digest.md', '# Digest\n');
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await runCli({ argv: [], cwd: root, config, stdout, stderr });
  assert.equal(code, 0);
  assert.match(stdout.text(), /- workflow: \d+ bytes is under the recorded/);
  assert.match(stdout.text(), /shrunk=1/);
  assert.doesNotMatch(stderr.text(), /came in under its recorded total/);
});

test('a recorded row whose file was deleted fails the gate and is named', async () => {
  const { root, config, write } = makeRepo({ withWorkflows: true });
  write('.agents/workflows/retired.md', `# Retired\n${'q'.repeat(300)}`);
  await runCli({
    argv: ['--update'],
    cwd: root,
    config,
    stdout: makeSink(),
    stderr: makeSink(),
  });
  fs.rmSync(path.join(root, '.agents/workflows/retired.md'));
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await runCli({ argv: [], cwd: root, config, stdout, stderr });
  assert.equal(code, 1);
  assert.match(stdout.text(), /recorded row \.agents\/workflows\/retired\.md/);
  assert.match(stderr.text(), /no longer contains/);
});

test('the committed context-budget baseline carries no tier drift against this repo tree', () => {
  // A stale row fails and the close writes shrinkage back (Story #5313), so
  // the committed baseline must agree with the tree exactly — a later Story
  // that trims a tracked file lands with its rows refreshed.
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, '.agents', 'scripts', 'check-context-budget.js')],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
  );
  assert.match(result.stdout ?? '', /grown=0 shrunk=0 absent=0/);
  assert.equal(
    result.status,
    0,
    `context-budget gate exited ${result.status}:\n${result.stdout}\n${result.stderr}`,
  );
});

test('renderReachable is silent without a workflow closure and cites the recorded total with one', () => {
  assert.equal(renderReachable({}, null), '');
  assert.equal(
    renderReachable({ workflowClosure: { reachableTotalBytes: 0 } }),
    '',
  );
  assert.match(
    renderReachable(
      {
        workflowClosure: {
          reachableTotalBytes: 900,
          entryPoints: [{ path: 'a' }, { path: 'b' }],
        },
      },
      { workflowClosure: { reachableTotalBytes: 800 } },
    ),
    /900 bytes across 2 entry points \(recorded 800\) — drift signal, never gated/,
  );
});

/**
 * Run the real CLI as a subprocess against a fixture root, so the assertion is
 * on the **process exit code** rather than the in-process return value.
 */
function runScript(root) {
  const script = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '.agents',
    'scripts',
    'check-context-budget.js',
  );
  return spawnSync(process.execPath, [script, '--root', root], {
    encoding: 'utf8',
  });
}

test('the CLI exits non-zero naming the workflow and path when a mandatoryReads entry is missing', () => {
  const { root, write } = makeRepo({ withWorkflows: true });
  write(
    '.agents/workflows/mandrel-deliver.md',
    '---\ndescription: fixture\nmandatoryReads: [helpers/gone.md]\n---\n\n# /mandrel-deliver\n',
  );
  const result = runScript(root);
  assert.notEqual(result.status, 0);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /\.agents\/workflows\/mandrel-deliver\.md/);
  assert.match(output, /helpers\/gone\.md/);
});

test('the CLI exits non-zero naming the cycle when mandatoryReads edges loop', () => {
  const { root, write } = makeRepo({ withWorkflows: true });
  write(
    '.agents/workflows/mandrel-deliver.md',
    '---\ndescription: fixture\nmandatoryReads: [helpers/digest.md]\n---\n\n# /mandrel-deliver\n',
  );
  write(
    '.agents/workflows/helpers/digest.md',
    '---\ndescription: fixture\nmandatoryReads: [appendix.md]\n---\n\n# Digest\n',
  );
  write(
    '.agents/workflows/helpers/appendix.md',
    '---\ndescription: fixture\nmandatoryReads: [digest.md]\n---\n\n# Appendix\n',
  );
  const result = runScript(root);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /cycle/);
});

test('runCli propagates a loud workflow-closure failure instead of degrading', async () => {
  const { root, config, write } = makeRepo({ withWorkflows: true });
  write(
    '.agents/workflows/mandrel-deliver.md',
    '---\ndescription: fixture\nmandatoryReads: [helpers/gone.md]\n---\n\n# /mandrel-deliver\n',
  );
  await assert.rejects(
    runCli({
      argv: [],
      cwd: root,
      config,
      stdout: makeSink(),
      stderr: makeSink(),
    }),
    /helpers\/gone\.md/,
  );
});

test('runCli is a no-op (exit 0) when the baseline is absent', async () => {
  const { root, config } = makeRepo();
  const stderr = makeSink();
  const code = await runCli({
    argv: [],
    cwd: root,
    config,
    stdout: makeSink(),
    stderr,
  });
  assert.equal(code, 0);
  assert.match(stderr.text(), /budget not found/);
});

test('runCli no-ops (exit 0) against a fixture with no CLAUDE.md — every gated tier empty', async () => {
  // No CLAUDE.md → alwaysLoaded empty; no docsContextFiles → mandatoryRead empty.
  const { root, config } = makeRepo({
    withClaude: false,
    docsContextFiles: [],
  });
  // Seed a baseline that DOES carry both tiers, to prove the empty resolved
  // tiers are skipped (not falsely failed) rather than merely un-compared.
  fs.mkdirSync(path.join(root, 'baselines'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'baselines', 'context-budget.json'),
    JSON.stringify({
      toleranceBytes: 0,
      tiers: {
        alwaysLoaded: { totalBytes: 1, files: [] },
        mandatoryRead: { totalBytes: 1, files: [] },
      },
    }),
  );
  const code = await runCli({
    argv: [],
    cwd: root,
    config,
    stdout: makeSink(),
    stderr: makeSink(),
  });
  assert.equal(code, 0);
});
