/**
 * tests/scripts/cli-help-contract.test.js — `--help` must never do work.
 *
 * `runAsCli` (lib/cli-utils.js) short-circuits `--help` *before* invoking
 * `main`, but only when the caller supplies a `usage` block:
 *
 *     if (usage && respondToHelp(process.argv.slice(2), usage)) return;
 *
 * A script that omits `usage` therefore falls straight through to its work
 * path on `--help`. For `check-test-temp-hygiene.js` that surfaced as a
 * confusing hard failure — `--help` landed on the default `--assert` mode and
 * exited 1 with "snapshot missing" — which is what this file's first test
 * pins. The family matters more than the instance: several baseline CLIs
 * mutate `baselines/` when invoked with a mode flag, so "`--help` reaches the
 * work path" is a shape that is elsewhere destructive.
 *
 * The second test is the ratchet. It is deliberately **static** — executing
 * every entry point would run real scans — and it asserts the set of
 * `runAsCli` callers lacking a `usage` block equals a known list, so a new
 * script cannot silently join it and a fixed one forces the list to shrink.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, '.agents', 'scripts');
/** Contributor-only CLIs moved out of the payload (Story #5381). */
const CONTRIB_SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');

/**
 * Entry points that route through `runAsCli` but pass no `usage` block, so
 * `--help` executes their work path. Every entry is a known gap, not an
 * approval: shrink this list, never grow it. `check-test-temp-hygiene.js` was
 * removed from it by the change that added this file.
 */
const KNOWN_HELP_GAPS = new Set([
  'check-action-pinning.js',
  'check-context-budget.js',
  'check-schema-references.js',
  'check-workflow-cli-lint.js',
  'check-workflow-timeouts.js',
]);

/** Scripts that deliberately do not route through `runAsCli` at all. */
const CLI_OPT_OUT_MARKER = 'cli-opt-out';

function entryPoints() {
  return [SCRIPTS_DIR, CONTRIB_SCRIPTS_DIR]
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((f) => f.endsWith('.js'))
        .filter((f) => f.startsWith('check-') || f.startsWith('update-'))
        .map((f) => ({ file: f, abs: path.join(dir, f) })),
    )
    .sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * True when the file hands `runAsCli` a `usage` option. Scoped to the text
 * from the `runAsCli(` call onward so an unrelated `usage:` key elsewhere in
 * the module cannot vouch for the call site.
 */
function passesUsageToRunAsCli(source) {
  const call = source.indexOf('runAsCli(');
  if (call === -1) return null; // not a runAsCli entry point
  return /\busage\s*:/.test(source.slice(call));
}

describe('CLI --help contract', () => {
  it('check-test-temp-hygiene.js --help exits 0 and prints its invocation line', () => {
    const script = path.join(SCRIPTS_DIR, 'check-test-temp-hygiene.js');
    const run = spawnSync(process.execPath, [script, '--help'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });

    assert.equal(
      run.status,
      0,
      `--help exited ${run.status}; stderr: ${run.stderr}`,
    );
    assert.match(
      run.stdout,
      /^Usage: node \.agents\/scripts\/check-test-temp-hygiene\.js /m,
      'usage block did not print the invocation line',
    );
    // The regression: --help must not reach the default --assert path.
    const combined = `${run.stdout}${run.stderr}`;
    assert.doesNotMatch(
      combined,
      /snapshot missing|guard cannot attest/,
      '--help fell through to the assert work path',
    );
  });

  it('no new entry point omits its usage block', () => {
    const observed = new Set();
    for (const { file, abs } of entryPoints()) {
      const source = readFileSync(abs, 'utf8');
      if (source.includes(CLI_OPT_OUT_MARKER)) continue;
      const passesUsage = passesUsageToRunAsCli(source);
      if (passesUsage === false) observed.add(file);
    }

    const added = [...observed].filter((f) => !KNOWN_HELP_GAPS.has(f));
    assert.deepEqual(
      added,
      [],
      `these entry points run work on --help; give each a usage block (see .agents/scripts/audit-baselines.js): ${added.join(', ')}`,
    );

    const fixed = [...KNOWN_HELP_GAPS].filter((f) => !observed.has(f));
    assert.deepEqual(
      fixed,
      [],
      `these are fixed — remove them from KNOWN_HELP_GAPS: ${fixed.join(', ')}`,
    );
  });

  it('every write-capable baseline updater guards --help', () => {
    // The destructive half of the family: these mutate baselines/ when given
    // a mode flag, so a --help that reached main would be the costly case.
    for (const { file, abs } of entryPoints().filter(({ file: f }) =>
      f.startsWith('update-'),
    )) {
      const source = readFileSync(abs, 'utf8');
      const guarded = source.includes(CLI_OPT_OUT_MARKER)
        ? source.includes('respondToHelp')
        : passesUsageToRunAsCli(source);
      assert.equal(guarded, true, `${file} does not short-circuit --help`);
    }
  });
});
