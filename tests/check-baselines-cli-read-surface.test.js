// tests/check-baselines-cli-read-surface.test.js
//
// Story #1912 / Task #1918 — read-surface migration invariant.
//
// The per-kind `check-*.js` CLIs MUST NOT contain direct
// `JSON.parse(readFileSync(<baseline>))` calls. Every baseline read
// flows through helper modules that delegate to `lib/baselines/reader.js`
// (Story #1892). This test pins the invariant against the four
// check-* CLIs covered by Task #1918:
//
//   - .agents/scripts/check-coverage-baseline.js
//   - .agents/scripts/check-crap.js
//   - .agents/scripts/check-maintainability.js
//   - .agents/scripts/check-mutation.js
//
// The literal acceptance criterion from the Task body is:
//
//   `grep -r "readFileSync.*baselines/" .agents/scripts/check-*.js`
//   returns zero hits.
//
// Per the operator-confirmed scope re-cut (2026-05-15) the CLIs
// themselves stay in place; regression/scope/friction logic is
// unchanged. Deletion ships in follow-up Epic #1943.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

const CLIS = [
  '.agents/scripts/check-coverage-baseline.js',
  '.agents/scripts/check-crap.js',
  '.agents/scripts/check-maintainability.js',
  '.agents/scripts/check-mutation.js',
];

function readCli(rel) {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('per-kind check-*.js CLI read surface — Task #1918 invariant', () => {
  for (const rel of CLIS) {
    it(`${rel} contains no direct readFileSync against a baseline path`, () => {
      const source = readCli(rel);
      // Match `readFileSync(...baselines/...)` regardless of quoting.
      const direct = /readFileSync\([^)]*baselines\//;
      assert.equal(
        direct.test(source),
        false,
        `${rel} must route baseline reads through helper modules (which delegate to lib/baselines/reader.js); direct readFileSync of a baselines/ path was found`,
      );
    });
  }
});
