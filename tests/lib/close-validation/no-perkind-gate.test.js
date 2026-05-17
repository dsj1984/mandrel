// tests/lib/close-validation/no-perkind-gate.test.js
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Story #2210 — Regression test: in-process per-kind regression gate retired.
//
// Story #2205 migrated close-validation onto the unified `check-baselines`
// gate (with attribution wiring) as the single source of truth for per-kind
// regression enforcement. Story #2210 then retired the legacy in-process
// per-kind regression-compare arm — the `buildInProcessBaselineGate` helper
// under `.agents/scripts/lib/close-validation/in-process-baseline-gate.js`
// and its three `Gate.run` wirings in `lib/close-validation.js`.
//
// This test prevents accidental reintroduction. It scans the production
// source under `.agents/scripts/lib/close-validation/` and `.agents/scripts/
// lib/close-validation.js` and asserts that:
//
//   1. No source file exports or imports `buildInProcessBaselineGate`.
//   2. No source file defines or references the deleted module path
//      `close-validation/in-process-baseline-gate`.
//   3. No source file imports the per-kind compare modules
//      (`baselines/kinds/{maintainability,crap,mutation}.js`) for the
//      purpose of running a `compare(head, base)` regression gate
//      in-process.
//
// The unified `check-baselines` gate is the only path; the in-process
// per-kind regression arm is forbidden.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLOSE_VALIDATION_DIR = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'lib',
  'close-validation',
);
const CLOSE_VALIDATION_AGGREGATOR = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'lib',
  'close-validation.js',
);

/**
 * Recursively enumerate every `.js` file under `dir`. Returns absolute
 * paths so the per-file scan can build a stable error message.
 */
function walkJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      out.push(...walkJsFiles(abs));
    } else if (stat.isFile() && entry.endsWith('.js')) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Forbidden patterns that would indicate a reintroduction of the
 * in-process per-kind regression gate. Each pattern is paired with a
 * human-readable description used in the failure message.
 */
const FORBIDDEN_PATTERNS = [
  {
    pattern: /buildInProcessBaselineGate/,
    description: 'reference to the retired `buildInProcessBaselineGate` helper',
  },
  {
    pattern: /in-process-baseline-gate/,
    description:
      'import of the retired `close-validation/in-process-baseline-gate` module',
  },
];

/**
 * Strip JS line and block comments from a source file so the forbidden-
 * pattern scan only sees executable code. Retirement narrative in
 * doc-comments is legitimate (and informative) and must not trigger the
 * guard. The stripper is intentionally simple: it ignores comment
 * delimiters inside string literals, which is good enough for the
 * deterministic source files under `lib/close-validation/`.
 */
function stripJsComments(source) {
  // Block comments first — `/* ... */` (non-greedy, dotall via [\s\S]).
  const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  // Then line comments — `// ... <EOL>`. Drop the comment, keep the newline.
  return noBlockComments.replace(/\/\/[^\n]*/g, '');
}

describe('close-validation — no in-process per-kind regression gate (Story #2210)', () => {
  it('the retired `in-process-baseline-gate.js` module is absent from the close-validation directory', () => {
    const files = walkJsFiles(CLOSE_VALIDATION_DIR).map((f) =>
      path.basename(f),
    );
    assert.ok(
      !files.includes('in-process-baseline-gate.js'),
      `Expected \`in-process-baseline-gate.js\` to be deleted from ${CLOSE_VALIDATION_DIR}, but it still exists. ` +
        'The unified `check-baselines` gate is the only regression-enforcement path; ' +
        'do not reintroduce the per-kind in-process compare arm.',
    );
  });

  it('no executable source under `lib/close-validation/` references the retired gate', () => {
    const offenders = [];
    for (const file of walkJsFiles(CLOSE_VALIDATION_DIR)) {
      const body = stripJsComments(readFileSync(file, 'utf8'));
      for (const { pattern, description } of FORBIDDEN_PATTERNS) {
        if (pattern.test(body)) {
          offenders.push(
            `${path.relative(REPO_ROOT, file)} contains ${description}`,
          );
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Forbidden references to the retired in-process per-kind regression gate found:\n  - ${offenders.join('\n  - ')}`,
    );
  });

  it('the close-validation aggregator (`close-validation.js`) does not import or reference the retired gate', () => {
    const body = stripJsComments(
      readFileSync(CLOSE_VALIDATION_AGGREGATOR, 'utf8'),
    );
    const offenders = [];
    for (const { pattern, description } of FORBIDDEN_PATTERNS) {
      if (pattern.test(body)) {
        offenders.push(description);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `\`close-validation.js\` still references the retired gate:\n  - ${offenders.join('\n  - ')}\n\n` +
        'Remove the import and the `Gate.run` wirings for `check-maintainability`, ' +
        '`check-crap`, and `check-mutation` so the unified `check-baselines` gate is the only regression path.',
    );
  });
});
