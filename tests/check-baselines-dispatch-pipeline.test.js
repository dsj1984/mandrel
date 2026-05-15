// tests/check-baselines-dispatch-pipeline.test.js
//
// Story #1965 / Task #1977 — dispatcher pipeline contract.
//
// Pins the per-kind pipeline contract for `check-baselines.js`:
//
//   - Per-kind pipelines run via `Promise.all` (parallel start across
//     enabled kinds) rather than the legacy serial floor-only loop.
//   - Each baseline JSON file is read at most once per dispatcher
//     invocation. We assert this by spying on `fs.readFileSync` and
//     counting reads against the per-kind baseline path.
//   - The dispatcher imports the new helpers (`scope`, `git-base`,
//     `exit-codes`) — pinned via a static-source assertion so a
//     regression that drops one of the imports trips the test.
//
// The friction-emission and exit-code contracts are covered by sibling
// test files (`check-baselines-friction.test.js`,
// `check-baselines-exit-codes.test.js`).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCheckBaselines } from '../.agents/scripts/check-baselines.js';
import { currentKernelVersion } from '../.agents/scripts/lib/baselines/kernel.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

function writeJson(p, value) {
  writeFileSync(p, JSON.stringify(value, null, 2));
}

function coverageEnvelope({ rollup, rows } = {}) {
  return {
    $schema: 'coverage.schema.json',
    kernelVersion: currentKernelVersion('coverage'),
    generatedAt: '2026-01-01T00:00:00.000Z',
    rollup: rollup ?? { '*': { lines: 95, branches: 92, functions: 95 } },
    rows: rows ?? [],
  };
}

function lintEnvelope({ rollup, rows } = {}) {
  return {
    $schema: 'lint.schema.json',
    kernelVersion: currentKernelVersion('lint'),
    generatedAt: '2026-01-01T00:00:00.000Z',
    rollup: rollup ?? { '*': { errorCount: 0, warningCount: 0 } },
    rows: rows ?? [],
  };
}

function setupTmpRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'check-baselines-pipeline-'));
  mkdirSync(path.join(root, 'baselines'), { recursive: true });
  const agentrc = {
    project: {
      baseBranch: 'main',
      paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      docsContextFiles: [],
      commands: { lintBaseline: 'echo', test: 'echo', typecheck: 'echo' },
    },
    github: { owner: 'x', repo: 'y' },
    delivery: {
      quality: {
        gates: {
          coverage: {
            enabled: true,
            baselinePath: 'baselines/coverage.json',
            tolerance: { kind: 'absolute', value: 0 },
            floors: { '*': { lines: 90, branches: 85, functions: 90 } },
          },
          lint: {
            enabled: true,
            baselinePath: 'baselines/lint.json',
            tolerance: { kind: 'absolute', value: 0 },
            floors: { '*': { errorCount: 0, warningCount: 5 } },
          },
        },
      },
    },
  };
  writeJson(path.join(root, '.agentrc.json'), agentrc);
  writeJson(path.join(root, 'baselines', 'coverage.json'), coverageEnvelope());
  writeJson(path.join(root, 'baselines', 'lint.json'), lintEnvelope());
  return root;
}

describe('check-baselines — Promise.all over kinds (Task #1977)', () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('processes every configured kind in a single dispatch run', async () => {
    root = setupTmpRepo();
    const res = await runCheckBaselines({ argv: ['--no-friction'], cwd: root });
    assert.equal(res.exitCode, 0);
    const kinds = res.report.gates.map((g) => g.kind).sort();
    assert.deepEqual(kinds, ['coverage', 'lint']);
  });

  it('starts per-kind pipelines in parallel (Promise.all semantics)', async () => {
    // We cannot directly observe Promise.all without mocking, but we can
    // assert the source imports `Promise.all` and uses it for the per-kind
    // wanted-list mapping. A serial `for…of await` would not contain
    // `Promise.all`. This is a structural pin: the implementation must
    // continue to use Promise.all over the kinds.
    const source = readFileSync(
      path.join(repoRoot, '.agents/scripts/check-baselines.js'),
      'utf8',
    );
    assert.ok(
      /Promise\.all\s*\(\s*wanted\.map\s*\(/.test(source),
      'check-baselines.js must dispatch per-kind work via Promise.all(wanted.map(...))',
    );
  });
});

describe('check-baselines — read each baseline at most once (Task #1977)', () => {
  let root;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('reads each baseline file at most once per invocation (fs.readFileSync spy via node:test mock.method)', async () => {
    // ESM bindings make wholesale reassignment of fs.readFileSync
    // unreliable across already-resolved imports. node:test's
    // `mock.method` patches the property on the live `fs` object, which
    // both the reader's static `readFileSync` import and any post-mock
    // call go through (Node binds `readFileSync` to the same descriptor
    // backing fs.readFileSync). The spy records every baseline read.
    root = setupTmpRepo();
    const counts = new Map();
    const originalReadFileSync = fs.readFileSync;
    const spy = mock.method(fs, 'readFileSync', (p, ...rest) => {
      if (typeof p === 'string' && /baselines[\\/][a-z-]+\.json$/.test(p)) {
        counts.set(p, (counts.get(p) ?? 0) + 1);
      }
      return originalReadFileSync.call(fs, p, ...rest);
    });
    try {
      const res = await runCheckBaselines({
        argv: ['--no-friction'],
        cwd: root,
      });
      assert.equal(res.exitCode, 0);
      // Read-once contract: the dispatcher MUST NOT touch the same
      // baseline file twice within a single run. (The reader's lazy AJV
      // cache and the dispatcher's per-kind pipeline are jointly
      // responsible for keeping each baseline a single read.)
      for (const [file, count] of counts.entries()) {
        assert.ok(
          count <= 1,
          `baseline ${file} was read ${count} times; the dispatcher must read each baseline file at most once`,
        );
      }
    } finally {
      spy.mock.restore();
    }
  });
});

describe('check-baselines — imports the new helpers (Task #1977)', () => {
  it('imports scope, git-base, and exit-codes from lib/baselines', () => {
    const source = readFileSync(
      path.join(repoRoot, '.agents/scripts/check-baselines.js'),
      'utf8',
    );
    assert.ok(
      /from '\.\/lib\/baselines\/scope\.js'/.test(source),
      'expected import from ./lib/baselines/scope.js',
    );
    assert.ok(
      /from '\.\/lib\/baselines\/git-base\.js'/.test(source),
      'expected import from ./lib/baselines/git-base.js',
    );
    assert.ok(
      /from '\.\/lib\/baselines\/exit-codes\.js'/.test(source),
      'expected import from ./lib/baselines/exit-codes.js',
    );
  });
});

describe('check-baselines — per-kind compare wired (Task #1977)', () => {
  it('exposes a regressions list per gate (compare stage ran, even if empty)', async () => {
    const root2 = setupTmpRepo();
    try {
      const res = await runCheckBaselines({
        argv: ['--no-friction'],
        cwd: root2,
      });
      for (const g of res.report.gates) {
        assert.ok(
          Array.isArray(g.regressions),
          `gate ${g.kind} must expose a regressions array`,
        );
        assert.equal(typeof g.regressionCount, 'number');
      }
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });
});
