/**
 * update-maintainability-baseline.ignore-globs.test.js — Story #4293.
 *
 * Regression contract for the **CLI** maintainability-baseline path honouring
 * `ignoreGlobs` on the diff-scope branch.
 *
 * The bug: `update-maintainability-baseline.js` injected its own
 * `buildMaintainabilityScorer`, a stale copy of the canonical
 * `buildDefaultMaintainabilityScorer`. The injected copy's diff-scope branch
 * filtered changed files by `underTarget` only and never applied
 * `ignoreGlobs`, so an ignored-but-changed file under a target dir (e.g. a
 * consumer's `seed.mjs`, matched by an ignore glob) leaked into `rows` and
 * dragged `rollup["*"].min` below the maintainability floor — forcing a manual
 * baseline edit on every Epic that touched the file. The canonical default
 * scorer applies the ignore filter on both the full-scope walk and the
 * diff-scope branch.
 *
 * The fix (preferred): delete `buildMaintainabilityScorer` and let the CLI
 * route through `refreshBaseline`'s canonical default scorer, as
 * `update-crap-baseline.js` / `update-coverage-baseline.js` already do.
 *
 * This test guards that fix two ways:
 *   1. Statically — the CLI source no longer injects a bespoke scorer (no
 *      `buildMaintainabilityScorer`, no `scorer` key on the refresh opts), so
 *      the divergence cannot silently return.
 *   2. Behaviourally — driving `refreshBaseline` exactly the way the CLI now
 *      does (kind: 'maintainability', NO injected scorer, diff scope) excludes
 *      an `ignoreGlobs`-listed changed file from `envelope.rows` and from
 *      `rollup["*"].min`.
 */

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { refreshBaseline } from '../../.agents/scripts/lib/baselines/refresh-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'update-maintainability-baseline.js',
);
const TEMP_ROOT = path.join(REPO_ROOT, 'temp');

const FIXED = '2026-06-24T00:00:00Z';

// A small, clean function — high maintainability index (~160).
const KEPT_SOURCE = 'export function add(a, b) {\n  return a + b;\n}\n';

// A tangled function with many decision points — a deliberately *lower*
// maintainability index than KEPT_SOURCE. If this (ignored) file leaks into
// the rows it becomes the rollup min, which is the regression signal.
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

/**
 * Strip block (`/* … *\/`) and line (`// …`) comments so the static guards
 * below assert on executable code only — the fix's docstring legitimately
 * names `buildMaintainabilityScorer` and `scorer` while explaining the
 * removed divergence, and prose mentions must not satisfy (or fail) a code
 * guard.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('update-maintainability-baseline — CLI routes through the canonical scorer (Story #4293)', () => {
  const code = stripComments(readFileSync(CLI_PATH, 'utf8'));

  it('AC: CLI no longer injects a bespoke maintainability scorer', () => {
    assert.doesNotMatch(
      code,
      /buildMaintainabilityScorer/,
      'CLI code must not define/inject buildMaintainabilityScorer — route through the canonical default scorer',
    );
  });

  it('AC: CLI does not pass a `scorer` to refreshBaseline (uses the canonical default)', () => {
    // The only legitimate scorer for the maintainability CLI is now the
    // service-resolved canonical default. A `scorer:` key on the refresh opts
    // would re-introduce the divergence this Story removed.
    assert.doesNotMatch(
      code,
      /\bscorer\b\s*[:,]/,
      'CLI code must not inject a scorer — refreshBaseline resolves the canonical default',
    );
  });
});

describe('refreshBaseline (CLI invocation shape) — diff-scope honours ignoreGlobs', () => {
  let projectDir;
  let writePath;

  // Both files are under the `src` targetDir; the second is excluded by the
  // `seed*.mjs` ignore glob (the recurring consumer breach from #4293).
  const KEPT_REL = 'src/kept.js';
  const IGNORED_REL = 'src/seed.mjs';

  beforeEach(() => {
    mkdirSync(TEMP_ROOT, { recursive: true });
    projectDir = mkdtempSync(
      path.join(TEMP_ROOT, 'mandrel-cli-ignoreglobs-mi-'),
    );
    mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    mkdirSync(path.join(projectDir, 'baselines'), { recursive: true });

    writeFileSync(path.join(projectDir, KEPT_REL), KEPT_SOURCE);
    writeFileSync(path.join(projectDir, IGNORED_REL), IGNORED_SOURCE);

    // Schema-valid .agentrc.json scoping maintainability to `src` and ignoring
    // the seed file (mirrors the consumer config that produced the breach).
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
                ignoreGlobs: ['src/seed*.mjs'],
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
    // Arrange — drive refreshBaseline with the exact option shape the CLI now
    // produces in the no-flag (diff-scope) branch: kind + writePath + epsilon,
    // NO injected `scorer`. An injected `gitDiff` reports BOTH changed files so
    // the only thing that can keep the ignored file out is the canonical
    // scorer's ignoreGlobs application.
    const gitDiff = async () => [KEPT_REL, IGNORED_REL];

    // Act
    const result = await refreshBaseline({
      kind: 'maintainability',
      scopeFiles: null,
      fullScope: false,
      writePath,
      cwd: projectDir,
      gitDiff,
      generatedAt: FIXED,
    });

    // Sanity: the scope resolved as a diff, so the diff-scope branch ran.
    assert.equal(result.scope.mode, 'diff');

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
      basenames.includes('seed.mjs'),
      false,
      `${IGNORED_REL} leaked into envelope.rows — diff-scope ignoreGlobs not applied via the CLI's canonical scorer`,
    );

    // Contract 2 — the ignored file must NOT drive the rollup min. Its MI is
    // well below the kept file's; if it leaked, min would drop and breach the
    // floor (the seed.mjs min:70 breach).
    const min = result.envelope.rollup['*'].min;
    assert.ok(
      min > 100,
      `rollup["*"].min is ${min}; the ignored low-MI file poisoned the rollup min`,
    );
  });
});
