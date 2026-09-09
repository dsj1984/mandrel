/**
 * tests/check-audit-attribution.test.js — Story #5248.
 *
 * The probe exists so an author whose diff did not cause a supply-chain
 * failure can see that in one line instead of debugging it. Two properties
 * carry that, and both are pinned here: the verdict is right, and the probe
 * can never become a failure mode of its own — every way it can break must
 * degrade to `unknown` rather than accuse the author or mask the audit.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseArgs,
  runAttribution,
} from '../.agents/scripts/check-audit-attribution.js';
import {
  attributionExitCode,
  deriveVerdict,
  INTRODUCED,
  PRE_EXISTING,
  renderAttribution,
  UNKNOWN,
} from '../.agents/scripts/lib/audit-attribution.js';

const argv = (...flags) => ['node', 'check-audit-attribution.js', ...flags];

function harness({
  headFailed = true,
  baseFailed = false,
  materializeThrows = null,
  auditBaseThrows = null,
  headThrows = null,
  trackingIssue = 7777,
  lookupThrows = false,
} = {}) {
  const log = { info: [], warn: [], error: [] };
  const calls = { cleanup: [], materialize: [] };
  return {
    log,
    calls,
    deps: {
      git: () => '{}',
      auditHead: () => {
        if (headThrows) throw new Error(headThrows);
        return { failed: headFailed };
      },
      auditBase: () => {
        if (auditBaseThrows) throw new Error(auditBaseThrows);
        return { failed: baseFailed };
      },
      materialize: (opts) => {
        calls.materialize.push(opts);
        if (materializeThrows) throw new Error(materializeThrows);
        return '/tmp/fake-base';
      },
      lookupTrackingIssue: () => {
        if (lookupThrows) throw new Error('gh not authenticated');
        return trackingIssue;
      },
      cleanup: (dir) => calls.cleanup.push(dir),
      logger: {
        info: (m) => log.info.push(m),
        warn: (m) => log.warn.push(m),
        error: (m) => log.error.push(m),
      },
    },
  };
}

describe('deriveVerdict — the attribution table', () => {
  it('base red + head red → pre-existing: the diff is innocent', () => {
    assert.equal(
      deriveVerdict({ headFailed: true, baseAudit: { failed: true } }),
      PRE_EXISTING,
    );
  });

  it('base clean + head red → introduced by this diff', () => {
    assert.equal(
      deriveVerdict({ headFailed: true, baseAudit: { failed: false } }),
      INTRODUCED,
    );
  });

  // The guess it would otherwise make is an accusation against the person
  // reading the log, so an unreachable base must never resolve to INTRODUCED.
  it('an unreadable base is unknown, never an accusation', () => {
    assert.equal(deriveVerdict({ headFailed: true, baseAudit: null }), UNKNOWN);
    assert.equal(
      deriveVerdict({ headFailed: true, baseAudit: { failed: 'maybe' } }),
      UNKNOWN,
    );
  });

  it('a clean head has nothing to attribute', () => {
    assert.equal(
      deriveVerdict({ headFailed: false, baseAudit: { failed: true } }),
      UNKNOWN,
    );
  });
});

describe('attributionExitCode — legibility, never permission', () => {
  it('both real verdicts still fail, so a pre-existing advisory keeps blocking', () => {
    assert.equal(attributionExitCode(PRE_EXISTING), 1);
    assert.equal(attributionExitCode(INTRODUCED), 1);
  });

  it('a degraded probe adds no failure of its own', () => {
    assert.equal(attributionExitCode(UNKNOWN), 0);
  });
});

describe('renderAttribution', () => {
  it('names the tracking issue when the nightly sweep already filed one', () => {
    const text = renderAttribution({
      verdict: PRE_EXISTING,
      baseRef: 'abc1234',
      trackingIssue: 4242,
    }).join('\n');
    assert.match(text, /PRE-EXISTING/);
    assert.match(text, /#4242/);
    assert.match(text, /still fails/i);
  });

  it('omits the reference cleanly when no issue is open', () => {
    const text = renderAttribution({
      verdict: PRE_EXISTING,
      trackingIssue: null,
    }).join('\n');
    assert.match(text, /PRE-EXISTING/);
    assert.doesNotMatch(text, /#\d+/);
  });

  it('an introduced verdict points at the version-range trap, not a force fix', () => {
    const text = renderAttribution({ verdict: INTRODUCED }).join('\n');
    assert.match(text, /INTRODUCED BY THIS DIFF/);
    assert.match(text, /version range/i);
  });
});

describe('runAttribution — every break degrades to unknown', () => {
  it('reports pre-existing and exits 1', () => {
    const h = harness({ baseFailed: true });
    const out = runAttribution(argv('--base', 'abc123'), h.deps);
    assert.equal(out.verdict, PRE_EXISTING);
    assert.equal(out.exitCode, 1);
    assert.match(h.log.info.join('\n'), /#7777/);
  });

  it('reports introduced-by-this-diff and exits 1', () => {
    const h = harness({ baseFailed: false });
    const out = runAttribution(argv('--base', 'abc123'), h.deps);
    assert.equal(out.verdict, INTRODUCED);
    assert.equal(out.exitCode, 1);
  });

  for (const [label, opts] of [
    ['an unresolvable merge base', { materializeThrows: 'bad object' }],
    ['a base lockfile that cannot be audited', { auditBaseThrows: 'ENOENT' }],
    ['a head audit that errors', { headThrows: 'npm exploded' }],
  ]) {
    it(`${label} degrades to unknown at exit 0`, () => {
      const h = harness(opts);
      const out = runAttribution(argv('--base', 'abc123'), h.deps);
      assert.equal(out.verdict, UNKNOWN);
      assert.equal(out.exitCode, 0);
      assert.match(out.lines.join('\n'), /UNKNOWN/);
    });
  }

  it('a missing --base is unknown, not a crash', () => {
    const h = harness();
    const out = runAttribution(argv(), h.deps);
    assert.equal(out.verdict, UNKNOWN);
    assert.equal(out.exitCode, 0);
    assert.equal(h.calls.materialize.length, 0);
  });

  it('a clean head reports unknown and never audits the base', () => {
    const h = harness({ headFailed: false });
    const out = runAttribution(argv('--base', 'abc123'), h.deps);
    assert.equal(out.verdict, UNKNOWN);
    assert.equal(h.calls.materialize.length, 0);
  });

  // The scratch tree is materialized under the OS temp root, never in the
  // job's working tree — but it must still be removed on the failure path.
  it('removes the scratch tree even when the base audit throws', () => {
    const h = harness({ auditBaseThrows: 'ENOENT' });
    runAttribution(argv('--base', 'abc123'), h.deps);
    assert.deepEqual(h.calls.cleanup, ['/tmp/fake-base']);
  });

  it('a failed tracking-issue lookup does not lose the verdict', () => {
    const h = harness({ baseFailed: true, lookupThrows: true });
    const out = runAttribution(argv('--base', 'abc123'), h.deps);
    assert.equal(out.verdict, PRE_EXISTING);
    assert.equal(out.exitCode, 1);
    assert.doesNotMatch(out.lines.join('\n'), /#\d+/);
  });

  it('--no-tracking-issue skips the lookup entirely', () => {
    const h = harness({ baseFailed: true, lookupThrows: true });
    const out = runAttribution(
      argv('--base', 'abc123', '--no-tracking-issue'),
      h.deps,
    );
    assert.equal(out.verdict, PRE_EXISTING);
  });
});

describe('parseArgs', () => {
  it('reads --base, --cwd and --no-tracking-issue', () => {
    const p = parseArgs(
      argv('--base', 'deadbee', '--cwd', '/repo', '--no-tracking-issue'),
    );
    assert.equal(p.base, 'deadbee');
    assert.equal(p.cwd, '/repo');
    assert.equal(p.trackingIssue, false);
  });
});
