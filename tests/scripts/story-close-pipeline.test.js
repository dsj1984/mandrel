/**
 * tests/scripts/story-close-pipeline.test.js — Task #2489 (Story #2460,
 * Epic #2453 — CLI thinning pilot).
 *
 * Pins the **byte-identical CLI surface** of story-close.js after the
 * phase extraction. The pre-refactor fixtures in
 * `tests/scripts/fixtures/story-close-pipeline/` capture two stable
 * surfaces operators and downstream tools depend on:
 *
 *   1. `no-args-stderr.txt` — the first line of stderr (post-prefix
 *      normalisation) when the script is invoked with no arguments,
 *      plus the exit code (`1`). Any change here would silently break
 *      every wave aggregator that scans for the `Usage:` token.
 *   2. `exports.json` — the named exports the script re-exports from
 *      its phase modules. The phase pipeline is allowed to relocate
 *      *implementations*, but cannot rename or drop a *public name*
 *      without churning every importer (Story #1124 / #2138 / #2241).
 *
 * Together these pin: same exit code, same operator-visible message,
 * same set of exported names. A future refactor that drops, renames,
 * or reorders any of the three fails this test fast.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, '.agents', 'scripts', 'story-close.js');
const FIX_DIR = path.join(__dirname, 'fixtures', 'story-close-pipeline');

/**
 * Strip the absolute-path stack frames + the trailing `at ...` lines from
 * stderr so the fixture is portable across worktrees and CI machines.
 * Keeps only the leading `[phase=fatal] [story-close] Error: ...` line,
 * which is the stable user-facing contract.
 */
function normaliseStderr(stderr) {
  const lines = stderr.split(/\r?\n/);
  // Keep only the first non-empty line — it carries the `[phase=fatal]`
  // marker + the canonical `Usage: …` text. Stack frames vary by
  // checkout path.
  for (const line of lines) {
    if (line.trim().length > 0) return `${line}\n`;
  }
  return '';
}

describe('story-close.js CLI pipeline — byte-identical surface (Task #2489)', () => {
  it('exit code + first stderr line are byte-identical to the fixture on a no-args invocation', () => {
    const expected = fs.readFileSync(
      path.join(FIX_DIR, 'no-args-stderr.txt'),
      'utf8',
    );
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, 'no-args invocation must exit 1');
    const normalised = normaliseStderr(result.stderr);
    assert.equal(normalised, expected);
  });

  it('exported names are byte-identical to exports.json (no rename / drop / accidental add)', async () => {
    const expected = JSON.parse(
      fs.readFileSync(path.join(FIX_DIR, 'exports.json'), 'utf8'),
    );
    const mod = await import(`file://${SCRIPT.replace(/\\/g, '/')}`);
    // `default` is sometimes injected by the loader — strip it before
    // diffing so the fixture pins only intentional re-exports.
    const actual = Object.keys(mod)
      .filter((k) => k !== 'default')
      .sort();
    assert.deepEqual(actual, expected.exports);
  });
});
