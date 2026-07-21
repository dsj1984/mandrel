/**
 * tests/observability/hot-path-terse-wiring.test.js — Story #4685.
 *
 * Per-script guard: every hot-path orchestration script an agent invokes on a
 * delivery turn routes its result dump through `emitTerseResult` (single-line
 * summary + detail-to-disk) rather than dumping pretty JSON straight to
 * stdout. A regression that reintroduces an inline
 * `--- … RESULT ---\n${JSON.stringify(x, null, 2)}` dump on the hot path fails
 * here, keeping the "terse by default" contract from silently rotting.
 */

import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/** Hot-path scripts that previously dumped a verbose result to stdout. */
const HOT_PATH_SCRIPTS = [
  '.agents/scripts/single-story-init.js',
  '.agents/scripts/single-story-confirm-merge.js',
  '.agents/scripts/sync-branch-from-base.js',
  '.agents/scripts/lib/orchestration/single-story-close/runner.js',
  '.agents/scripts/lib/orchestration/story-close/emit-blocked.js',
];

/** An inline pretty-printed result dump straight to a logger — the anti-pattern. */
const INLINE_DUMP =
  /--- [A-Z ]*RESULT ---[\s\S]*?JSON\.stringify\([^,]+,\s*null,\s*2\)/;

describe('hot-path scripts emit terse results by default', () => {
  for (const rel of HOT_PATH_SCRIPTS) {
    it(`${rel} routes its result dump through emitTerseResult`, () => {
      const src = nodeFs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      assert.ok(
        src.includes('emitTerseResult'),
        `${rel} must call emitTerseResult`,
      );
      assert.ok(
        !INLINE_DUMP.test(src),
        `${rel} must not dump a pretty result envelope inline to stdout`,
      );
    });
  }
});
