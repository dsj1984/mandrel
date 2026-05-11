import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  coerceStoryId,
  parseChangedSinceArg,
  parseFullScopeArg,
  parseStoryIdArg,
  resolveChangedSinceRef,
} from '../.agents/scripts/check-maintainability.js';

/**
 * Flag-parity tests for `--changed-since` on check-maintainability.js.
 *
 * The MI gate shares the diff-scoped semantics with the CRAP gate (AC15);
 * the filtering path itself is exercised end-to-end via the CLI integration
 * test below so the filter + baseline-scope plumbing doesn't drift silently
 * between the two gates.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

describe('parseChangedSinceArg', () => {
  it('returns the explicit ref argument', () => {
    assert.equal(
      parseChangedSinceArg(['--changed-since', 'origin/main']),
      'origin/main',
    );
  });

  it('falls back to "main" when the flag appears without a ref', () => {
    assert.equal(parseChangedSinceArg(['--changed-since']), 'main');
  });

  it('does not consume the next flag as a ref', () => {
    assert.equal(
      parseChangedSinceArg(['--changed-since', '--story', '42']),
      'main',
    );
  });

  it('returns null when the flag is absent', () => {
    assert.equal(parseChangedSinceArg(['--story', '7']), null);
  });
});

describe('coerceStoryId', () => {
  it('returns positive integer values verbatim', () => {
    assert.equal(coerceStoryId('42'), 42);
    assert.equal(coerceStoryId(7), 7);
  });

  it('rejects non-positive, non-integer, and missing values', () => {
    assert.equal(coerceStoryId('0'), null);
    assert.equal(coerceStoryId('-1'), null);
    assert.equal(coerceStoryId('1.5'), null);
    assert.equal(coerceStoryId('abc'), null);
    assert.equal(coerceStoryId(undefined), null);
    assert.equal(coerceStoryId(null), null);
    assert.equal(coerceStoryId(''), null);
  });
});

describe('parseStoryIdArg', () => {
  it('reads --story <id> from argv', () => {
    assert.equal(parseStoryIdArg(['--story', '42'], {}), 42);
  });

  it('skips a malformed --story value and falls through to env', () => {
    assert.equal(
      parseStoryIdArg(['--story', 'NaN'], { FRICTION_STORY_ID: '7' }),
      7,
    );
  });

  it('--story without a following value falls back to env', () => {
    assert.equal(parseStoryIdArg(['--story'], { FRICTION_STORY_ID: '9' }), 9);
  });

  it('returns null when neither argv nor env yields a positive int', () => {
    assert.equal(parseStoryIdArg([], {}), null);
    assert.equal(
      parseStoryIdArg(['--story', '0'], { FRICTION_STORY_ID: '-1' }),
      null,
    );
  });

  it('argv wins over env when both are valid', () => {
    assert.equal(
      parseStoryIdArg(['--story', '11'], { FRICTION_STORY_ID: '99' }),
      11,
    );
  });
});

describe('parseFullScopeArg (Story #1394)', () => {
  it('returns true when --full-scope is present', () => {
    assert.equal(parseFullScopeArg(['--full-scope']), true);
    assert.equal(parseFullScopeArg(['--json', 'x', '--full-scope']), true);
  });

  it('returns false when --full-scope is absent', () => {
    assert.equal(parseFullScopeArg([]), false);
    assert.equal(parseFullScopeArg(['--changed-since', 'main']), false);
  });
});

describe('resolveChangedSinceRef precedence (Story #1394, AC15 parity)', () => {
  it('framework default → diff-scope against main', () => {
    const r = resolveChangedSinceRef({ argv: [], env: {} });
    assert.equal(r.ref, 'main');
    assert.equal(r.scope, 'diff');
    assert.equal(r.source, 'default');
  });

  it('config.diffRef overrides framework default', () => {
    const r = resolveChangedSinceRef({
      argv: [],
      env: {},
      maintainabilityConfig: { defaultScope: 'diff', diffRef: 'develop' },
    });
    assert.equal(r.ref, 'develop');
    assert.equal(r.scope, 'diff');
    assert.equal(r.source, 'config.diffRef');
  });

  it('config.defaultScope=full produces a full-scope verdict', () => {
    const r = resolveChangedSinceRef({
      argv: [],
      env: {},
      maintainabilityConfig: { defaultScope: 'full' },
    });
    assert.equal(r.ref, null);
    assert.equal(r.scope, 'full');
  });

  it('env MAINTAINABILITY_CHANGED_SINCE wins over config', () => {
    const r = resolveChangedSinceRef({
      argv: [],
      env: { MAINTAINABILITY_CHANGED_SINCE: 'origin/release' },
      maintainabilityConfig: { defaultScope: 'diff', diffRef: 'develop' },
    });
    assert.equal(r.ref, 'origin/release');
    assert.equal(r.source, 'MAINTAINABILITY_CHANGED_SINCE');
  });

  it('CLI --changed-since wins over env + config', () => {
    const r = resolveChangedSinceRef({
      argv: ['--changed-since', 'feature/x'],
      env: { MAINTAINABILITY_CHANGED_SINCE: 'origin/release' },
      maintainabilityConfig: { defaultScope: 'diff', diffRef: 'develop' },
    });
    assert.equal(r.ref, 'feature/x');
    assert.equal(r.source, '--changed-since');
  });

  it('CLI --full-scope wins over every layer below', () => {
    const r = resolveChangedSinceRef({
      argv: ['--full-scope', '--changed-since', 'feature/x'],
      env: { MAINTAINABILITY_CHANGED_SINCE: 'origin/release' },
      maintainabilityConfig: { defaultScope: 'diff', diffRef: 'develop' },
    });
    assert.equal(r.ref, null);
    assert.equal(r.scope, 'full');
    assert.equal(r.source, '--full-scope');
  });

  it('CRAP_CHANGED_SINCE serves as a fallback env name for parity', () => {
    const r = resolveChangedSinceRef({
      argv: [],
      env: { CRAP_CHANGED_SINCE: 'origin/main' },
    });
    assert.equal(r.ref, 'origin/main');
    assert.equal(r.source, 'CRAP_CHANGED_SINCE');
  });
});

describe('check-maintainability CLI — bad --changed-since ref (AC14 parity)', () => {
  it('exits non-zero with a clear "unable to resolve" message', () => {
    const badRef = 'refs/heads/__never_exists_mi_changed_since_test_b18742__';
    const script = path.join(
      REPO_ROOT,
      '.agents',
      'scripts',
      'check-maintainability.js',
    );
    const result = spawnSync(
      process.execPath,
      [script, '--changed-since', badRef],
      { cwd: REPO_ROOT, encoding: 'utf-8' },
    );

    assert.notEqual(
      result.status,
      0,
      `CLI must exit non-zero on bad --changed-since ref (status=${result.status}, stderr=${result.stderr})`,
    );
    const combined = `${result.stderr}\n${result.stdout}`;
    assert.match(combined, /unable to resolve ref/i);
    assert.match(
      combined,
      new RegExp(badRef.replace(/[$^*()+?.|[\]{}\\]/g, '\\$&')),
    );
  });
});
