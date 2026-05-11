import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseArgs,
  renderTable,
  runDiagnose,
} from '../.agents/scripts/diagnose.js';

/**
 * Output-contract tests for the `/diagnose` CLI runner.
 *
 * These pin three Story-1288 acceptance criteria:
 *
 *   1. Table render lists the columns `id`, `severity`, `scope`,
 *      `summary`, `fix command` (header line assertion).
 *   2. `--fail-on-blocker` exits 0 when findings are empty, 2 when a
 *      blocker finding is present, and 0 when only warnings/info exist.
 *   3. `--json` output is exactly one line and parses to an object with
 *      a `findings` array (shape contract for downstream consumers).
 *
 * The CLI is exercised via its exported entry point `runDiagnose()` —
 * tests pass a captured-stdout sink and a fixture registry so they
 * stay hermetic. The disk-discovery + state-assembly paths are
 * covered separately in the registry tests under `tests/lib/checks/`.
 */

function buildFixtureRegistry({ findings = [] } = {}) {
  // Map each Finding into a check whose `detect()` returns that finding
  // verbatim. This keeps the fixture honest — the runner sees the same
  // shape it would see from disk-loaded checks, just synthesized inline.
  return findings.map((f) => ({
    id: f.id,
    severity: f.severity,
    scope: [f.scope ?? 'diagnose'],
    autoCorrect: 'refuse-and-print',
    detect: () => ({
      id: f.id,
      severity: f.severity,
      scope: f.scope ?? 'diagnose',
      summary: f.summary,
      fixCommand: f.fixCommand,
      autoCorrectable: false,
    }),
  }));
}

function captureStdout() {
  const lines = [];
  return {
    write: (line) => lines.push(line),
    text: () => lines.join('\n'),
    lines: () => lines.slice(),
  };
}

describe('parseArgs', () => {
  it('defaults scope to diagnose with no flags', () => {
    assert.deepEqual(parseArgs([]), {
      scope: 'diagnose',
      failOnBlocker: false,
      json: false,
    });
  });

  it('parses --scope, --fail-on-blocker, --json', () => {
    assert.deepEqual(
      parseArgs(['--scope', 'story-close', '--fail-on-blocker', '--json']),
      { scope: 'story-close', failOnBlocker: true, json: true },
    );
  });

  it('rejects unknown arguments', () => {
    assert.throws(() => parseArgs(['--unknown']), /unknown argument/);
  });

  it('rejects --scope with no value', () => {
    assert.throws(() => parseArgs(['--scope']), /--scope requires a value/);
  });
});

describe('renderTable', () => {
  it('includes the contract column header in the first line', () => {
    const out = renderTable([]);
    const header = out.split('\n')[0];
    for (const col of ['id', 'severity', 'scope', 'summary', 'fix command']) {
      assert.ok(
        header.includes(col),
        `header missing column ${col}: ${header}`,
      );
    }
  });

  it('shows (no findings) marker on the empty case', () => {
    const out = renderTable([]);
    assert.ok(out.includes('(no findings)'), `empty render: ${out}`);
  });

  it('renders one row per finding with all five columns populated', () => {
    const out = renderTable([
      {
        id: 'fixture',
        severity: 'blocker',
        scope: 'diagnose',
        summary: 'something is wrong',
        fixCommand: 'echo fix-me',
      },
    ]);
    const row = out.split('\n').at(-1);
    for (const cell of [
      'fixture',
      'blocker',
      'diagnose',
      'something is wrong',
      'echo fix-me',
    ]) {
      assert.ok(row.includes(cell), `row missing cell ${cell}: ${row}`);
    }
  });
});

describe('runDiagnose — exit-code semantics', () => {
  it('exits 0 against a clean registry (empty findings, table render)', async () => {
    const stdout = captureStdout();
    const result = await runDiagnose({
      argv: [],
      stdout: stdout.write,
      registry: buildFixtureRegistry(),
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.findings, []);
    assert.ok(
      stdout.text().includes('(no findings)'),
      'expected (no findings) marker in stdout',
    );
  });

  it('exits 0 with --fail-on-blocker against an empty findings set', async () => {
    const stdout = captureStdout();
    const result = await runDiagnose({
      argv: ['--fail-on-blocker'],
      stdout: stdout.write,
      registry: buildFixtureRegistry(),
    });
    assert.equal(result.exitCode, 0);
  });

  it('exits 2 with --fail-on-blocker when a blocker finding is present', async () => {
    const stdout = captureStdout();
    const result = await runDiagnose({
      argv: ['--fail-on-blocker'],
      stdout: stdout.write,
      registry: buildFixtureRegistry({
        findings: [
          {
            id: 'fixture-blocker',
            severity: 'blocker',
            scope: 'diagnose',
            summary: 'fixture blocker',
            fixCommand: 'echo fix',
          },
        ],
      }),
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, 'blocker');
  });

  it('exits 0 with --fail-on-blocker when only warnings exist', async () => {
    const stdout = captureStdout();
    const result = await runDiagnose({
      argv: ['--fail-on-blocker'],
      stdout: stdout.write,
      registry: buildFixtureRegistry({
        findings: [
          {
            id: 'fixture-warn',
            severity: 'warning',
            scope: 'diagnose',
            summary: 'fixture warning',
            fixCommand: 'echo fix',
          },
        ],
      }),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.findings.length, 1);
  });

  it('exits 0 with a blocker finding when --fail-on-blocker is NOT set', async () => {
    const stdout = captureStdout();
    const result = await runDiagnose({
      argv: [],
      stdout: stdout.write,
      registry: buildFixtureRegistry({
        findings: [
          {
            id: 'fixture-blocker',
            severity: 'blocker',
            scope: 'diagnose',
            summary: 'fixture blocker',
            fixCommand: 'echo fix',
          },
        ],
      }),
    });
    assert.equal(result.exitCode, 0);
  });
});

describe('runDiagnose — --json output shape', () => {
  it('emits exactly one line that parses to { findings: [...] }', async () => {
    const stdout = captureStdout();
    await runDiagnose({
      argv: ['--json'],
      stdout: stdout.write,
      registry: buildFixtureRegistry({
        findings: [
          {
            id: 'fixture',
            severity: 'blocker',
            scope: 'diagnose',
            summary: 'something is wrong',
            fixCommand: 'echo fix-me',
          },
        ],
      }),
    });
    const lines = stdout.lines();
    assert.equal(lines.length, 1, 'expected exactly one stdout line');
    const parsed = JSON.parse(lines[0]);
    assert.ok(Array.isArray(parsed.findings), 'findings must be an array');
    assert.equal(parsed.findings.length, 1);
    assert.equal(parsed.findings[0].id, 'fixture');
    assert.equal(parsed.findings[0].severity, 'blocker');
    assert.equal(parsed.findings[0].summary, 'something is wrong');
    assert.equal(parsed.findings[0].fixCommand, 'echo fix-me');
  });

  it('emits exactly one line for an empty findings set', async () => {
    const stdout = captureStdout();
    await runDiagnose({
      argv: ['--json'],
      stdout: stdout.write,
      registry: buildFixtureRegistry(),
    });
    const lines = stdout.lines();
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.deepEqual(parsed.findings, []);
  });

  it('--scope all maps to undefined scope in the runner (every check fires)', async () => {
    const stdout = captureStdout();
    const result = await runDiagnose({
      argv: ['--scope', 'all', '--json'],
      stdout: stdout.write,
      registry: buildFixtureRegistry({
        findings: [
          {
            id: 'fixture',
            severity: 'info',
            scope: 'epic-deliver',
            summary: 'something',
            fixCommand: 'echo',
          },
        ],
      }),
    });
    // With scope=all the runner must surface a check whose scope[] is
    // `['epic-deliver']` — a literal `--scope diagnose` would have
    // filtered it out, so this asserts the alias actually disables the
    // scope filter.
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].scope, 'epic-deliver');
  });
});
