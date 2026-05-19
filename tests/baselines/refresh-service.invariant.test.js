/**
 * refresh-service.invariant.test.js — guard against direct kind-internal
 * baseline writes that bypass refreshBaseline() (Story #2197, Task #2208).
 *
 * Acceptance (AC-1, Epic #2173):
 *   - "No code path constructs or regenerates a maintainability baseline
 *     file without going through refreshBaseline()."
 *
 * This test is the static-analysis half of AC-1. It scans `.agents/scripts/`
 * for direct invocations of the legacy kind-specific writers / regenerators
 * that the Unified Baseline Refresh Service is contracted to replace, and
 * fails when any new caller appears outside the refresh-service module
 * itself.
 *
 * **Migration allowlist.** Story #2197 lands the service module + tests
 * only — Stories 3/4/5 of Epic #2173 migrate the existing call sites
 * (`auto-refresh-runner`, `epic-deliver-finalize`, manual update CLIs).
 * Until those migrations land, the legacy call sites must keep working,
 * so they are explicitly allowlisted below by file path. Each entry MUST
 * be removed when its migration ticket merges; if you delete a caller
 * from the allowlist without removing its forbidden call, this test fails.
 *
 * **Synthetic-call self-test.** The same scanner is exercised at the end
 * of this file against a synthetic source string that contains a
 * forbidden call. The scanner must detect it. This is what makes the
 * guard robust against drift: if someone replaces the production scanner
 * with a no-op the self-test still fires.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Forbidden-call patterns. Each entry is a regex that matches a known
// pre-service direct call to a kind-internal writer or regenerator. The
// scanner reports every line that matches any of these patterns and is
// not in an allowlisted file.
// ---------------------------------------------------------------------------
const FORBIDDEN_PATTERNS = Object.freeze([
  // Coverage / lint / mutation legacy savers — wrappers around
  // fs.writeFileSync that produce baseline JSON. Stories 3/4/5 migrate
  // these to refreshBaseline().
  /\bwriteBaseline\s*\(/,
  /\bsaveBaseline\s*\(/,

  // Maintainability / finalize: regenerate the whole MI baseline from
  // the working tree without diff-scope. The single load-bearing pattern
  // the Epic body calls out by name.
  /\bregenerateMainFromTree\s*\(/,

  // Kind-internal floor enforcers. The Epic body mentions
  // `enforce*Floor`; we match the singular and plural forms to be
  // forgiving of future naming variants.
  /\benforce[A-Z][A-Za-z]*Floor\s*\(/,
]);

// ---------------------------------------------------------------------------
// Migration allowlist. Files known to currently call one of the forbidden
// patterns because Stories 3/4/5 have not yet migrated them. Paths are
// POSIX-relative to REPO_ROOT. Each entry MUST link to the migration
// ticket that removes it.
// ---------------------------------------------------------------------------
const MIGRATION_ALLOWLIST = Object.freeze(
  new Set([
    // Story #2198 (manual update CLIs → refreshBaseline)
    // Note: update-maintainability-baseline.js was migrated by Story #2202
    // (Task #2215) and is intentionally absent from this list — the refresh-
    // service invariant must catch any regression that reintroduces a direct
    // kind-internal write to that CLI.
    '.agents/scripts/update-coverage-baseline.js',
    '.agents/scripts/update-crap-baseline.js',
    '.agents/scripts/update-mutation-baseline.js',
    '.agents/scripts/lint-baseline.js',
    '.agents/scripts/lib/coverage-baseline.js',
    '.agents/scripts/lib/mutation/baseline-snapshot.js',
    '.agents/scripts/lib/maintainability-utils.js',
    '.agents/scripts/lib/baseline-snapshot.js',
    '.agents/scripts/lib/gates/baseline-store.js',

    // Story #2199 (story-close auto-refresh → refreshBaseline)
    '.agents/scripts/lib/orchestration/story-close/auto-refresh-runner.js',

    // Story #2204 (finalize → refreshBaseline) — MIGRATED. Removed from
    // allowlist; finalize now routes through refreshBaseline() and no
    // longer calls regenerateMainFromTree directly.
  ]),
);

// ---------------------------------------------------------------------------
// The service module itself is the only legitimate home for direct calls
// to the writer / canonicalise / etc. machinery. It is explicitly exempt
// from the scan.
// ---------------------------------------------------------------------------
const SERVICE_MODULE = '.agents/scripts/lib/baselines/refresh-service.js';

// ---------------------------------------------------------------------------
// Directories the scanner walks. Scoped to source roots only — tests are
// not in scope because tests legitimately import the helpers they cover.
// Story #2572 relocated `lib/baselines/` under `.agents/scripts/`, so the
// distributed bundle is the only source root the scanner needs to walk.
// ---------------------------------------------------------------------------
const SCAN_ROOTS = Object.freeze(['.agents/scripts']);

// Files / directories the scanner skips while walking.
const SKIP_DIR_NAMES = Object.freeze(
  new Set(['node_modules', '.git', '.worktrees', 'temp', 'tests', 'fixtures']),
);

/**
 * Walk `dir` recursively and return absolute paths to every `.js` file.
 * Skips known-noise directories so the scanner doesn't traverse
 * `node_modules` or nested worktrees.
 */
function listJsFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (SKIP_DIR_NAMES.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...listJsFiles(abs));
    } else if (ent.isFile() && abs.endsWith('.js')) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Scan `source` for any FORBIDDEN_PATTERNS hit. Returns the list of
 * matching lines (line numbers + match text). Pure: takes a string, no
 * I/O. This is the seam the synthetic self-test calls.
 *
 * @param {string} source
 * @returns {Array<{line: number, text: string, pattern: string}>}
 */
export function scanForForbidden(source) {
  if (typeof source !== 'string') return [];
  const hits = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    // Skip comment-only lines so a doc-comment mentioning the forbidden
    // name doesn't flag.
    const trimmed = text.trimStart();
    if (
      trimmed.startsWith('//') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*')
    ) {
      continue;
    }
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(text)) {
        hits.push({ line: i + 1, text: text.trim(), pattern: pattern.source });
        break;
      }
    }
  }
  return hits;
}

/**
 * Convert an absolute path to a POSIX-relative path against REPO_ROOT.
 */
function relPosix(abs) {
  return path.relative(REPO_ROOT, abs).replace(/\\/g, '/');
}

describe('refresh-service invariant (Task #2208)', () => {
  it('AC: scanForForbidden detects a synthetic direct call', () => {
    const synthetic = [
      '// File-level comment',
      "import { x } from 'y';",
      'function naughty() {',
      '  return writeBaseline(workDir, baseline);',
      '}',
    ].join('\n');
    const hits = scanForForbidden(synthetic);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 4);
    assert.match(hits[0].text, /writeBaseline\(/);
  });

  it('AC: scanForForbidden detects regenerateMainFromTree calls', () => {
    const hits = scanForForbidden('  await regenerateMainFromTree(opts);');
    assert.equal(hits.length, 1);
    assert.match(hits[0].text, /regenerateMainFromTree/);
  });

  it('AC: scanForForbidden detects kind-specific enforce*Floor calls', () => {
    const hits = scanForForbidden('  enforceMiFloor(rows);');
    assert.equal(hits.length, 1);
    assert.match(hits[0].text, /enforceMiFloor/);
  });

  it('AC: scanForForbidden ignores comment-only mentions', () => {
    const synthetic = [
      '// In Story #2199 we remove writeBaseline(...) entirely',
      ' * Once writeBaseline() is gone, this comment can be cleaned up.',
      '/* writeBaseline(legacy) */',
    ].join('\n');
    assert.deepEqual(scanForForbidden(synthetic), []);
  });

  it('AC: scanForForbidden returns [] on non-string input', () => {
    assert.deepEqual(scanForForbidden(null), []);
    assert.deepEqual(scanForForbidden(undefined), []);
    assert.deepEqual(scanForForbidden(42), []);
  });
});

describe('refresh-service invariant — repository scan', () => {
  it('AC: only allowlisted (pre-migration) files carry forbidden calls', () => {
    const offenders = [];

    for (const root of SCAN_ROOTS) {
      const rootAbs = path.join(REPO_ROOT, root);
      try {
        if (!statSync(rootAbs).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const abs of listJsFiles(rootAbs)) {
        const rel = relPosix(abs);
        if (rel === SERVICE_MODULE) continue; // service is the canonical home
        const source = readFileSync(abs, 'utf8');
        const hits = scanForForbidden(source);
        if (hits.length === 0) continue;
        if (MIGRATION_ALLOWLIST.has(rel)) continue;
        offenders.push({ file: rel, hits });
      }
    }

    if (offenders.length > 0) {
      const summary = offenders
        .map(
          ({ file, hits }) =>
            `\n  ${file}:\n${hits
              .map((h) => `    line ${h.line}: ${h.text}`)
              .join('\n')}`,
        )
        .join('');
      assert.fail(
        `Found ${offenders.length} non-allowlisted file(s) with forbidden direct kind calls (AC-1). ` +
          `Route the call through refreshBaseline() from .agents/scripts/lib/baselines/refresh-service.js, or ` +
          `(if you're migrating a known site) update MIGRATION_ALLOWLIST in this test file.${summary}`,
      );
    }
  });

  it('refresh-service module is exempt from the scan', () => {
    // Sanity check: the service module is the canonical home for the
    // patterns it routes through (once Stories 3/4/5 migrate). Today
    // it does not call any of the forbidden patterns directly, but
    // adding one tomorrow MUST NOT trip the guard. Explicitly verified
    // by attempting to read + skip it.
    const serviceAbs = path.join(REPO_ROOT, SERVICE_MODULE);
    const source = readFileSync(serviceAbs, 'utf8');
    // The scanner may or may not hit on the service today; the contract
    // is that the *repository scan* treats this file as exempt. We
    // simply assert the file exists and is readable as the seam.
    assert.equal(typeof source, 'string');
    assert.ok(source.length > 0);
  });

  it('migration allowlist is non-empty and references the expected pre-migration sites', () => {
    // Defensive: catches the case where a future refactor empties the
    // allowlist without removing the underlying call sites — that would
    // cause the repo-scan to silently start failing only at merge time
    // on someone else's PR. By asserting the allowlist shape here, the
    // test fails immediately when the allowlist is touched without
    // reading this preamble.
    assert.ok(MIGRATION_ALLOWLIST.size > 0);
    assert.ok(
      MIGRATION_ALLOWLIST.has(
        '.agents/scripts/lib/orchestration/story-close/auto-refresh-runner.js',
      ),
      'Story #2199 (auto-refresh migration) allowlist entry must be present until that Story merges',
    );
    // Story #2204 (finalize migration) — MIGRATED. epic-deliver-finalize.js
    // no longer carries any forbidden direct calls. The repo-scan above is
    // the load-bearing guard now: any regression that re-introduces
    // regenerateMainFromTree() in finalize will fail without an explicit
    // allowlist re-add.
    assert.ok(
      !MIGRATION_ALLOWLIST.has('.agents/scripts/epic-deliver-finalize.js'),
      'Story #2204 has migrated finalize; the allowlist entry MUST be removed',
    );
  });
});
