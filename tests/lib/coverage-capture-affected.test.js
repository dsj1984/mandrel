import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { runCoverageCapture } from '../../.agents/scripts/coverage-capture.js';
import { getQuality } from '../../.agents/scripts/lib/config-resolver.js';
import { getAgentrcValidator } from '../../.agents/scripts/lib/config-settings-schema.js';
import { filterFilesUnderTargets } from '../../.agents/scripts/lib/coverage-capture.js';
import { tryScopedCapture } from '../../.agents/scripts/lib/coverage-capture-affected.js';

const AFFECTED_CAPTURE_SCRIPT = 'test:coverage:affected';
const COVERAGE_BASE_REF_ENV = 'MANDREL_COVERAGE_BASE_REF';

// Story #5472 — `captureScope: "affected"`. No suite is spawned here: every
// capture runs through an injected runner and an in-memory artifact store.

const CWD = path.resolve('/repo');
const ARTIFACT = path.join(CWD, 'coverage/coverage-final.json');
const abs = (rel) => path.join(CWD, rel);
const CRAP = {
  enabled: true,
  targetDirs: ['src'],
  coveragePath: 'coverage/coverage-final.json',
};

function memFs(initial) {
  const files = new Map(initial ? [[ARTIFACT, JSON.stringify(initial)]] : []);
  return {
    files,
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`);
      return files.get(p);
    },
    writeFileSync: (p, body) => files.set(p, body),
  };
}

function logSink() {
  const log = { info: [], warn: [], error: [] };
  return {
    log,
    logger: {
      info: (m) => log.info.push(m),
      warn: (m) => log.warn.push(m),
      error: (m) => log.error.push(m),
    },
  };
}

function affectedHarness({
  prior = null,
  scoped = { [abs('src/a.js')]: { s: { 0: 1 } } },
  changed = ['src/a.js'],
  fresh = false,
  captureCode = 0,
  crap = CRAP,
} = {}) {
  const fsImpl = memFs(prior);
  const { log, logger } = logSink();
  const calls = { capture: [], stamp: [] };
  const opts = {
    crap,
    coverage: { timeoutMs: 99, captureScope: 'affected' },
    readPackageScriptsImpl: () => ({}),
    hasNpmScriptImpl: (_s, name) => name === AFFECTED_CAPTURE_SCRIPT,
    args: { ref: null, cwd: CWD },
    getChangedFilesImpl: () => {
      if (changed === 'throw') throw new Error('bad ref');
      return changed;
    },
    filterFilesUnderTargetsImpl: filterFilesUnderTargets,
    isCoverageFreshImpl: (a) => ({ fresh, reason: a.requireScope }),
    runCaptureImpl: async (a) => {
      calls.capture.push(a);
      if (scoped !== null) fsImpl.files.set(ARTIFACT, JSON.stringify(scoped));
      return captureCode;
    },
    computeContentDigestImpl: () => 'd1',
    writeCaptureStampImpl: (a) => {
      calls.stamp.push(a);
      return true;
    },
    logger,
    fsImpl,
  };
  return { opts, calls, log, fsImpl };
}

describe('tryScopedCapture — applicability', () => {
  it('returns null unless captureScope is "affected" (incremental off)', async () => {
    for (const captureScope of [undefined, 'full']) {
      const h = affectedHarness();
      h.opts.coverage = { captureScope };
      assert.equal(await tryScopedCapture(h.opts), null);
      assert.equal(h.calls.capture.length, 0);
      assert.equal(h.log.warn.length, 0);
    }
  });

  it('AC-2: warns naming the missing script and falls through to full scope', async () => {
    const h = affectedHarness();
    h.opts.hasNpmScriptImpl = () => false;
    assert.equal(await tryScopedCapture(h.opts), null);
    assert.equal(h.calls.capture.length, 0);
    assert.equal(h.log.warn.length, 1);
    assert.match(h.log.warn[0], /test:coverage:affected/);
  });
});

describe('tryScopedCapture — capture', () => {
  it('AC-1: spawns the scoped script with the base ref in env and no positional files', async () => {
    const h = affectedHarness();
    assert.equal(await tryScopedCapture(h.opts), 0);
    assert.equal(h.calls.capture.length, 1);
    const call = h.calls.capture[0];
    assert.equal(call.script, AFFECTED_CAPTURE_SCRIPT);
    assert.equal(call.env[COVERAGE_BASE_REF_ENV], 'main');
    assert.equal(call.args, undefined);
    assert.equal(call.files, undefined);
  });

  it('AC-1: an explicit --ref wins as the base ref', async () => {
    const h = affectedHarness();
    h.opts.args.ref = 'origin/release';
    await tryScopedCapture(h.opts);
    assert.equal(
      h.calls.capture[0].env[COVERAGE_BASE_REF_ENV],
      'origin/release',
    );
  });

  it('AC-3: merges over the prior artifact and stamps the result affected', async () => {
    const h = affectedHarness({
      prior: {
        [abs('src/a.js')]: { s: { 0: 0 } },
        [abs('src/untouched.js')]: { s: { 0: 5 } },
      },
    });
    assert.equal(await tryScopedCapture(h.opts), 0);
    const merged = JSON.parse(h.fsImpl.files.get(ARTIFACT));
    assert.deepEqual(merged[abs('src/untouched.js')], { s: { 0: 5 } });
    assert.deepEqual(merged[abs('src/a.js')], { s: { 0: 1 } });
    assert.equal(h.calls.stamp.length, 1);
    assert.equal(h.calls.stamp[0].scope, 'affected');
    assert.deepEqual(h.calls.stamp[0].files, ['src/a.js']);
  });

  it('AC-6: drops the prior row of a changed file the scoped run skipped', async () => {
    const h = affectedHarness({
      prior: { [abs('src/b.js')]: { s: { 0: 5 } } },
      changed: ['src/a.js', 'src/b.js'],
    });
    await tryScopedCapture(h.opts);
    const merged = JSON.parse(h.fsImpl.files.get(ARTIFACT));
    assert.equal(merged[abs('src/b.js')], undefined);
  });

  it('merges nothing prior when the change set is unreadable', async () => {
    const h = affectedHarness({
      prior: { [abs('src/old.js')]: { s: { 0: 5 } } },
      changed: 'throw',
    });
    assert.equal(await tryScopedCapture(h.opts), 0);
    const merged = JSON.parse(h.fsImpl.files.get(ARTIFACT));
    assert.deepEqual(Object.keys(merged), [abs('src/a.js')]);
    assert.match(h.log.warn[0], /bad ref/);
  });

  it('skips when nothing under targetDirs changed and skipWhenUnchanged is on', async () => {
    const h = affectedHarness({
      changed: ['docs/x.md'],
      crap: { ...CRAP, incrementalCoverage: { skipWhenUnchanged: true } },
    });
    assert.equal(await tryScopedCapture(h.opts), 0);
    assert.equal(h.calls.capture.length, 0);
  });

  it('probes freshness at affected scope and skips a fresh artifact', async () => {
    const h = affectedHarness({ fresh: true });
    assert.equal(await tryScopedCapture(h.opts), 0);
    assert.equal(h.calls.capture.length, 0);
  });

  it('surfaces a failing scoped run without stamping', async () => {
    const h = affectedHarness({ captureCode: 1 });
    assert.equal(await tryScopedCapture(h.opts), 1);
    assert.equal(h.calls.stamp.length, 0);
  });

  it('Story #5487: an eligible stale stamp keys the run on the stamped commit and drops only the delta', async () => {
    const h = affectedHarness({
      prior: {
        [abs('src/a.js')]: { s: { 0: 7 } },
        [abs('src/b.js')]: { s: { 0: 5 } },
      },
      scoped: {},
    });
    h.opts.isCoverageFreshImpl = () => ({ fresh: false, reason: 'stale' });
    h.opts.readHeadCommitImpl = () => 'f'.repeat(40);
    h.opts.classifyDeltaRefreshImpl = () => ({
      eligible: true,
      commit: 'c'.repeat(40),
      delta: ['src/b.js'],
      stamp: { digest: 'd0', scope: 'affected' },
    });
    assert.equal(await tryScopedCapture(h.opts), 0);
    assert.equal(h.calls.capture[0].env[COVERAGE_BASE_REF_ENV], 'c'.repeat(40));
    const merged = JSON.parse(h.fsImpl.files.get(ARTIFACT));
    // The Story's own file keeps its prior row; main's delta is re-measured.
    assert.deepEqual(merged[abs('src/a.js')], { s: { 0: 7 } });
    assert.equal(merged[abs('src/b.js')], undefined);
    assert.equal(h.calls.stamp[0].commit, 'f'.repeat(40));
    assert.match(
      h.log.info.join('\n'),
      /verdict: delta-refresh, delta: 1 file/,
    );
  });

  it('Story #5487: an ineligible stale stamp captures the Story scope as before', async () => {
    const h = affectedHarness();
    h.opts.isCoverageFreshImpl = () => ({ fresh: false, reason: 'stale' });
    h.opts.classifyDeltaRefreshImpl = () => ({
      eligible: false,
      reason: 'worktree is dirty',
      stamp: null,
    });
    assert.equal(await tryScopedCapture(h.opts), 0);
    assert.equal(h.calls.capture[0].env[COVERAGE_BASE_REF_ENV], 'main');
    assert.match(h.log.info.join('\n'), /not eligible \(worktree is dirty\)/);
  });

  it('fails closed when the scoped run wrote no artifact', async () => {
    const h = affectedHarness({ scoped: null });
    assert.equal(await tryScopedCapture(h.opts), 1);
    assert.match(h.log.error[0], /no readable artifact/);
  });
});

describe('coverage-capture CLI under captureScope', () => {
  function cli({ captureScope, scripts }) {
    const { log, logger } = logSink();
    const captures = [];
    const deps = {
      resolveConfigImpl: () => ({
        delivery: { execution: { fullSuiteLock: false } },
      }),
      getQualityImpl: () => ({
        crap: CRAP,
        coverage: { timeoutMs: 1, captureScope },
      }),
      readPackageScriptsImpl: () => scripts,
      getChangedFilesImpl: () => ['src/a.js'],
      isCoverageFreshImpl: () => ({ fresh: false, reason: 'stale' }),
      runCaptureImpl: async (a) => {
        captures.push(a);
        return 0;
      },
      computeContentDigestImpl: () => null,
      writeCaptureStampImpl: () => true,
      logger,
    };
    return { deps, captures, log };
  }
  const argv = ['node', 'coverage-capture.js', '--cwd', '/nonexistent-5472'];

  it('AC-1: runs the scoped script when present', async () => {
    const h = cli({
      captureScope: 'affected',
      scripts: { 'test:coverage': 'x', [AFFECTED_CAPTURE_SCRIPT]: 'y' },
    });
    // The capture writes no artifact at the nonexistent cwd, so it fails
    // closed after the spawn — the spawn shape is what this asserts.
    await runCoverageCapture(argv, h.deps);
    assert.equal(h.captures.length, 1);
    assert.equal(h.captures[0].script, AFFECTED_CAPTURE_SCRIPT);
    assert.equal(typeof h.captures[0].env[COVERAGE_BASE_REF_ENV], 'string');
  });

  it('AC-2: falls back to the full test:coverage when the script is absent', async () => {
    const h = cli({
      captureScope: 'affected',
      scripts: { 'test:coverage': 'x' },
    });
    assert.equal(await runCoverageCapture(argv, h.deps), 0);
    assert.equal(h.captures.length, 1);
    assert.equal(h.captures[0].script, undefined);
    assert.match(h.log.warn.join('\n'), /test:coverage:affected/);
  });

  it('AC-7: an unset captureScope runs the full capture with no warning', async () => {
    const h = cli({
      captureScope: undefined,
      scripts: { 'test:coverage': 'x', [AFFECTED_CAPTURE_SCRIPT]: 'y' },
    });
    assert.equal(await runCoverageCapture(argv, h.deps), 0);
    assert.equal(h.captures[0].script, undefined);
    assert.doesNotMatch(h.log.warn.join('\n'), /captureScope/);
  });
});

describe('delivery.quality.gates.coverage.captureScope config (AC-7)', () => {
  const validate = getAgentrcValidator();
  const doc = (coverage) => ({
    project: {
      paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
    },
    delivery: { quality: { gates: { coverage } } },
  });

  it('accepts full and affected', () => {
    for (const captureScope of ['full', 'affected']) {
      assert.equal(validate(doc({ captureScope })), true, captureScope);
    }
  });

  it('rejects any other value', () => {
    assert.equal(validate(doc({ captureScope: 'changed' })), false);
    assert.match(
      validate.errors.map((e) => e.message).join(' '),
      /allowed values/,
    );
  });

  it('resolves to full when unset and passes a set value through', () => {
    assert.equal(getQuality({}).coverage.captureScope, 'full');
    assert.equal(
      getQuality({ delivery: { quality: { gates: { coverage: {} } } } })
        .coverage.captureScope,
      'full',
    );
    assert.equal(
      getQuality({
        delivery: {
          quality: { gates: { coverage: { captureScope: 'affected' } } },
        },
      }).coverage.captureScope,
      'affected',
    );
  });
});
