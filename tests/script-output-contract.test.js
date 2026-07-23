/**
 * tests/script-output-contract.test.js — orchestration script-output contract
 * (Story #4708, AC-5).
 *
 * A script's default success-path stdout rides resident in the invoking
 * agent's transcript, so fat payloads are a per-turn tax. The contract
 * (documented in `.agents/rules/orchestration-error-handling.md`) is:
 * compact digest + on-disk artifact path, single-line JSON for
 * machine-parsed envelopes, ≤ ~2KB on the default success path.
 *
 * This test guards the two statically-checkable halves: the contract stays
 * documented, and no top-level orchestration CLI reintroduces an
 * unconditional pretty-printed stdout dump (the `null, 2` bytes are pure
 * resident-context waste for a `JSON.parse`ing driver).
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, '.agents', 'scripts');
const RULE_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'rules',
  'orchestration-error-handling.md',
);

describe('script-output contract (Story #4708, AC-5)', () => {
  it('the output contract is documented in the orchestration rule', () => {
    const rule = readFileSync(RULE_PATH, 'utf8');
    assert.ok(
      rule.includes('## Output Contract'),
      'orchestration-error-handling.md lost its "## Output Contract" section',
    );
    for (const clause of ['~2KB', 'digest', 'artifact', 'emitTerseResult']) {
      assert.ok(
        rule.includes(clause),
        `the output-contract section no longer mentions "${clause}"`,
      );
    }
  });

  it('no top-level orchestration CLI pretty-prints an unconditional stdout dump', () => {
    const offenders = [];
    for (const name of readdirSync(SCRIPTS_DIR)) {
      if (!name.endsWith('.js')) continue;
      const source = readFileSync(path.join(SCRIPTS_DIR, name), 'utf8');
      for (const line of source.split('\n')) {
        if (
          !/process\.stdout\.write\(.*JSON\.stringify\([^)]*null,\s*2/.test(
            line,
          )
        ) {
          continue;
        }
        // A pretty-print behind an explicit opt-in flag is sanctioned.
        if (/pretty/i.test(line)) continue;
        offenders.push(`${name}: ${line.trim()}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'unconditional pretty-printed stdout dumps violate the script-output ' +
        `contract (emit single-line JSON, or gate behind --pretty):\n${offenders.join('\n')}`,
    );
  });
});
