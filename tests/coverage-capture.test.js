import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  parseArgs,
  runCoverageCapture,
} from '../.agents/scripts/coverage-capture.js';
import { getQuality } from '../.agents/scripts/lib/config-resolver.js';
import { handleCoverageCaptureHelp } from '../.agents/scripts/lib/coverage-capture-usage.js';

/**
 * Story #4780 — `main` scored CRAP 42.7: the gate that decides whether
 * `npm run test:coverage` runs before the CRAP gate fires had no unit test,
 * because the module used to `process.exit()` on import. It is now guarded by
 * a direct-invocation check, and its decision table is driven entirely
 * through the optional final `deps` parameter (`.agents/rules/test-seams.md`
 * rules 1 and 5) — no suite is ever spawned by this file.
 */

const CRAP = {
  enabled: true,
  targetDirs: ['.agents/scripts', 'lib'],
  coveragePath: 'coverage/coverage-final.json',
};

function harness({
  crap = CRAP,
  fresh = { fresh: true, reason: 'fresh' },
  changed = ['.agents/scripts/a.js'],
  captureCode = 0,
  hasScript = true,
  digest = 'deadbeef',
  digests = null,
  stampWritten = true,
  lockEnabled = false,
  requireCredited = undefined,
} = {}) {
  const log = { info: [], warn: [], error: [] };
  // `order` interleaves the announcement with the spawn so a test can assert
  // the warning is emitted BEFORE the suite starts — the whole point of the
  // credit probe is that the cost is announced while it is still ahead of you.
  const calls = {
    capture: [],
    stamp: [],
    changed: [],
    fresh: [],
    order: [],
    digest: [],
  };
  return {
    log,
    calls,
    deps: {
      // Story #5173 — the CLI wraps the capture runner in the real
      // `lockedCapture`, so the stub config disables the host lock: a unit
      // test must not create a lockfile in the developer's checkout. The
      // enabled path is driven explicitly below and in
      // tests/lib/full-suite-lock.test.js.
      resolveConfigImpl: (args) => ({
        cwdSeen: args.cwd,
        delivery: {
          execution: {
            fullSuiteLock: lockEnabled,
            ...(requireCredited === undefined
              ? {}
              : { requireCreditedCapture: requireCredited }),
          },
        },
      }),
      getQualityImpl: () => ({ crap, coverage: { timeoutMs: 1234 } }),
      readPackageScriptsImpl: () => ({ 'test:coverage': 'node --test' }),
      hasNpmScriptImpl: () => hasScript,
      getChangedFilesImpl: (args) => {
        calls.changed.push(args);
        if (changed === 'throw') throw new Error('bad ref');
        return changed;
      },
      isCoverageFreshImpl: (args) => {
        calls.fresh.push(args);
        return fresh;
      },
      runCaptureImpl: (args) => {
        calls.order.push('capture');
        calls.capture.push(args);
        args.log('capture says hello');
        return captureCode;
      },
      // Story #5278 — the capture paths digest the tree TWICE (before the
      // spawn and after it), so a test can model a tree that moved mid-run by
      // handing back a different value on the second call.
      computeContentDigestImpl: () => {
        calls.digest.push(true);
        if (!digests) return digest;
        return digests[Math.min(calls.digest.length - 1, digests.length - 1)];
      },
      writeCaptureStampImpl: (args) => {
        calls.stamp.push(args);
        return stampWritten;
      },
      logger: {
        info: (m) => log.info.push(m),
        warn: (m) => {
          calls.order.push('warn');
          log.warn.push(m);
        },
        error: (m) => log.error.push(m),
      },
    },
  };
}

const argv = (...flags) => ['node', 'coverage-capture.js', ...flags];

describe('coverage-capture parseArgs', () => {
  it('defaults to a non-skipping capture against main in the cwd', () => {
    const parsed = parseArgs(argv());
    assert.equal(parsed.skipWhenNoCrapFiles, false);
    assert.equal(parsed.ref, 'main');
    assert.equal(parsed.cwd, process.cwd());
  });

  it('reads --skip-when-no-crap-files, --require-credited, --ref and --cwd', () => {
    const parsed = parseArgs(
      argv(
        '--skip-when-no-crap-files',
        '--require-credited',
        '--ref',
        'develop',
        '--cwd',
        '/repo',
      ),
    );
    assert.deepEqual(parsed, {
      skipWhenNoCrapFiles: true,
      requireCredited: true,
      ref: 'develop',
      cwd: '/repo',
    });
  });

  it('AC-1: --require-credited defaults off, so a bare invocation can deposit', () => {
    assert.equal(parseArgs(argv()).requireCredited, false);
  });

  it('keeps the defaults when a value-taking flag has no value', () => {
    const parsed = parseArgs(argv('--ref'));
    assert.equal(parsed.ref, 'main');
  });
});

// The delivery workflow invokes this script by name, so it owes the
// workflow-invoked self-description contract
// (tests/enforcement/workflow-script-help.test.js). Before this wiring
// `--help` fell through to the capture path and ran the whole coverage suite,
// which is why the CLI shell answers it ahead of `runCoverageCapture`.
describe('handleCoverageCaptureHelp', () => {
  it('prints the usage block and reports that the run must stop', () => {
    const out = [];
    const sink = { write: (s) => out.push(s) };
    assert.equal(handleCoverageCaptureHelp(argv('--help'), sink), true);
    assert.match(out.join(''), /coverage-capture\.js/);
    assert.match(out.join(''), /--skip-when-no-crap-files/);
    assert.match(out.join(''), /--ref/);
  });

  it('accepts the -h alias', () => {
    const out = [];
    assert.equal(
      handleCoverageCaptureHelp(argv('-h'), { write: (s) => out.push(s) }),
      true,
    );
    assert.ok(out.join('').trim().length > 0);
  });

  it('stays out of the way of a normal invocation', () => {
    const out = [];
    assert.equal(
      handleCoverageCaptureHelp(argv('--ref', 'main'), {
        write: (s) => out.push(s),
      }),
      false,
    );
    assert.equal(out.length, 0);
  });
});

describe('runCoverageCapture', () => {
  it('exits 0 immediately when the CRAP gate is disabled', () => {
    const h = harness({ crap: { ...CRAP, enabled: false } });
    assert.equal(runCoverageCapture(argv(), h.deps), 0);
    assert.equal(h.calls.capture.length, 0);
    assert.match(h.log.info[0], /CRAP gate disabled — skipping capture/);
  });

  it('fails with a fix-naming diagnostic when there is no test:coverage script', () => {
    const h = harness({ hasScript: false });
    assert.equal(runCoverageCapture(argv(), h.deps), 1);
    assert.match(h.log.error[0], /No "test:coverage" script in package\.json/);
    assert.equal(h.calls.capture.length, 0);
  });

  it('skips the capture when no changed file lives under the target dirs', () => {
    const h = harness({ changed: ['README.md'] });
    assert.equal(
      runCoverageCapture(argv('--skip-when-no-crap-files'), h.deps),
      0,
    );
    assert.equal(h.calls.fresh.length, 0);
    assert.match(
      h.log.info[0],
      /No changed files under \[\.agents\/scripts, lib\]/,
    );
  });

  it('proceeds to the freshness check when a target-dir file changed', () => {
    const h = harness({ changed: ['.agents/scripts/a.js'] });
    assert.equal(
      runCoverageCapture(argv('--skip-when-no-crap-files'), h.deps),
      0,
    );
    assert.equal(h.calls.fresh.length, 1);
  });

  it('never consults changed files without the skip flag', () => {
    const h = harness();
    runCoverageCapture(argv(), h.deps);
    assert.equal(h.calls.changed.length, 0);
  });

  it('warns and falls back to the freshness check when the ref is bad', () => {
    const h = harness({ changed: 'throw' });
    assert.equal(
      runCoverageCapture(
        argv('--skip-when-no-crap-files', '--ref', 'nope'),
        h.deps,
      ),
      0,
    );
    assert.match(h.log.warn[0], /bad ref — falling back to freshness check/);
    assert.equal(h.calls.fresh.length, 1);
  });

  it('skips the capture when coverage is already fresh', () => {
    const h = harness({ fresh: { fresh: true, reason: 'content-identical' } });
    assert.equal(runCoverageCapture(argv('--cwd', '/repo'), h.deps), 0);
    assert.equal(h.calls.capture.length, 0);
    assert.match(
      h.log.info[0],
      new RegExp(
        `Coverage at ${path.resolve('/repo', CRAP.coveragePath).replace(/\\/g, '\\\\')} is content-identical`,
      ),
    );
  });

  it('captures, stamps, and returns 0 when coverage is stale', () => {
    const h = harness({ fresh: { fresh: false, reason: 'stale' } });
    assert.equal(runCoverageCapture(argv('--cwd', '/repo'), h.deps), 0);
    assert.deepEqual(h.calls.capture[0].cwd, '/repo');
    assert.equal(h.calls.capture[0].timeoutMs, 1234);
    assert.deepEqual(h.calls.stamp[0], {
      cwd: '/repo',
      coveragePath: CRAP.coveragePath,
      digest: 'deadbeef',
    });
    assert.ok(h.log.info.includes('capture says hello'));
    assert.ok(
      h.log.info.some((m) => /Wrote content-digest capture stamp/.test(m)),
    );
  });

  it('propagates a failing capture and never writes a stamp', () => {
    const h = harness({
      fresh: { fresh: false, reason: 'missing' },
      captureCode: 2,
    });
    assert.equal(runCoverageCapture(argv(), h.deps), 2);
    assert.equal(h.calls.stamp.length, 0);
    assert.match(h.log.error[0], /npm run test:coverage exited 2/);
  });

  it('treats an unavailable digest as a best-effort skip, not a failure', () => {
    const h = harness({
      fresh: { fresh: false, reason: 'missing' },
      digest: null,
    });
    assert.equal(runCoverageCapture(argv(), h.deps), 0);
    assert.equal(h.calls.stamp.length, 0);
    assert.equal(
      h.log.info.some((m) => /capture stamp/.test(m)),
      false,
    );
  });

  it('stays silent when the stamp write itself fails', () => {
    const h = harness({
      fresh: { fresh: false, reason: 'missing' },
      stampWritten: false,
    });
    assert.equal(runCoverageCapture(argv(), h.deps), 0);
    assert.equal(h.calls.stamp.length, 1);
    assert.equal(
      h.log.info.some((m) => /capture stamp/.test(m)),
      false,
    );
  });

  // Story #4981 — the capture skip. Story #5173 split the one `enabled`
  // switch into `skipWhenUnchanged` (this path) and `baselineJoin` (the CRAP
  // join) and defaulted the skip ON, so these fixtures use the RESOLVED shape
  // `config/quality.js` hands the CLI, not the raw user block.
  describe('capture skip (Story #4981, defaulted on by #5173)', () => {
    const SKIP_ON = {
      ...CRAP,
      incrementalCoverage: {
        skipWhenUnchanged: true,
        baselineJoin: false,
        baseRef: 'origin/main',
      },
    };

    // Story #5065 — the changed-file set decides WHETHER to capture and is
    // recorded on the stamp; it is never forwarded to the capture spawn. The
    // spawn takes no positional file arguments, because Node's runner would
    // execute those source files as tests instead of running the suite.
    it('captures on a changed target-dir file and stamps scope: incremental', () => {
      const h = harness({
        crap: SKIP_ON,
        changed: ['.agents/scripts/a.js', 'README.md'],
        fresh: { fresh: false, reason: 'missing' },
      });
      assert.equal(runCoverageCapture(argv('--cwd', '/repo'), h.deps), 0);
      assert.equal(h.calls.changed[0].ref, 'origin/main');
      assert.equal(
        h.calls.capture[0].files,
        undefined,
        'the capture spawn must receive no file list',
      );
      assert.deepEqual(h.calls.stamp[0], {
        cwd: '/repo',
        coveragePath: CRAP.coveragePath,
        digest: 'deadbeef',
        scope: 'incremental',
        files: ['.agents/scripts/a.js'],
        ref: 'origin/main',
      });
    });

    it('AC-5: passes requireScope: incremental to the freshness probe, so the stamp it writes cannot credit a full-scope caller', () => {
      const h = harness({ crap: SKIP_ON });
      runCoverageCapture(argv(), h.deps);
      assert.equal(h.calls.fresh[0].requireScope, 'incremental');
    });

    it('skips capture when nothing changed under targetDirs', () => {
      const h = harness({ crap: SKIP_ON, changed: ['README.md'] });
      assert.equal(runCoverageCapture(argv(), h.deps), 0);
      assert.equal(h.calls.capture.length, 0);
      assert.match(h.log.info[0], /Incremental mode: no changed files/);
    });

    it('falls back to full-scope capture on a bad ref (fail-closed, not skipped)', () => {
      const h = harness({ crap: SKIP_ON, changed: 'throw' });
      runCoverageCapture(argv(), h.deps);
      assert.match(h.log.warn[0], /incremental mode:.*falling back/);
      // Full-scope path still ran (freshness probe reached with default scope).
      assert.equal(h.calls.fresh.length, 1);
      assert.equal(h.calls.fresh[0].requireScope, undefined);
    });

    // AC-4 — the saving, measured through the REAL resolver rather than a
    // hand-written fixture: a consumer with no `incrementalCoverage` key at
    // all must skip the suite on a docs-only diff. Resolving the config here
    // is the point of the test; a fixture asserting `skipWhenUnchanged: true`
    // would pass even if the default were still off.
    it('AC-4: a docs-only diff under the inherited default costs no suite spawn', () => {
      const { crap } = getQuality({});
      assert.equal(
        crap.incrementalCoverage.skipWhenUnchanged,
        true,
        'AC-1: the skip is inherited without setting the key',
      );
      const h = harness({
        crap: { ...crap, targetDirs: CRAP.targetDirs },
        changed: ['README.md', 'docs/architecture.md'],
      });
      assert.equal(runCoverageCapture(argv(), h.deps), 0);
      assert.equal(h.calls.capture.length, 0);
    });

    // AC-3 — the capture half of the independence claim: the skip must not
    // read `baselineJoin`. The join half (it must not read
    // `skipWhenUnchanged`) is asserted in tests/config/quality.floors.test.js
    // against `resolveCrapPreviewIncremental`.
    it('AC-3: skipWhenUnchanged:false skips nothing even with baselineJoin on', () => {
      const h = harness({
        crap: {
          ...CRAP,
          incrementalCoverage: {
            skipWhenUnchanged: false,
            baselineJoin: true,
            baseRef: null,
          },
        },
        changed: ['README.md'],
        fresh: { fresh: false, reason: 'missing' },
      });
      assert.equal(runCoverageCapture(argv(), h.deps), 0);
      assert.equal(h.calls.capture.length, 1, 'the full-scope path must run');
      assert.equal(h.calls.fresh[0].requireScope, undefined);
    });
  });

  // Story #5173 — the CLI composes the host lock over the capture runner, so
  // whichever capture path reaches the spawn is serialized without knowing it.
  // ───────────────────────────────────────────────────────────────────────
  // The uncredited-capture probe.
  //
  // A full-suite capture is the most expensive thing a close does. Before
  // this, the only way to learn that a close had paid for one was to read
  // `durationMs` out of `validation-evidence.json` afterwards — by which
  // point the twelve minutes are spent. The probe moves that signal ahead of
  // the spawn, and `delivery.execution.requireCreditedCapture` turns it from
  // an announcement into a refusal.
  describe('uncredited full-suite capture is announced before it is paid for', () => {
    const SKIP_ON = {
      ...CRAP,
      incrementalCoverage: { skipWhenUnchanged: true, baseRef: 'origin/main' },
    };
    const STALE = { fresh: false, reason: 'missing' };

    it('the warning naming the crediting invocation precedes the spawn', () => {
      const h = harness({ fresh: STALE });
      assert.equal(runCoverageCapture(argv('--cwd', '/repo'), h.deps), 0);
      assert.deepEqual(
        h.calls.order,
        ['warn', 'capture'],
        'the cost must be announced while it is still ahead of the reader',
      );
      const warned = h.log.warn.join('\n');
      assert.match(warned, /no credited capture stamp covers this change set/);
      assert.match(
        warned,
        /node <main-repo>\/\.agents\/scripts\/coverage-capture\.js --cwd <workCwd>/,
        'the announcement must name the invocation that deposits credit',
      );
    });

    it('the incremental path inherits the probe without knowing about it', () => {
      const h = harness({ crap: SKIP_ON, fresh: STALE });
      assert.equal(runCoverageCapture(argv('--cwd', '/repo'), h.deps), 0);
      assert.deepEqual(h.calls.order, ['warn', 'capture']);
    });

    it('a credited (fresh) stamp is silent — nothing to announce, nothing spawned', () => {
      const h = harness({ fresh: { fresh: true, reason: 'fresh' } });
      assert.equal(runCoverageCapture(argv('--cwd', '/repo'), h.deps), 0);
      assert.deepEqual(h.calls.order, []);
      assert.equal(h.log.warn.length, 0);
    });

    it('AC-1: --require-credited blocks before the spawn, naming the invocation', () => {
      const h = harness({ fresh: STALE });
      assert.equal(
        runCoverageCapture(
          argv('--cwd', '/repo', '--require-credited'),
          h.deps,
        ),
        1,
      );
      assert.equal(
        h.calls.capture.length,
        0,
        'the suite must not run: the refusal is the whole saving',
      );
      assert.equal(h.calls.stamp.length, 0);
      assert.match(
        h.log.error.join('\n'),
        /node <main-repo>\/\.agents\/scripts\/coverage-capture\.js --cwd <workCwd>/,
      );
    });

    it('AC-1: --require-credited also blocks the incremental path', () => {
      const h = harness({ crap: SKIP_ON, fresh: STALE });
      assert.equal(
        runCoverageCapture(
          argv('--cwd', '/repo', '--require-credited'),
          h.deps,
        ),
        1,
      );
      assert.equal(h.calls.capture.length, 0);
    });

    // Story #5278 — the defect the flag replaces. When the CLI read
    // `delivery.execution.requireCreditedCapture` itself, enabling the policy
    // refused EVERY invocation, the depositing one included: there was no
    // path left that could earn the credit the refusal demanded, so the CRAP
    // gate could never go green again.
    it('AC-1: the deposit path survives requireCreditedCapture: true in config', () => {
      const h = harness({ fresh: STALE, requireCredited: true });
      assert.equal(
        runCoverageCapture(argv('--cwd', '/repo'), h.deps),
        0,
        'a bare invocation must run and deposit whatever the config says',
      );
      assert.equal(h.calls.capture.length, 1);
      assert.equal(h.calls.stamp.length, 1);
    });

    it('without the flag the announcement is a warning and the run proceeds', () => {
      const h = harness({ fresh: STALE });
      assert.equal(runCoverageCapture(argv('--cwd', '/repo'), h.deps), 0);
      assert.equal(h.calls.capture.length, 1);
      assert.equal(h.calls.stamp.length, 1);
    });

    it('--require-credited never blocks a run that was going to be skipped', () => {
      const h = harness({
        crap: SKIP_ON,
        changed: ['README.md'],
        fresh: STALE,
      });
      assert.equal(
        runCoverageCapture(
          argv('--cwd', '/repo', '--require-credited'),
          h.deps,
        ),
        0,
        'nothing under targetDirs changed — there is no capture to refuse',
      );
      assert.equal(h.calls.capture.length, 0);
    });
  });

  describe('full-suite lock wiring (Story #5173)', () => {
    // AC-9 — the lock covers the spawn, never the freshness check. A capture
    // that is already credited returns before the runner is reached at all,
    // so there is nothing to wait on.
    it('AC-9: an already-fresh capture never reaches the lock', () => {
      const h = harness({ fresh: { fresh: true, reason: 'fresh' } });
      assert.equal(runCoverageCapture(argv(), h.deps), 0);
      assert.equal(
        h.calls.capture.length,
        0,
        'a fresh capture must not reach the spawn (and so not the lock)',
      );
    });

    it('passes the capture options through the wrapper unchanged', () => {
      const h = harness({ fresh: { fresh: false, reason: 'missing' } });
      assert.equal(runCoverageCapture(argv('--cwd', '/repo'), h.deps), 0);
      assert.equal(h.calls.capture.length, 1);
      assert.equal(h.calls.capture[0].cwd, '/repo');
      assert.equal(h.calls.capture[0].timeoutMs, 1234);
    });

    // Best-effort, end to end from the CLI: with the lock switched ON but no
    // resolvable lock home (`/repo` is not a checkout), the capture still
    // runs exactly once rather than failing or hanging.
    it('AC-10: an enabled lock with no resolvable home still captures once', () => {
      const h = harness({
        lockEnabled: true,
        fresh: { fresh: false, reason: 'missing' },
      });
      assert.equal(runCoverageCapture(argv('--cwd', '/repo'), h.deps), 0);
      assert.equal(h.calls.capture.length, 1);
    });
  });

  describe("'no-sources' is diagnosable, not a silent slow path (Story #5076)", () => {
    it('names the configured targetDirs and captures anyway', () => {
      const h = harness({ fresh: { fresh: false, reason: 'no-sources' } });
      assert.equal(runCoverageCapture(argv(), h.deps), 0);

      // Fail closed: an empty source walk must still capture.
      assert.equal(h.calls.capture.length, 1);

      // And say why — an empty walk is far more often a mis-scoped
      // `targetDirs` than a genuine recapture, so the dirs must be named or
      // it reads as an unexplained slow path on every single run.
      const logged = h.log.info.join('\n');
      assert.match(logged, /no scorable source file found/i);
      for (const dir of CRAP.targetDirs) {
        assert.ok(
          logged.includes(dir),
          `expected the capture log to name target dir ${dir}`,
        );
      }
      assert.match(logged, /quality\.gates\.crap\.targetDirs/);
    });

    it('leaves an ordinary stale recapture unannotated', () => {
      const h = harness({ fresh: { fresh: false, reason: 'stale' } });
      runCoverageCapture(argv(), h.deps);
      assert.equal(h.calls.capture.length, 1);
      const logged = h.log.info.join('\n');
      assert.match(logged, /is stale; running/);
      assert.doesNotMatch(logged, /targetDirs/);
    });
  });
});

describe('content-keyed capture stamps (Story #5278)', () => {
  const STALE = { fresh: false, reason: 'stale' };
  const SKIP_ON = {
    ...CRAP,
    incrementalCoverage: { skipWhenUnchanged: true },
  };

  // AC-6 — the stamp is a claim about content: "the coverage artifact
  // reflects sources digesting to X". Computing X after the suite finishes
  // makes that claim false whenever anything moved during the run, and the
  // next reader then credits a run against sources it never saw.
  it('AC-6: writes the PRE-spawn digest, not the post-spawn one', () => {
    const h = harness({ fresh: STALE, digests: ['before', 'before'] });
    assert.equal(runCoverageCapture(argv('--cwd', '/repo'), h.deps), 0);
    assert.equal(h.calls.stamp.length, 1);
    assert.equal(
      h.calls.stamp[0].digest,
      'before',
      'the stamped value is the tree the suite actually measured',
    );
  });

  it('AC-6: a tree that moved mid-run writes NO stamp and says so', () => {
    const h = harness({ fresh: STALE, digests: ['before', 'after'] });
    assert.equal(
      runCoverageCapture(argv('--cwd', '/repo'), h.deps),
      0,
      'the suite passed — the run is not a failure, it just earns no credit',
    );
    assert.equal(h.calls.stamp.length, 0, 'no stamp for a tree nobody has');
    assert.match(h.log.warn.join('\n'), /the tree moved while the suite ran/);
  });

  it('AC-6: the incremental path is keyed the same way', () => {
    const moved = harness({
      crap: SKIP_ON,
      fresh: STALE,
      digests: ['before', 'after'],
    });
    assert.equal(runCoverageCapture(argv('--cwd', '/repo'), moved.deps), 0);
    assert.equal(moved.calls.stamp.length, 0);

    const still = harness({
      crap: SKIP_ON,
      fresh: STALE,
      digests: ['before', 'before'],
    });
    assert.equal(runCoverageCapture(argv('--cwd', '/repo'), still.deps), 0);
    assert.equal(still.calls.stamp[0].digest, 'before');
    assert.equal(still.calls.stamp[0].scope, 'incremental');
  });

  it('an unavailable digest is "nothing to stamp", never "the tree moved"', () => {
    const h = harness({ fresh: STALE, digests: [null, null] });
    assert.equal(runCoverageCapture(argv('--cwd', '/repo'), h.deps), 0);
    assert.equal(h.calls.stamp.length, 0);
    assert.equal(
      /the tree moved/.test(h.log.warn.join('\n')),
      false,
      'a missing digest is the pre-#5278 fail-open, not a moved tree',
    );
  });

  it('a failing capture still writes no stamp and never digests twice', () => {
    const h = harness({ fresh: STALE, captureCode: 1 });
    assert.equal(runCoverageCapture(argv('--cwd', '/repo'), h.deps), 1);
    assert.equal(h.calls.stamp.length, 0);
  });

  // AC-7 — the capture path supplies the freshness re-probe the host lock
  // consults after a contended wait. Only the capture path knows which scope
  // the stamp has to satisfy, so it hands the probe down rather than the lock
  // guessing.
  it('AC-7: hands the lock a scope-correct freshness re-probe', () => {
    const full = harness({ fresh: STALE });
    assert.equal(runCoverageCapture(argv('--cwd', '/repo'), full.deps), 0);
    const probe = full.calls.capture[0].recheckFresh;
    assert.equal(typeof probe, 'function');
    full.calls.fresh.length = 0;
    probe();
    assert.equal(full.calls.fresh[0].requireScope, undefined, 'full scope');

    const incremental = harness({ crap: SKIP_ON, fresh: STALE });
    assert.equal(
      runCoverageCapture(argv('--cwd', '/repo'), incremental.deps),
      0,
    );
    incremental.calls.fresh.length = 0;
    incremental.calls.capture[0].recheckFresh();
    assert.equal(incremental.calls.fresh[0].requireScope, 'incremental');
  });
});
