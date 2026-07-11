// tests/cli/doctor.test.js
/**
 * Unit tests for lib/cli/doctor.js — the mandrel doctor subcommand.
 *
 * All tests drive the doctor via injectable seams (`checks`, `write`, `exit`)
 * so no real child processes are spawned and no real filesystem is touched.
 *
 * Coverage contract (per Story #3450 AC):
 *   1. All-pass scenario: exit 0, ✔ per check, ✅ summary
 *   2. Missing-token scenario: ✘ for github-token, → remedy line, exit 1
 *   3. Missing-gh scenario: ✘ for gh-available, → remedy line, exit 1
 *   4. Final summary shows correct N/N counts
 *   5. Failed check without a remedy does not emit a → line
 *   6. runDoctor is exported; default export is a function
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import doctor, {
  formatClosureReport,
  runDoctor,
  writeDoctorResultCache,
} from '../../lib/cli/doctor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Capture all write() calls into an array and collect the exit code.
 *
 * @returns {{ lines: string[], exitCode: number|null, write: Function, exit: Function }}
 */
function makeCapture() {
  const lines = [];
  let exitCode = null;
  return {
    lines,
    get exitCode() {
      return exitCode;
    },
    write(s) {
      lines.push(s);
    },
    exit(code) {
      exitCode = code;
    },
  };
}

/**
 * Build a minimal fake check.
 *
 * @param {string} name
 * @param {{ ok: boolean, detail: string, remedy?: string }} result
 */
function fakeCheck(name, result) {
  return { name, run: () => result };
}

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('doctor module exports', () => {
  it('exports runDoctor as a named export', () => {
    assert.equal(typeof runDoctor, 'function');
  });

  it('exports a default function for bin/mandrel.js dispatch', () => {
    assert.equal(typeof doctor, 'function');
  });
});

// ---------------------------------------------------------------------------
// All-pass scenario
// ---------------------------------------------------------------------------

describe('runDoctor — all checks pass', () => {
  const checks = [
    fakeCheck('node-version', { ok: true, detail: 'v22.22.1' }),
    fakeCheck('git-available', { ok: true, detail: 'git version 2.49.0' }),
    fakeCheck('gh-available', { ok: true, detail: 'gh version 2.72.0' }),
    fakeCheck('github-token', { ok: true, detail: 'GITHUB_TOKEN set' }),
    fakeCheck('gh-auth', { ok: true, detail: 'logged in as dsj1984' }),
    fakeCheck('commands-in-sync', {
      ok: true,
      detail: '12 commands up to date',
    }),
    fakeCheck('runtime-deps', { ok: true, detail: 'all dependencies found' }),
  ];

  it('does not call exit when all checks pass', async () => {
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    assert.equal(cap.exitCode, null);
  });

  it('emits a ✔ line for each passing check', async () => {
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    const joined = cap.lines.join('');
    assert.match(joined, /✔/);
    for (const check of checks) {
      assert.match(joined, new RegExp(check.name));
    }
  });

  it('does not emit any ✘ lines', async () => {
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    const joined = cap.lines.join('');
    assert.doesNotMatch(joined, /✘/);
  });

  it('emits the ✅ Ready summary line', async () => {
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    const joined = cap.lines.join('');
    assert.match(joined, /✅\s+Ready \(7\/7 checks passed\)/);
  });

  it('includes the detail string in each ✔ line', async () => {
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    const joined = cap.lines.join('');
    assert.match(joined, /v22\.22\.1/);
    assert.match(joined, /git version 2\.49\.0/);
  });
});

// ---------------------------------------------------------------------------
// Missing-token scenario
// ---------------------------------------------------------------------------

describe('runDoctor — github-token fails', () => {
  const checks = [
    fakeCheck('node-version', { ok: true, detail: 'v22.22.1' }),
    fakeCheck('git-available', { ok: true, detail: 'git version 2.49.0' }),
    fakeCheck('gh-available', { ok: true, detail: 'gh version 2.72.0' }),
    fakeCheck('github-token', {
      ok: false,
      detail: 'GITHUB_TOKEN not set',
      remedy: 'Run: export GITHUB_TOKEN=<your-token>  (or add to .env)',
    }),
    fakeCheck('gh-auth', { ok: true, detail: 'logged in as dsj1984' }),
    fakeCheck('commands-in-sync', {
      ok: true,
      detail: '12 commands up to date',
    }),
    fakeCheck('runtime-deps', { ok: true, detail: 'all dependencies found' }),
  ];

  it('calls exit(1) when github-token fails', async () => {
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    assert.equal(cap.exitCode, 1);
  });

  it('emits a ✘ line for github-token', async () => {
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    const joined = cap.lines.join('');
    assert.match(joined, /✘/);
    assert.match(joined, /github-token/);
    assert.match(joined, /GITHUB_TOKEN not set/);
  });

  it('emits the remedy line for github-token', async () => {
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    const joined = cap.lines.join('');
    assert.match(joined, /→.*GITHUB_TOKEN/);
  });

  it('emits the ❌ Not ready summary line with correct counts', async () => {
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    const joined = cap.lines.join('');
    assert.match(joined, /❌\s+Not ready \(1\/7 checks failed\)/);
  });
});

// ---------------------------------------------------------------------------
// Missing-gh scenario
// ---------------------------------------------------------------------------

describe('runDoctor — gh-available fails', () => {
  const ghNotFoundRemedy =
    'Install gh CLI: https://cli.github.com/ — then re-run.';
  const checks = [
    fakeCheck('node-version', { ok: true, detail: 'v22.22.1' }),
    fakeCheck('git-available', { ok: true, detail: 'git version 2.49.0' }),
    fakeCheck('gh-available', {
      ok: false,
      detail: 'gh not found on PATH',
      remedy: ghNotFoundRemedy,
    }),
    fakeCheck('github-token', { ok: true, detail: 'GITHUB_TOKEN set' }),
    fakeCheck('gh-auth', { ok: true, detail: 'logged in as dsj1984' }),
    fakeCheck('commands-in-sync', {
      ok: true,
      detail: '12 commands up to date',
    }),
    fakeCheck('runtime-deps', { ok: true, detail: 'all dependencies found' }),
  ];

  it('calls exit(1) when gh-available fails', async () => {
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    assert.equal(cap.exitCode, 1);
  });

  it('emits a ✘ line for gh-available with detail', async () => {
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    const joined = cap.lines.join('');
    assert.match(joined, /✘/);
    assert.match(joined, /gh-available/);
    assert.match(joined, /gh not found on PATH/);
  });

  it('emits the remedy line for gh-available', async () => {
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    const joined = cap.lines.join('');
    assert.match(joined, /→.*cli\.github\.com/);
  });

  it('emits the ❌ Not ready summary with 1/7 failed', async () => {
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    const joined = cap.lines.join('');
    assert.match(joined, /❌\s+Not ready \(1\/7 checks failed\)/);
  });
});

// ---------------------------------------------------------------------------
// Multiple failures
// ---------------------------------------------------------------------------

describe('runDoctor — multiple checks fail', () => {
  const checks = [
    fakeCheck('check-a', {
      ok: false,
      detail: 'a failed',
      remedy: 'fix a',
    }),
    fakeCheck('check-b', { ok: true, detail: 'b ok' }),
    fakeCheck('check-c', {
      ok: false,
      detail: 'c failed',
      remedy: 'fix c',
    }),
  ];

  it('calls exit(1)', async () => {
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    assert.equal(cap.exitCode, 1);
  });

  it('emits the ❌ Not ready summary with 2/3 failed', async () => {
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    const joined = cap.lines.join('');
    assert.match(joined, /❌\s+Not ready \(2\/3 checks failed\)/);
  });

  it('emits remedy lines for each failed check', async () => {
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    const joined = cap.lines.join('');
    assert.match(joined, /→.*fix a/);
    assert.match(joined, /→.*fix c/);
  });
});

// ---------------------------------------------------------------------------
// Failed check with no remedy
// ---------------------------------------------------------------------------

describe('runDoctor — failed check with no remedy', () => {
  const checks = [
    fakeCheck('no-remedy-check', { ok: false, detail: 'something is wrong' }),
  ];

  it('calls exit(1)', async () => {
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    assert.equal(cap.exitCode, 1);
  });

  it('does not emit a → line when remedy is absent', async () => {
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    const joined = cap.lines.join('');
    assert.doesNotMatch(joined, /→/);
  });
});

// ---------------------------------------------------------------------------
// Summary counts
// ---------------------------------------------------------------------------

describe('runDoctor — summary N/N counts', () => {
  it('reports 0/3 passed when all fail', async () => {
    const checks = [
      fakeCheck('a', { ok: false, detail: 'fail', remedy: 'r' }),
      fakeCheck('b', { ok: false, detail: 'fail', remedy: 'r' }),
      fakeCheck('c', { ok: false, detail: 'fail', remedy: 'r' }),
    ];
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    assert.match(cap.lines.join(''), /❌\s+Not ready \(3\/3 checks failed\)/);
  });

  it('reports 3/3 passed when all pass', async () => {
    const checks = [
      fakeCheck('a', { ok: true, detail: 'ok' }),
      fakeCheck('b', { ok: true, detail: 'ok' }),
      fakeCheck('c', { ok: true, detail: 'ok' }),
    ];
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    assert.match(cap.lines.join(''), /✅\s+Ready \(3\/3 checks passed\)/);
  });

  it('reports 2/3 passed for a mixed set', async () => {
    const checks = [
      fakeCheck('a', { ok: true, detail: 'ok' }),
      fakeCheck('b', { ok: false, detail: 'fail', remedy: 'fix it' }),
      fakeCheck('c', { ok: true, detail: 'ok' }),
    ];
    const cap = makeCapture();
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
    });
    assert.match(cap.lines.join(''), /❌\s+Not ready \(1\/3 checks failed\)/);
  });
});

// ---------------------------------------------------------------------------
// Result cache (temp/doctor-result.json)
// ---------------------------------------------------------------------------

describe('runDoctor — result cache verdict', () => {
  it('records "ready" when all checks pass', async () => {
    const checks = [fakeCheck('a', { ok: true, detail: 'ok' })];
    const cap = makeCapture();
    let recorded = null;
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: (verdict) => {
        recorded = verdict;
      },
    });
    assert.equal(recorded, 'ready');
  });

  it('records "unready" when any check fails', async () => {
    const checks = [
      fakeCheck('a', { ok: true, detail: 'ok' }),
      fakeCheck('b', { ok: false, detail: 'fail', remedy: 'r' }),
    ];
    const cap = makeCapture();
    let recorded = null;
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: (verdict) => {
        recorded = verdict;
      },
    });
    assert.equal(recorded, 'unready');
  });
});

describe('writeDoctorResultCache', () => {
  /** In-memory fs fake covering mkdirSync + writeFileSync. */
  function makeFakeFs() {
    const writes = new Map();
    const dirs = [];
    return {
      writes,
      dirs,
      mkdirSync(dir, opts) {
        dirs.push({ dir, opts });
      },
      writeFileSync(p, content) {
        writes.set(p, content);
      },
    };
  }

  it('writes { verdict, checkedAt } to <cwd>/temp/doctor-result.json', () => {
    const fakeFs = makeFakeFs();
    writeDoctorResultCache('ready', { fs: fakeFs, cwd: () => '/proj' });

    const [dir] = fakeFs.dirs;
    assert.ok(dir.dir.endsWith('temp'), 'creates the temp/ scratch dir');
    assert.deepEqual(dir.opts, { recursive: true });

    const [[file, content]] = [...fakeFs.writes.entries()];
    assert.ok(file.endsWith('doctor-result.json'));
    const parsed = JSON.parse(content);
    assert.equal(parsed.verdict, 'ready');
    assert.ok(
      !Number.isNaN(Date.parse(parsed.checkedAt)),
      'checkedAt is a parseable ISO timestamp',
    );
  });

  it('swallows write failures (best-effort, never throws)', () => {
    const throwingFs = {
      mkdirSync() {
        throw new Error('EACCES');
      },
      writeFileSync() {
        throw new Error('EACCES');
      },
    };
    assert.doesNotThrow(() =>
      writeDoctorResultCache('unready', { fs: throwingFs, cwd: () => '/x' }),
    );
  });
});

// ---------------------------------------------------------------------------
// formatClosureReport — the report-only always-loaded closure line (#4438)
// ---------------------------------------------------------------------------

describe('formatClosureReport', () => {
  it('reports file count and KB when a closure resolves', () => {
    const line = formatClosureReport({
      cwd: () => '/repo',
      resolveClosure: () => [
        { path: 'CLAUDE.md', bytes: 1024 },
        { path: 'AGENTS.md', bytes: 2048 },
      ],
    });
    assert.match(line, /context-closure/);
    assert.match(line, /2 file\(s\), 3\.0 KB always-loaded/);
    assert.ok(line.endsWith('\n'));
  });

  it('degrades to a neutral line when no CLAUDE.md closure exists', () => {
    const line = formatClosureReport({
      cwd: () => '/x',
      resolveClosure: () => [],
    });
    assert.match(line, /no CLAUDE\.md closure found/);
  });

  it('never throws — a resolver failure yields an "unavailable" line', () => {
    const line = formatClosureReport({
      cwd: () => '/x',
      resolveClosure: () => {
        throw new Error('boom');
      },
    });
    assert.match(line, /always-loaded closure unavailable/);
  });
});

describe('runDoctor closure report line (#4438)', () => {
  it('emits the report line without changing the pass/fail verdict', async () => {
    const cap = makeCapture();
    const checks = [{ name: 'x', run: () => ({ ok: true, detail: 'ok' }) }];
    await runDoctor({
      checks,
      write: cap.write,
      exit: cap.exit,
      writeResultCache: () => {},
      closureReport: () =>
        'ℹ  context-closure  1 file(s), 1.0 KB always-loaded\n',
    });
    const out = cap.lines.join('');
    assert.match(out, /context-closure/);
    // The report line is not counted: 1/1 checks still pass, exit stays 0.
    assert.match(out, /Ready \(1\/1 checks passed\)/);
    assert.equal(cap.exitCode, null); // exit(0) is never called on all-pass
  });
});
