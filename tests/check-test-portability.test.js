// tests/check-test-portability.test.js
//
// Unit tier (Story #5284): the static guard for the two Windows-only shapes
// that reach `main` through the advisory `windows-smoke` job.
//
// The guard is driven through its CLI rather than through imported helpers on
// purpose: it exports nothing, because an export consumed only by a test is
// what `check-dead-exports.js --production` reds on, and the guard's contract
// *is* its exit code and its `file:line` report.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(REPO_ROOT, '.agents/scripts/check-test-portability.js');

/**
 * Plant a synthetic repo root holding `files` (repo-relative path → source)
 * and run the guard over it.
 *
 * @param {Record<string, string>} files
 * @param {string[]} [args]
 * @returns {{ status: number, stdout: string, findings: object[] }}
 */
function runGuard(files, args = ['--json']) {
  const root = makeTempDir('portability-');
  for (const [rel, source] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, source, 'utf8');
  }
  const result = spawnSync(process.execPath, [GUARD, '--root', root, ...args], {
    encoding: 'utf8',
  });
  const stdout = result.stdout ?? '';
  let findings = [];
  if (args.includes('--json')) findings = JSON.parse(stdout).findings;
  return { status: result.status, stdout, findings };
}

describe('check-test-portability — the real tree', () => {
  it('exits 0 over this repository', () => {
    const result = spawnSync(process.execPath, [GUARD], { encoding: 'utf8' });
    assert.equal(
      result.status,
      0,
      `the guard must be green on the tree it ships with; it reported:\n${result.stdout}${result.stderr}`,
    );
    assert.match(result.stdout, /OK —/);
  });

  it('performs no scan for --help', () => {
    const result = spawnSync(process.execPath, [GUARD, '--help'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Usage: node \.agents\/scripts/);
    assert.doesNotMatch(result.stdout, /OK —|FAIL —/);
  });
});

describe('check-test-portability — a RegExp built from a path', () => {
  it('reports the file:line of an interpolated path expression', () => {
    const { status, findings } = runGuard({
      'tests/bad.test.js': [
        "import path from 'node:path';",
        '',
        'const dir = path.join(root, "x");',
        'assert.match(msg, new RegExp(`source: ${dir} \\\\(MISSING\\\\)`));', // portability-allow: negative fixture, not live code
      ].join('\n'),
    });
    assert.equal(status, 1);
    assert.deepEqual(
      findings.map((f) => [f.file, f.line, f.shape]),
      [['tests/bad.test.js', 4, 'regexp-from-path']],
    );
  });

  it('leaves an interpolation that carries no path expression alone', () => {
    const { status, findings } = runGuard({
      'tests/ok.test.js': [
        "const evidencePath = 'per-run';",
        'assert.match(reason, new RegExp(`evidence=${evidencePath}`));',
        'assert.match(src, new RegExp(`^##\\\\s+${heading}$`, "m"));',
      ].join('\n'),
    });
    assert.equal(status, 0);
    assert.deepEqual(findings, []);
  });

  it('accepts a path interpolation that escapes itself first', () => {
    const { status } = runGuard({
      'tests/escaped.test.js':
        'assert.match(out, new RegExp(`at ${path.resolve(a, b).replace(/\\\\/g, "\\\\\\\\")}`));\n',
    });
    assert.equal(status, 0);
  });
});

describe('check-test-portability — a dynamic import of a raw path', () => {
  it('reports an import whose argument is a path expression', () => {
    const { status, findings } = runGuard({
      'tests/import-bad.test.js':
        "const mod = await import(path.join(LIB, 'provider-factory.js'));\n", // portability-allow: negative fixture, not live code
    });
    assert.equal(status, 1);
    assert.deepEqual(
      findings.map((f) => [f.file, f.line, f.shape]),
      [['tests/import-bad.test.js', 1, 'import-raw-path']],
    );
  });

  it('accepts a pathToFileURL href, including one wrapped for a child script', () => {
    const { status, findings } = runGuard({
      'tests/import-ok.test.js': [
        'const { createProvider } = await import(',
        "  pathToFileURL(path.join(LIB, 'provider-factory.js')).href",
        ');',
        'const script = `',
        '  const { makeTempDir } = await import(${JSON.stringify(',
        "    pathToFileURL(path.join(REPO_ROOT, '.agents/scripts/lib/test-temp.js'))",
        '      .href,',
        '  )});',
        '`;',
        "const a = await import('./relative.js');",
        'const b = await import(`${SUT_URL}?t=${tag}`);',
      ].join('\n'),
    });
    assert.equal(status, 0);
    assert.deepEqual(findings, []);
  });

  it('does not scan a source outside the test roots', () => {
    const { status, findings } = runGuard({
      '.agents/scripts/lib/thing.js':
        "const mod = await import(path.join(LIB, 'x.js'));\n", // portability-allow: negative fixture, not live code
      '.agents/scripts/lib/__tests__/thing.test.js':
        "const mod = await import(path.join(LIB, 'y.js'));\n", // portability-allow: negative fixture, not live code
    });
    assert.equal(status, 1);
    assert.deepEqual(
      findings.map((f) => f.file),
      ['.agents/scripts/lib/__tests__/thing.test.js'],
    );
  });
});

describe('check-test-portability — noise control', () => {
  it('ignores both shapes inside comments', () => {
    const { status } = runGuard({
      'tests/comments.test.js': [
        '// never write new RegExp(`${path.join(a, b)}`) — it cannot match on Windows', // portability-allow: negative fixture, not live code
        '/* nor await import(path.resolve(a, b)) */', // portability-allow: negative fixture, not live code
        "const url = 'https://example.test/x';",
      ].join('\n'),
    });
    assert.equal(status, 0);
  });

  it('honours the escape marker on the line and the line above', () => {
    const { status, findings } = runGuard({
      'tests/allow.test.js': [
        'assert.match(m, new RegExp(`${dir}`)); // portability-allow: POSIX-only fixture',
        '// portability-allow: POSIX-only fixture',
        'assert.match(m, new RegExp(`${dir}`));',
      ].join('\n'),
    });
    assert.equal(status, 0);
    assert.deepEqual(findings, []);
  });

  it('names the shape and its remedy in the text report', () => {
    const { status, stdout } = runGuard(
      {
        'tests/bad.test.js':
          "const mod = await import(path.join(LIB, 'x.js'));\n", // portability-allow: negative fixture, not live code
      },
      [],
    );
    assert.equal(status, 1);
    assert.match(stdout, /tests\/bad\.test\.js:1\s+\[import-raw-path\]/);
    assert.match(stdout, /pathToFileURL\(p\)\.href/);
  });
});
