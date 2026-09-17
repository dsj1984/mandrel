import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  budgetFailureCount,
  buildBaseline,
  diffBudget,
  ENFORCED_TIERS,
  loadBaseline,
  MEASURED_TIERS,
  parseArgv,
  renderDiff,
  renderReachable,
  runCli,
} from '../.agents/scripts/check-context-budget.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';

/**
 * Unit coverage for the context-budget command (Story #4438).
 *
 * Exercises the pure helpers, then drives `runCli` end-to-end against tmpdir
 * fixtures: a seeded budget passes; an artificial byte increase beyond
 * tolerance to an always-loaded file fails naming the tier; a missing budget
 * and an empty resolved tier are clean no-ops.
 *
 * Story #5340 narrowed the failing set to the `alwaysLoaded` tier. Every other
 * measured tier — and the role-scoped `agentBoot` tier, whose per-file 8 KB
 * ceiling and row-vs-tree drift gate were deleted outright — is measured,
 * recorded and printed, and never fails the command. The tests below assert
 * both halves: the always-loaded gate still bites, and workflow drift does not.
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

/** A one-tier baseline whose recorded rows name a file the tree lost. */
function absentRowFixture(tier) {
  return diffBudget(
    { tiers: { [tier]: [{ path: 'a.md', bytes: 100 }] } },
    {
      toleranceBytes: 0,
      tiers: {
        [tier]: {
          totalBytes: 100,
          files: [
            { path: 'a.md', bytes: 100 },
            { path: 'deleted.md', bytes: 0 },
          ],
        },
      },
    },
  );
}

test('diffBudget reports a recorded row naming a path the tier no longer contains', () => {
  const diff = absentRowFixture('workflow');
  // The total still agrees — only the row-level check can see this one.
  assert.deepEqual(diff.grown, []);
  assert.deepEqual(diff.shrunk, []);
  assert.equal(diff.absent.length, 1);
  assert.equal(diff.absent[0].path, 'deleted.md');
  assert.equal(diff.absent[0].tier, 'workflow');
  // Story #5340: reported, but the workflow tier no longer fails the command.
  assert.equal(budgetFailureCount(diff), 0);
});

test('an unbacked row still fails in the always-loaded tier — the one gate that remains', () => {
  const diff = absentRowFixture('alwaysLoaded');
  assert.equal(diff.absent.length, 1);
  assert.equal(budgetFailureCount(diff), 1);
  assert.deepEqual(ENFORCED_TIERS, ['alwaysLoaded']);
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

test('buildBaseline records only the measured tiers with totals', () => {
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
  assert.deepEqual(
    Object.keys(envelope.tiers).sort(),
    [...MEASURED_TIERS].sort(),
  );
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

test('renderDiff reports shrinkage as ok and an unbacked always-loaded row as a gate failure', () => {
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
    absent: [{ tier: 'alwaysLoaded', path: 'gone.md', bytes: 12 }],
    skipped: [],
  });
  assert.match(missing, /\(gate fail\)/);
  assert.match(missing, /recorded row gone\.md names a path/);
  assert.match(missing, /absent=1/);
});

test('renderDiff marks report-only drift `~` and says so on the line (Story #5340)', () => {
  // A reader must be able to tell a reported line from a failing one without
  // cross-referencing ENFORCED_TIERS — the `~` and the suffix carry it.
  const out = renderDiff({
    grown: [
      {
        tier: 'workflow',
        current: 5000,
        baseline: 1000,
        tolerance: 0,
        delta: 4000,
      },
    ],
    shrunk: [],
    absent: [{ tier: 'workflow', path: 'gone.md', bytes: 12 }],
    skipped: [],
  });
  assert.match(out, /\(ok\)/);
  assert.match(out, /~ workflow: 5000 bytes exceeds budget 1000/);
  assert.match(out, /~ workflow: recorded row gone\.md/);
  assert.equal(out.match(/reported, never gated/g).length, 2);
  assert.doesNotMatch(out, /^\+ /m);
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

// ---------------------------------------------------------------------------
// Workflow mandatory-closure ratchet (Story #4752)
// ---------------------------------------------------------------------------

test('the workflow mandatory closure is measured but never enforced', () => {
  assert.ok(MEASURED_TIERS.includes('workflow'));
  assert.ok(!ENFORCED_TIERS.includes('workflow'));
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

test('AC-1: runCli exits 0 when a mandatory workflow read grows beyond tolerance', async () => {
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
  assert.equal(code, 0);
  assert.match(stdout.text(), /~ workflow:/);
  assert.match(stdout.text(), /reported, never gated/);
  assert.equal(stderr.text(), '');
});

test('a promoted on-demand read is reported — the marker, not the bytes, is the signal', async () => {
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
  assert.equal(code, 0);
  assert.match(stdout.text(), /~ workflow:/);
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

test('a recorded workflow row whose file was deleted is named but never fails', async () => {
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
  assert.equal(code, 0);
  assert.match(stdout.text(), /recorded row \.agents\/workflows\/retired\.md/);
  assert.equal(stderr.text(), '');
});

test('a recorded always-loaded row whose file was deleted still fails the gate', async () => {
  const { root, config, write } = makeRepo();
  write('CLAUDE.md', '@AGENTS.md\n@EXTRA.md\n');
  write('EXTRA.md', `extra closure body\n${'q'.repeat(300)}`);
  await runCli({
    argv: ['--update'],
    cwd: root,
    config,
    stdout: makeSink(),
    stderr: makeSink(),
  });
  write('CLAUDE.md', '@AGENTS.md\n');
  fs.rmSync(path.join(root, 'EXTRA.md'));
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await runCli({ argv: [], cwd: root, config, stdout, stderr });
  assert.equal(code, 1);
  assert.match(stdout.text(), /recorded row EXTRA\.md/);
  assert.match(stderr.text(), /no longer contains/);
});

test('AC-3: the CLI enforces no per-file ceiling on a role-scoped boot context', async () => {
  const { root, config } = makeRepo();
  // Far past the 8192-byte ceiling Story #5340 deleted.
  fs.mkdirSync(path.join(root, '.agents', 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.agents', 'agents', 'huge.md'),
    'x'.repeat(40_000),
  );
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
  assert.equal(code, 0);
  assert.match(stdout.text(), /agentBoot: 40000 bytes across 1 role defs/);
  assert.match(stdout.text(), /never gated/);
  assert.equal(stderr.text(), '');
  // The recorded rows carry no ceiling and no headroom to drift against.
  const baseline = loadBaseline(
    path.join(root, 'baselines', 'context-budget.json'),
  );
  assert.deepEqual(baseline.agentBoot.files, [
    { path: '.agents/agents/huge.md', bytes: 40_000 },
  ]);
  assert.ok(!('ceilingBytes' in baseline.agentBoot));
});

test('AC-3: a recorded agentBoot row that disagrees with the tree is not a failure', async () => {
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
  fs.appendFileSync(bootFile, 'y'.repeat(1000));
  const stderr = makeSink();
  const code = await runCli({
    argv: [],
    cwd: root,
    config,
    stdout: makeSink(),
    stderr,
  });
  assert.equal(code, 0);
  assert.equal(stderr.text(), '');
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

test('runCli no-ops (exit 0) against a fixture with no CLAUDE.md — every measured tier empty', async () => {
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
