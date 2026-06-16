/**
 * refresh-service.diff-scope-ignore-globs.test.js — regression contract for
 * the diff-scoped maintainability refresh honouring `ignoreGlobs`.
 *
 * The bug: `buildDefaultMaintainabilityScorer`'s **full-scope** branch walks
 * target dirs via `scanDirectory`, which drops `ignoreGlobs`-listed files. Its
 * **diff-scope** branch, however, built the source list from the changed
 * `files` filtered ONLY by `underTarget` (targetDirs membership) and never
 * applied `ignoreGlobs`. So a changed file that is under a targetDir AND
 * matches an ignore glob (e.g. `src/config-settings-schema.js`, ignored via
 * `config-settings-schema*.js`) got scored, its row merged into `rows`, and —
 * because the writer computes the `rollup["*"]` min/p50/p95 from those rows —
 * it dragged `rollup["*"].min` below the configured maintainability floor. A
 * `--full-scope` refresh correctly excluded it.
 *
 * This test drives the REAL default maintainability scorer (no injected
 * `scorer`) through a genuinely diff-scoped `refreshBaseline` call (an injected
 * `gitDiff` seam returns the changed file list, so `scope.mode === 'diff'`),
 * over a hermetic tmp project whose quality config ignores one of two changed,
 * under-target files. It asserts the ignored file appears in NEITHER
 * `envelope.rows` NOR the `rollup["*"].min`. It FAILS against the pre-fix code
 * (the ignored, lower-MI file leaks into the rows and becomes the min) and
 * PASSES once the diff-scope path applies the same ignore matcher the
 * full-scope walk uses.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { refreshBaseline } from '../../.agents/scripts/lib/baselines/refresh-service.js';

// The default maintainability scorer's `calculateAll` keys MI scores by
// `path.relative(process.cwd(), abs)`. For those keys to resolve to clean
// `src/...` repo-relative paths (no forbidden `..` segments) the fixture
// project MUST live *under* `process.cwd()`. We therefore materialise it under
// the worktree's gitignored `temp/` dir and pass `cwd: projectDir` — keeping
// the test hermetic without a global `process.chdir`.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const TEMP_ROOT = path.join(REPO_ROOT, 'temp');

const FIXED = '2026-06-15T00:00:00Z';

// A small, clean function — high maintainability index (~160).
const KEPT_SOURCE = 'export function add(a, b) {\n  return a + b;\n}\n';

// A tangled function with many decision points — a deliberately *lower*
// maintainability index (~93) than KEPT_SOURCE. If this (ignored) file leaks
// into the rows it becomes the rollup min, which is the regression signal.
const IGNORED_SOURCE = `export function tangled(x) {
  let total = 0;
  for (let i = 0; i < x; i += 1) {
    if (i % 2 === 0) { total += i; } else if (i % 3 === 0) { total -= i; }
    else if (i % 5 === 0) { total *= 2; } else { total += 1; }
    while (total > 100) { total -= 7; if (total < 0) { break; } }
    switch (i % 4) {
      case 0: total += 1; break;
      case 1: total += 2; break;
      case 2: total += 3; break;
      default: total += 4;
    }
  }
  return total > 50 ? total : (total < 0 ? -total : 0);
}
`;

describe('refreshBaseline — diff-scope maintainability honours ignoreGlobs', () => {
  let projectDir;
  let writePath;

  // Both files are under the `src` targetDir; `config-settings-schema.js` is
  // excluded by the `config-settings-schema*.js` ignore glob.
  const KEPT_REL = 'src/kept.js';
  const IGNORED_REL = 'src/config-settings-schema.js';

  beforeEach(() => {
    mkdirSync(TEMP_ROOT, { recursive: true });
    projectDir = mkdtempSync(path.join(TEMP_ROOT, 'mandrel-ignoreglobs-mi-'));
    mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    mkdirSync(path.join(projectDir, 'baselines'), { recursive: true });

    writeFileSync(path.join(projectDir, KEPT_REL), KEPT_SOURCE);
    writeFileSync(path.join(projectDir, IGNORED_REL), IGNORED_SOURCE);

    // Schema-valid .agentrc.json scoping maintainability to `src` and ignoring
    // the config-settings-schema file (mirrors the real repo's ignoreGlobs).
    writeFileSync(
      path.join(projectDir, '.agentrc.json'),
      JSON.stringify({
        project: {
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        github: { owner: 'o', repo: 'r', operatorHandle: '@x' },
        delivery: {
          quality: {
            gates: {
              maintainability: {
                floors: { '*': { min: 70 } },
                targetDirs: ['src'],
                ignoreGlobs: ['src/config-settings-schema*.js'],
              },
            },
          },
        },
      }),
    );

    writePath = path.join(projectDir, 'baselines', 'maintainability.json');
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('excludes an ignoreGlobs-listed changed file from rows AND rollup["*"].min', async () => {
    // Arrange — a genuinely diff-scoped refresh: scopeFiles=null + an injected
    // gitDiff that reports BOTH changed files. The kind predicate admits both
    // (.js), so the only thing that can keep the ignored file out is the
    // ignoreGlobs application under test.
    const gitDiff = async () => [KEPT_REL, IGNORED_REL];

    // Act — drive the REAL default maintainability scorer (no opts.scorer).
    const result = await refreshBaseline({
      kind: 'maintainability',
      scopeFiles: null,
      fullScope: false,
      writePath,
      cwd: projectDir,
      gitDiff,
      generatedAt: FIXED,
    });

    // Sanity: the scope was resolved as a diff (not explicit/full), so the
    // diff-scope branch under test is the one exercised.
    assert.equal(result.scope.mode, 'diff');

    // The default scorer keys MI rows by a path relative to `process.cwd()`,
    // so assert on the basename — robust to the cwd-relative prefix while
    // still uniquely identifying each fixture file.
    const basenames = result.envelope.rows.map((r) =>
      path.posix.basename(r.path),
    );

    // Sanity: the kept file WAS scored (otherwise the test proves nothing).
    assert.ok(
      basenames.includes('kept.js'),
      'fixture sanity: the non-ignored kept file must be scored',
    );

    // Contract 1 — the ignored file must NOT appear in the rows.
    assert.equal(
      basenames.includes('config-settings-schema.js'),
      false,
      `${IGNORED_REL} leaked into envelope.rows — diff-scope ignoreGlobs not applied`,
    );

    // Contract 2 — the ignored file must NOT drive the rollup min. Its MI
    // (~93) is well below the kept file's (~160); if it leaked, min would drop
    // to ~93. With the fix, min reflects only the kept file (~160).
    const min = result.envelope.rollup['*'].min;
    assert.ok(
      min > 100,
      `rollup["*"].min is ${min}; the ignored low-MI file poisoned the rollup min`,
    );
  });
});
