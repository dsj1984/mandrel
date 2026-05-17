/**
 * update-maintainability-baseline.test.js — Story #2202 / Task #2215.
 *
 * Acceptance (parent Story):
 *   - The manual CLI delegates to `refreshBaseline({ kind:
 *     'maintainability' })`. Verified statically by parsing the CLI's
 *     source for the import + call site, and dynamically by running the
 *     CLI end-to-end against a tmpdir fixture and asserting the on-disk
 *     envelope (kind, schema, rollup shape) matches what `refreshBaseline`
 *     produces.
 *   - The legacy `--diff-scope <ref>` flag is still parsed and surfaces in
 *     the service invocation (`baseRef`).
 *   - The new `--full-scope` flag is parsed and surfaces as
 *     `fullScope: true`. Task #2214 flips the *default* to diff-scope; this
 *     test only proves the wiring is in place.
 *   - The CLI body contains no direct calls to kind-specific scoring
 *     helpers (`scanDirectory` / `calculateAll` are invoked inside the
 *     injected scorer, never re-implemented inline).
 *
 * The CLI source is a thin wrapper, so the contract is verified at the
 * **CLI source level** rather than by running the executable: the
 * end-to-end behavioural test for the CLI lives in
 * `tests/baselines/refresh-entry-points-migration.test.js` (smoke) and
 * `tests/baselines/maintainability-cli-byte-identity.test.js`
 * (byte-identity vs story-close, Task #2212).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'update-maintainability-baseline.js',
);

describe('update-maintainability-baseline — refreshBaseline wrapper', () => {
  const source = readFileSync(CLI_PATH, 'utf8');

  it('AC: imports refreshBaseline from lib/baselines/refresh-service.js', () => {
    // Allow any quote style + any relative path so future moves don't
    // unnecessarily fail this guard; pin the path tail + symbol name.
    assert.match(
      source,
      /import\s*\{[^}]*\brefreshBaseline\b[^}]*\}\s*from\s*['"][^'"]*lib\/baselines\/refresh-service\.js['"]/,
      'CLI must import refreshBaseline from lib/baselines/refresh-service.js',
    );
  });

  it('AC: invokes refreshBaseline() (the delegation site exists)', () => {
    assert.match(
      source,
      /\brefreshBaseline\s*\(/,
      'CLI must call refreshBaseline()',
    );
  });

  it('AC: dispatches the maintainability kind to the service', () => {
    assert.match(
      source,
      /kind:\s*['"]maintainability['"]/,
      "CLI must pass kind: 'maintainability' to the service",
    );
  });

  it('AC: parses --diff-scope via the shared CLI helper', () => {
    assert.match(
      source,
      /parseDiffScopeFlag/,
      'CLI must parse --diff-scope using the shared diff-scope-cli helper',
    );
  });

  it('AC: parses --full-scope', () => {
    assert.match(
      source,
      /--full-scope/,
      'CLI must recognise the --full-scope flag (added by Task #2215)',
    );
  });

  it('AC: passes fullScope through to refreshBaseline', () => {
    assert.match(
      source,
      /fullScope\s*[:=]\s*true/,
      'CLI must surface fullScope=true to refreshBaseline',
    );
  });

  it('AC: does NOT call kind-internal envelope writers directly', () => {
    // refresh-service is the only legitimate caller of writer.write /
    // writer.writeFile / saveBaseline / regenerateMainFromTree. The
    // refactored CLI must not reach for them.
    const forbidden = [
      /\bwrite\s*\(\s*\{\s*kind:/, // writer.write({ kind: ... })
      /\bwriteFile\s*\(/,
      /\bsaveBaseline\s*\(/,
      /\bregenerateMainFromTree\s*\(/,
      /\bbuildWriterScopeArgs\s*\(/, // legacy scope-args helper
    ];
    for (const pattern of forbidden) {
      assert.doesNotMatch(
        source,
        pattern,
        `CLI must not call ${pattern.source} directly — go through refreshBaseline()`,
      );
    }
  });
});
