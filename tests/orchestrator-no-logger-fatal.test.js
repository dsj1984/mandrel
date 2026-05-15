import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ORCHESTRATORS_DIR = path.join(ROOT, '.agents', 'scripts');

/**
 * Regression test for the orchestration-error-handling rule
 * (`.agents/rules/orchestration-error-handling.md`).
 *
 * The rule says: orchestrator entry points under `.agents/scripts/*.js` MUST
 * surface unrecoverable failures with `throw new Error(...)` rather than
 * `Logger.fatal(...)`. The `runAsCli` boundary maps the throw to
 * `process.exit(1)` and preserves the message verbatim, while staying robust
 * under a mocked or stubbed `process.exit` (in tests). `Logger.fatal` calls
 * fall through silently when `process.exit` is stubbed, masking failures.
 *
 * This test walks the top-level entries of `.agents/scripts/` (excluding the
 * `lib/` subtree, where helper modules are explicitly allowed to keep using
 * `Logger.fatal` per the rule's "Where it applies" scope) and asserts that
 * no orchestrator file contains a `Logger.fatal(` callsite. If a future
 * orchestrator regresses, this test fails CI with the offending file paths.
 */

/**
 * Strip JavaScript line + block comments so a `Logger.fatal` mention inside a
 * JSDoc comment is not flagged as a real callsite. We only care about code
 * that would execute at runtime.
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  // Remove block comments first (greedy across newlines), then line comments.
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlock.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function listOrchestratorEntryPoints() {
  return fs
    .readdirSync(ORCHESTRATORS_DIR, { withFileTypes: true })
    .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.js'))
    .map((dirent) => path.join(ORCHESTRATORS_DIR, dirent.name));
}

describe('Orchestrator entry points: no Logger.fatal callsites', () => {
  const entryPoints = listOrchestratorEntryPoints();

  it('finds at least one orchestrator entry point to scan', () => {
    assert.ok(
      entryPoints.length > 0,
      `expected at least one .js file under ${ORCHESTRATORS_DIR}`,
    );
  });

  it('every top-level orchestrator file contains zero Logger.fatal callsites', () => {
    const offenders = [];
    for (const file of entryPoints) {
      const src = fs.readFileSync(file, 'utf8');
      const code = stripComments(src);
      if (/\bLogger\.fatal\s*\(/.test(code)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Orchestrator(s) regressed to Logger.fatal — replace with \`throw new Error(...)\` per .agents/rules/orchestration-error-handling.md:\n  ${offenders.join('\n  ')}`,
    );
  });
});
