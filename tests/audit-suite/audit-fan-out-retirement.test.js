// tests/audit-suite/audit-fan-out-retirement.test.js
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const RETIRED_PATHS = [
  '.agents/workflows/audit-fan-out.md',
  '.claude/commands/audit-fan-out.md',
];

for (const rel of RETIRED_PATHS) {
  test(`audit-fan-out retirement: ${rel} must not exist`, () => {
    const abs = path.join(REPO_ROOT, rel);
    assert.equal(
      existsSync(abs),
      false,
      `${rel} was reintroduced. The /audit-fan-out workflow is retired; ` +
        `if you need parallel audit orchestration, propose a replacement ` +
        `surface rather than restoring this file.`,
    );
  });
}
