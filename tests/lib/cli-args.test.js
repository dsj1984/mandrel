import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseSprintArgs,
  parseStoryCwdArgv,
} from '../../.agents/scripts/lib/cli-args.js';
import { parseWorkerEffort } from '../../.agents/scripts/lib/orchestration/resume-effort.js';

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

describe('parseSprintArgs — --rerun-advisory (Story #5266)', () => {
  it('parses the allowance, preserving an explicit 0', () => {
    assert.equal(
      parseSprintArgs(argv('--story', '5266', '--rerun-advisory', '2'))
        .rerunAdvisory,
      2,
    );
    // Zero is meaningful here — "spend nothing" — so it must not be read as
    // an absent flag the way `--max-wait-seconds 0` (a typo) is.
    assert.equal(
      parseSprintArgs(argv('--story', '5266', '--rerun-advisory', '0'))
        .rerunAdvisory,
      0,
    );
  });

  it('is undefined when absent, so the config default (0) applies', () => {
    assert.equal(
      parseSprintArgs(argv('--story', '5266')).rerunAdvisory,
      undefined,
    );
  });

  it('degrades a junk or negative value to absent rather than guessing', () => {
    assert.equal(
      parseSprintArgs(argv('--rerun-advisory', 'abc')).rerunAdvisory,
      undefined,
    );
    assert.equal(
      parseSprintArgs(argv('--rerun-advisory=-1')).rerunAdvisory,
      undefined,
    );
  });
});

describe('parseSprintArgs — --worker-effort (Story #5608)', () => {
  it('carries the raw value through for the close runner to validate', () => {
    assert.equal(
      parseSprintArgs(argv('--story', '5608', '--worker-effort', 'high'))
        .workerEffort,
      'high',
    );
  });

  it('is undefined when absent — a fresh Story or an inline close', () => {
    assert.equal(
      parseSprintArgs(argv('--story', '5608')).workerEffort,
      undefined,
    );
  });

  it('never throws on a junk value: validation is best-effort', () => {
    const raw = parseSprintArgs(argv('--worker-effort', 'turbo')).workerEffort;
    assert.equal(raw, 'turbo');
    const { effort, warning } = parseWorkerEffort(raw);
    assert.equal(effort, null);
    assert.match(warning, /low\|medium\|high\|xhigh\|max/);
  });
});

describe('parseStoryCwdArgv — the worker-tail --story/--cwd argv', () => {
  const cases = [
    [['--story', '5480', '--cwd', '/w'], { storyId: 5480, cwd: '/w' }],
    [['--story=12'], { storyId: 12, cwd: null }],
    [['--story', 'x'], { storyId: null, cwd: null }],
    [['--story', '0'], { storyId: null, cwd: null }],
    [['--story'], { storyId: null, cwd: null }],
    [[], { storyId: null, cwd: null }],
  ];
  for (const [args, expected] of cases) {
    it(`parses ${JSON.stringify(args)}`, () => {
      assert.deepEqual(parseStoryCwdArgv(args), expected);
    });
  }
});
