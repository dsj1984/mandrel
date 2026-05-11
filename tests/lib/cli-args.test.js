import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSprintArgs } from '../../.agents/scripts/lib/cli-args.js';

/**
 * `parseSprintArgs` expects a full argv-shaped array (slot 0 = node, slot 1 =
 * script). Wrap each scenario's flag list with two leading placeholders so the
 * `args.slice(2)` inside `parseSprintArgs` lands on the real flags.
 */
function argv(...flags) {
  return ['node', 'script.js', ...flags];
}

describe('parseSprintArgs — --skip-validation', () => {
  it('returns skipValidation: true when --skip-validation is present', () => {
    const parsed = parseSprintArgs(argv('--story', '123', '--skip-validation'));
    assert.equal(parsed.storyId, 123);
    assert.equal(parsed.skipValidation, true);
  });

  it('returns skipValidation: true for --skip-validation=true', () => {
    const parsed = parseSprintArgs(
      argv('--story', '123', '--skip-validation=true'),
    );
    assert.equal(parsed.skipValidation, true);
  });

  it('returns skipValidation: false for --skip-validation=false', () => {
    const parsed = parseSprintArgs(
      argv('--story', '123', '--skip-validation=false'),
    );
    assert.equal(parsed.skipValidation, false);
  });

  it('returns skipValidation: false when the flag is absent (default)', () => {
    const parsed = parseSprintArgs(argv('--story', '123'));
    assert.equal(parsed.skipValidation, false);
  });

  it('does not perturb the rest of the parsed shape', () => {
    const parsed = parseSprintArgs(
      argv('--story', '42', '--epic', '7', '--skip-validation', '--dry-run'),
    );
    assert.equal(parsed.storyId, 42);
    assert.equal(parsed.epicId, 7);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.skipValidation, true);
    assert.equal(parsed.skipDashboard, false);
  });
});
