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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseArgs,
  runAttribution,
} from '../.agents/scripts/check-audit-attribution.js';
import {
  attributionExitCode,
  deriveVerdict,
  diffAdvisories,
  extractBlockingAdvisories,
  renderAttribution,
  UNKNOWN,
} from '../.agents/scripts/lib/audit-attribution.js';

// The verdict strings are asserted as literals on purpose: they are printed
// verbatim into the CI log an operator reads, so a rename must break these
// tests rather than silently change what that log says.
const INTRODUCED = 'introduced-by-this-diff';
const PRE_EXISTING = 'pre-existing';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const argv = (...flags) => ['node', 'check-audit-attribution.js', ...flags];

/** Project a list of advisory ids onto the audit shape the probe consumes. */
function auditResult(ids) {
  return {
    failed: ids.length > 0,
    advisories: ids.map((id) => ({ id, severity: 'high', title: id })),
  };
}

function harness({
  headFailed = true,
  baseFailed = false,
  headAdvisories = null,
  baseAdvisories = null,
  materializeThrows = null,
  auditBaseThrows = null,
  headThrows = null,
  trackingIssue = 7777,
  lookupThrows = false,
} = {}) {
  const log = { info: [], warn: [], error: [] };
  const calls = { cleanup: [], materialize: [], lookup: [] };
  // The booleans stay as sugar for the degradation cases; the advisory lists
  // are what the per-advisory diff actually reads.
  const head = headAdvisories ?? (headFailed ? ['advisory:A'] : []);
  const base = baseAdvisories ?? (baseFailed ? ['advisory:A'] : []);
  return {
    log,
    calls,
    deps: {
      git: () => '{}',
      auditHead: () => {
        if (headThrows) throw new Error(headThrows);
        return auditResult(head);
      },
      auditBase: () => {
        if (auditBaseThrows) throw new Error(auditBaseThrows);
        return auditResult(base);
      },
      materialize: (opts) => {
        calls.materialize.push(opts);
        if (materializeThrows) throw new Error(materializeThrows);
        return '/tmp/fake-base';
      },
      lookupTrackingIssue: (cwd) => {
        calls.lookup.push(cwd);
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

  // Story #5281 — this used to pass a flag the CLI did not parse, so it
  // asserted nothing about the flag: the run took the ordinary path and the
  // lookup's own failure was what kept the verdict. The flag is real now, and
  // the assertion is that the lookup does not run at all.
  it('--no-tracking-issue skips the lookup entirely', () => {
    const h = harness({ baseFailed: true });
    const out = runAttribution(
      argv('--base', 'abc123', '--no-tracking-issue'),
      h.deps,
    );
    assert.equal(out.verdict, PRE_EXISTING);
    assert.equal(out.exitCode, 1);
    assert.deepEqual(h.calls.lookup, []);
    assert.doesNotMatch(out.lines.join('\n'), /#7777/);
  });

  // AC-8: the shape a busy repository meets — a base already red for A, and a
  // diff that adds B. "The base failed too" is a true statement about A and a
  // misleading one about the branch.
  it('reports an added advisory as introduced while naming the pre-existing one', () => {
    const h = harness({
      headAdvisories: ['advisory:A', 'advisory:B'],
      baseAdvisories: ['advisory:A'],
    });
    const out = runAttribution(argv('--base', 'abc123'), h.deps);

    assert.equal(out.verdict, INTRODUCED);
    assert.equal(out.exitCode, 1);
    assert.deepEqual(
      out.introduced.map((a) => a.id),
      ['advisory:B'],
    );
    assert.deepEqual(
      out.preExisting.map((a) => a.id),
      ['advisory:A'],
    );
    const text = out.lines.join('\n');
    assert.match(text, /Introduced by this diff \(1\): advisory:B/);
    assert.match(text, /Already on the merge base \(1\): advisory:A/);
  });

  it('every head advisory already on the base stays pre-existing', () => {
    const h = harness({
      headAdvisories: ['advisory:A'],
      baseAdvisories: ['advisory:A', 'advisory:C'],
    });
    const out = runAttribution(argv('--base', 'abc123'), h.deps);
    assert.equal(out.verdict, PRE_EXISTING);
    assert.deepEqual(out.introduced, []);
  });
});

describe('extractBlockingAdvisories / diffAdvisories', () => {
  const report = {
    vulnerabilities: {
      'js-yaml': {
        name: 'js-yaml',
        severity: 'high',
        via: [
          { source: 1234, title: 'Prototype pollution', severity: 'high' },
          { source: 9, title: 'A moderate one', severity: 'moderate' },
        ],
      },
      lodash: { name: 'lodash', severity: 'moderate', via: ['js-yaml'] },
      // A transitive package whose `via` names packages, not advisories: it
      // still blocks, so it must still be counted.
      'transitive-dep': {
        name: 'transitive-dep',
        severity: 'critical',
        via: ['js-yaml'],
      },
    },
  };

  it('keeps only advisories at or above high, and never loses a blocking one', () => {
    assert.deepEqual(
      extractBlockingAdvisories(report).map((a) => a.id),
      ['advisory:1234', 'package:transitive-dep'],
    );
  });

  it('is empty for a clean or unreadable report', () => {
    assert.deepEqual(extractBlockingAdvisories({ vulnerabilities: {} }), []);
    assert.deepEqual(extractBlockingAdvisories(null), []);
  });

  it('a null base attributes nothing rather than accusing the diff', () => {
    assert.deepEqual(
      diffAdvisories({ head: [{ id: 'advisory:1' }], base: null }),
      { introduced: [], preExisting: [] },
    );
  });
});

describe('parseArgs', () => {
  it('reads --base and --cwd', () => {
    const p = parseArgs(argv('--base', 'deadbee', '--cwd', '/repo'));
    assert.equal(p.base, 'deadbee');
    assert.equal(p.cwd, '/repo');
    assert.equal(p.trackingIssue, true);
  });

  it('parses --no-tracking-issue', () => {
    assert.equal(
      parseArgs(argv('--base', 'deadbee', '--no-tracking-issue')).trackingIssue,
      false,
    );
  });
});

/**
 * The wiring is as load-bearing as the script. Three properties are asserted
 * against the committed workflow rather than eyeballed, because each one
 * silently degrades the gate if it drifts.
 */
describe('ci.yml wiring', () => {
  const ci = readFileSync(
    path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'),
    'utf8',
  );
  const scaStep = ci.slice(
    ci.indexOf('- name: Dependency Vulnerability Audit (SCA)'),
    ci.indexOf('- name: Attribute the advisory failure'),
  );

  // The nightly sweep copies this command verbatim so it and the required
  // check can never disagree about what counts as red. Wrapping it would
  // break that; attribution is a separate step for exactly this reason.
  it('leaves the required audit as the bare npm invocation', () => {
    assert.match(scaStep, /run: npm audit --audit-level=high\s*$/m);
  });

  // A pre-existing advisory must keep blocking, or advisories accumulate on
  // main — the failure the nightly sweep exists to prevent.
  it('does not let the required audit step continue on error', () => {
    assert.doesNotMatch(scaStep, /continue-on-error/);
  });

  it('runs attribution only after that step failed, and only for a PR', () => {
    const attrib = ci.slice(
      ci.indexOf('- name: Attribute the advisory failure'),
    );
    assert.match(attrib, /steps\.sca\.outcome == 'failure'/);
    assert.match(attrib, /github\.event_name == 'pull_request'/);
    assert.match(attrib, /check-audit-attribution\.js --base "\$BASE_SHA"/);
    // The probe reports; it must never be able to mask or compound the
    // audit's own verdict.
    assert.match(
      attrib.slice(0, attrib.indexOf('run:')),
      /continue-on-error: true/,
    );
  });
});
