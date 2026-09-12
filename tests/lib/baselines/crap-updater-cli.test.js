/**
 * crap-updater-cli.test.js — the `update-crap-baseline` CLI's own logic
 * (Story #5316).
 *
 * All three subjects used to live inside `main`, unreachable from a test:
 * `parseCliArgs` scored CRAP 56, the inlined scorer 72, and `main` itself 90.
 *
 * The scorer's two fail-closed refusals are the reason this CLI keeps a
 * bespoke scorer instead of taking the service's default, so they are asserted
 * here rather than assumed.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildCrapUpdaterScorer,
  parseCrapUpdaterArgs,
  resolveCrapUpdaterOptions,
} from '../../../.agents/scripts/lib/baselines/crap-updater-cli.js';

/** A logger that records instead of printing. */
function recordingLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (s) => lines.info.push(s),
    warn: (s) => lines.warn.push(s),
    error: (s) => lines.error.push(s),
    all: () => [...lines.info, ...lines.warn, ...lines.error].join('\n'),
  };
}

/** The config slices `resolveCrapUpdaterOptions` reads. */
const CONFIG = {
  crap: {
    targetDirs: ['.agents/scripts'],
    ignoreGlobs: ['**/__tests__/**'],
    minMethodResolutionRate: 0.9,
  },
  baselines: { crap: { path: 'baselines/crap.json' } },
};

describe('parseCrapUpdaterArgs', () => {
  it('returns the unset shape for an empty argv', () => {
    assert.deepEqual(parseCrapUpdaterArgs([]), {
      baselinePath: undefined,
      coveragePath: undefined,
      fullScope: false,
      diffScopeRef: null,
    });
  });

  it('reads --baseline and --coverage values', () => {
    const args = parseCrapUpdaterArgs([
      '--baseline',
      'out/b.json',
      '--coverage',
      'out/c.json',
    ]);
    assert.equal(args.baselinePath, 'out/b.json');
    assert.equal(args.coveragePath, 'out/c.json');
  });

  it('ignores a value-taking flag with no value', () => {
    assert.equal(parseCrapUpdaterArgs(['--baseline']).baselinePath, undefined);
  });

  it('reads --full-scope and --diff-scope independently', () => {
    assert.equal(parseCrapUpdaterArgs(['--full-scope']).fullScope, true);
    assert.equal(
      parseCrapUpdaterArgs(['--diff-scope', 'origin/main']).diffScopeRef,
      'origin/main',
    );
  });

  it('does NOT reject the incompatible pair — that is the resolver’s job', () => {
    // Parsing must stay total; the refusal lives in one place so a caller
    // cannot get a half-validated shape.
    const args = parseCrapUpdaterArgs(['--full-scope', '--diff-scope', 'HEAD']);
    assert.equal(args.fullScope, true);
    assert.equal(args.diffScopeRef, 'HEAD');
  });
});

describe('resolveCrapUpdaterOptions — precedence', () => {
  it('a flag beats config, and config beats the built-in default', () => {
    const flagged = resolveCrapUpdaterOptions(
      { coveragePath: 'flag.json' },
      { crap: { coveragePath: 'config.json' }, baselines: CONFIG.baselines },
    );
    assert.equal(flagged.coveragePath, 'flag.json');

    const configured = resolveCrapUpdaterOptions(
      {},
      { crap: { coveragePath: 'config.json' }, baselines: CONFIG.baselines },
    );
    assert.equal(configured.coveragePath, 'config.json');

    const defaulted = resolveCrapUpdaterOptions({}, CONFIG);
    assert.equal(defaulted.coveragePath, 'coverage/coverage-final.json');
  });

  it('defaults the resolution floor to 0.75 and reads a configured one', () => {
    assert.equal(
      resolveCrapUpdaterOptions({}, { baselines: CONFIG.baselines })
        .minMethodResolutionRate,
      0.75,
    );
    assert.equal(
      resolveCrapUpdaterOptions({}, CONFIG).minMethodResolutionRate,
      0.9,
    );
  });

  it('requireCoverage is true unless config says exactly false', () => {
    const on = resolveCrapUpdaterOptions({}, CONFIG);
    assert.equal(on.requireCoverage, true);
    const off = resolveCrapUpdaterOptions(
      {},
      { crap: { requireCoverage: false }, baselines: CONFIG.baselines },
    );
    assert.equal(off.requireCoverage, false);
  });

  it('coerces non-array targetDirs / ignoreGlobs to empty arrays', () => {
    const o = resolveCrapUpdaterOptions(
      {},
      {
        crap: { targetDirs: 'nope', ignoreGlobs: null },
        baselines: CONFIG.baselines,
      },
    );
    assert.deepEqual(o.targetDirs, []);
    assert.deepEqual(o.ignoreGlobs, []);
  });
});

describe('resolveCrapUpdaterOptions — the baseline path', () => {
  it('resolves a relative path against the given cwd', () => {
    const o = resolveCrapUpdaterOptions({}, CONFIG, '/repo');
    // Built with `path`, not spelled as a POSIX literal: on Windows the
    // separator differs AND `path.resolve` prepends the current drive, so a
    // hardcoded '/repo/baselines/crap.json' is a platform-only failure.
    assert.equal(
      o.absBaselinePath,
      path.resolve('/repo', 'baselines/crap.json'),
    );
    // The assertion that carries the meaning: the GIVEN cwd was used, not
    // process.cwd().
    assert.notEqual(
      o.absBaselinePath,
      path.resolve(process.cwd(), 'baselines/crap.json'),
    );
  });

  it('leaves an absolute path alone', () => {
    const o = resolveCrapUpdaterOptions(
      { baselinePath: '/tmp/elsewhere.json' },
      CONFIG,
      '/repo',
    );
    assert.equal(o.absBaselinePath, '/tmp/elsewhere.json');
  });
});

describe('resolveCrapUpdaterOptions — incompatible scopes', () => {
  it('refuses --full-scope together with --diff-scope', () => {
    assert.throws(
      () =>
        resolveCrapUpdaterOptions(
          { fullScope: true, diffScopeRef: 'origin/main' },
          CONFIG,
        ),
      /--full-scope is incompatible with --diff-scope/,
    );
  });

  it('allows either alone', () => {
    assert.equal(
      resolveCrapUpdaterOptions({ fullScope: true }, CONFIG).fullScope,
      true,
    );
    assert.equal(
      resolveCrapUpdaterOptions({ diffScopeRef: 'HEAD~1' }, CONFIG)
        .diffScopeRef,
      'HEAD~1',
    );
  });
});

describe('buildCrapUpdaterScorer — the no-artifact refusal', () => {
  it('returns no rows and warns twice when coverage is absent under requireCoverage', async () => {
    const logger = recordingLogger();
    const options = resolveCrapUpdaterOptions({}, CONFIG, '/repo');
    let scanned = false;
    const scorer = buildCrapUpdaterScorer(options, {
      loadCoverage: () => null,
      scan: async () => {
        scanned = true;
        return {};
      },
      logger,
    });
    assert.deepEqual(await scorer([], { cwd: '/repo' }), []);
    assert.equal(scanned, false, 'must not scan without an artifact');
    assert.match(logger.lines.warn.join('\n'), /No coverage artifact/);
    assert.match(logger.lines.warn.join('\n'), /npm run test:coverage/);
  });

  it('scans anyway when requireCoverage is false', async () => {
    const options = resolveCrapUpdaterOptions(
      {},
      { crap: { requireCoverage: false }, baselines: CONFIG.baselines },
      '/repo',
    );
    let scanned = false;
    const scorer = buildCrapUpdaterScorer(options, {
      loadCoverage: () => null,
      scan: async () => {
        scanned = true;
        return { rows: [], scannedFiles: 0 };
      },
      logger: recordingLogger(),
    });
    await scorer([], { cwd: '/repo' });
    assert.equal(scanned, true);
  });
});

describe('buildCrapUpdaterScorer — the resolution-floor refusal', () => {
  /** Drive the scorer with a scan whose join resolved `resolved` of `total`. */
  function scorerWithResolution(resolution) {
    const options = resolveCrapUpdaterOptions({}, CONFIG, '/repo');
    return buildCrapUpdaterScorer(options, {
      loadCoverage: () => ({}),
      scan: async () => ({
        rows: [{ file: 'a.js', method: 'm', startLine: 1, crap: 3 }],
        scannedFiles: 1,
        resolution,
      }),
      logger: recordingLogger(),
    });
  }

  it('throws before returning rows when the rate is under the floor', async () => {
    // Below the 0.9 floor with a sample large enough to be enforced.
    await assert.rejects(
      () =>
        scorerWithResolution({
          resolvedMethods: 10,
          joinableMethods: 100,
          rate: 0.1,
          worstFiles: [],
        })([], { cwd: '/repo' }),
      /Refusing to persist/,
    );
  });

  it('passes rows through when the rate clears the floor', async () => {
    const rows = await scorerWithResolution({
      resolvedMethods: 99,
      joinableMethods: 100,
      rate: 0.99,
      worstFiles: [],
    })([], { cwd: '/repo' });
    assert.equal(rows.length, 1);
  });
});

describe('buildCrapUpdaterScorer — rows and reporting', () => {
  /** Build a scorer over a fixed scan summary. */
  function scorerFor(summary, logger) {
    const options = resolveCrapUpdaterOptions({}, CONFIG, '/repo');
    return buildCrapUpdaterScorer(options, {
      loadCoverage: () => ({}),
      scan: async () => summary,
      logger,
    });
  }

  it('keeps only rows carrying a finite crap number', async () => {
    const rows = await scorerFor(
      {
        scannedFiles: 1,
        rows: [
          { file: 'a.js', method: 'ok', crap: 3 },
          { file: 'a.js', method: 'nullCrap', crap: null },
          { file: 'a.js', method: 'nan', crap: Number.NaN },
          { file: 'a.js', method: 'infinite', crap: Number.POSITIVE_INFINITY },
        ],
      },
      recordingLogger(),
    )([], { cwd: '/repo' });
    assert.deepEqual(
      rows.map((r) => r.method),
      ['ok'],
    );
  });

  it('reports each drop counter only when it moved', async () => {
    const logger = recordingLogger();
    await scorerFor(
      {
        scannedFiles: 9,
        rows: [],
        skippedFilesNoCoverage: 2,
        skippedMethodsNoCoverage: 0,
        unscorableFiles: 0,
      },
      logger,
    )([], { cwd: '/repo' });
    const out = logger.all();
    assert.match(out, /Scanned 9 file\(s\)/);
    assert.match(out, /2 file\(s\) skipped without coverage entries/);
    assert.doesNotMatch(out, /per-method coverage unresolved/);
    assert.doesNotMatch(out, /unscorable/);
  });

  it('never leaves an unscorable file silent (Story #5311)', async () => {
    const logger = recordingLogger();
    await scorerFor({ scannedFiles: 3, rows: [], unscorableFiles: 1 }, logger)(
      [],
      { cwd: '/repo' },
    );
    assert.match(logger.all(), /1 file\(s\) unscorable/);
  });

  it('reports the method-resolution rate when the scan supplied one', async () => {
    const logger = recordingLogger();
    await scorerFor(
      {
        scannedFiles: 1,
        rows: [],
        resolution: {
          resolvedMethods: 45,
          joinableMethods: 50,
          rate: 0.9,
          worstFiles: [],
        },
      },
      logger,
    )([], { cwd: '/repo' });
    assert.match(logger.all(), /Method resolution: 45\/50 \(90\.0%\)/);
  });

  it('passes fullScope through as a null scopeFiles, and a diff as the file list', async () => {
    const options = resolveCrapUpdaterOptions({}, CONFIG, '/repo');
    const seen = [];
    const scorer = buildCrapUpdaterScorer(options, {
      loadCoverage: () => ({}),
      scan: async (args) => {
        seen.push(args.scopeFiles);
        return { rows: [], scannedFiles: 0 };
      },
      logger: recordingLogger(),
    });
    await scorer(['a.js'], { cwd: '/repo', fullScope: true });
    await scorer(['a.js'], { cwd: '/repo', fullScope: false });
    assert.equal(seen[0], null);
    assert.deepEqual(seen[1], ['a.js']);
  });

  it('resolves a relative coverage path against the scan cwd, not the build cwd', async () => {
    const options = resolveCrapUpdaterOptions({}, CONFIG, '/repo');
    let asked;
    const scorer = buildCrapUpdaterScorer(options, {
      loadCoverage: (p) => {
        asked = p;
        return {};
      },
      scan: async () => ({ rows: [], scannedFiles: 0 }),
      logger: recordingLogger(),
    });
    await scorer([], { cwd: '/elsewhere' });
    assert.equal(
      asked,
      path.resolve('/elsewhere', 'coverage/coverage-final.json'),
    );
    assert.notEqual(
      asked,
      path.resolve(process.cwd(), 'coverage/coverage-final.json'),
    );
  });

  it('leaves an absolute coverage path alone', async () => {
    const options = resolveCrapUpdaterOptions(
      { coveragePath: '/abs/cov.json' },
      CONFIG,
      '/repo',
    );
    let asked;
    const scorer = buildCrapUpdaterScorer(options, {
      loadCoverage: (p) => {
        asked = p;
        return {};
      },
      scan: async () => ({ rows: [], scannedFiles: 0 }),
      logger: recordingLogger(),
    });
    await scorer([], { cwd: '/elsewhere' });
    assert.equal(asked, '/abs/cov.json');
  });
});
