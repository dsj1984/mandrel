/**
 * mandrel-update-preflight.test.js — Unit tests for the first-run preflight
 * wired ahead of the `/mandrel-update` workflow under Story #4170.
 *
 * The Story's acceptance criteria are:
 *   1. Consumer-shape check: package.json lists `mandrel` AND `.agents/`
 *      exists; otherwise hard-stop (blocker).
 *   2. Dirty-index warning when the git index already has staged changes.
 *   3. Offline warning when the npm registry is unreachable.
 *   4. Severity: consumer-shape is a hard stop; dirty-index and offline
 *      are warn-only.
 *
 * The tests drive the exported pure `runMandrelUpdatePreflight` helper with
 * an inline fixture probe set so no real FS / git / network is touched, and
 * cover the `reportPreflight` rendering + severity routing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  reportPreflight,
  runMandrelUpdatePreflight,
} from '../.agents/scripts/mandrel-update-preflight.js';

/** A healthy consumer project: all checks pass. */
const healthyProbes = {
  readPackageJson: () => ({ devDependencies: { mandrel: '^1.68.0' } }),
  agentsDirExists: () => true,
  hasStagedChanges: () => false,
  registryReachable: () => true,
};

/** Build a probe set by overriding the healthy defaults. */
function probes(overrides = {}) {
  return { ...healthyProbes, ...overrides };
}

/** Capture spy logger — records every level. */
function makeLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    info: (...a) => lines.info.push(a.join(' ')),
    warn: (...a) => lines.warn.push(a.join(' ')),
    error: (...a) => lines.error.push(a.join(' ')),
    _lines: lines,
  };
}

function findingById(result, id) {
  return result.findings.find((f) => f.id === id);
}

describe('runMandrelUpdatePreflight — consumer-shape (blocker)', () => {
  it('passes clean on a healthy consumer project', () => {
    const result = runMandrelUpdatePreflight({ probes: probes() });
    assert.equal(result.ok, true);
    assert.equal(result.blocked, false);
    assert.deepEqual(result.findings, []);
  });

  it('hard-stops when package.json is missing/unreadable', () => {
    const result = runMandrelUpdatePreflight({
      probes: probes({ readPackageJson: () => null }),
    });
    assert.equal(result.blocked, true);
    assert.equal(result.ok, false);
    const f = findingById(result, 'consumer-shape');
    assert.equal(f.severity, 'blocker');
    assert.match(f.summary, /package\.json/);
  });

  it('hard-stops when "mandrel" is not a dependency', () => {
    const result = runMandrelUpdatePreflight({
      probes: probes({
        readPackageJson: () => ({ dependencies: { other: '1.0.0' } }),
      }),
    });
    assert.equal(result.blocked, true);
    const f = findingById(result, 'consumer-shape');
    assert.equal(f.severity, 'blocker');
    assert.match(f.summary, /"mandrel"/);
  });

  it('accepts "mandrel" in dependencies (not just devDependencies)', () => {
    const result = runMandrelUpdatePreflight({
      probes: probes({
        readPackageJson: () => ({ dependencies: { mandrel: '^1.0.0' } }),
      }),
    });
    assert.equal(result.blocked, false);
    assert.equal(findingById(result, 'consumer-shape'), undefined);
  });

  it('hard-stops when .agents/ is absent even if mandrel is a dep', () => {
    const result = runMandrelUpdatePreflight({
      probes: probes({ agentsDirExists: () => false }),
    });
    assert.equal(result.blocked, true);
    const f = findingById(result, 'consumer-shape');
    assert.equal(f.severity, 'blocker');
    assert.match(f.summary, /\.agents\//);
  });
});

describe('runMandrelUpdatePreflight — dirty-index (warn-only)', () => {
  it('warns when the index has staged changes, but does not block', () => {
    const result = runMandrelUpdatePreflight({
      probes: probes({ hasStagedChanges: () => true }),
    });
    assert.equal(result.blocked, false);
    assert.equal(result.ok, false);
    const f = findingById(result, 'dirty-index');
    assert.equal(f.severity, 'warning');
    assert.match(f.summary, /staged/);
    assert.match(f.fix, /git restore --staged|git reset/);
  });

  it('does not fire when the index is clean', () => {
    const result = runMandrelUpdatePreflight({ probes: probes() });
    assert.equal(findingById(result, 'dirty-index'), undefined);
  });
});

describe('runMandrelUpdatePreflight — offline (warn-only)', () => {
  it('warns when the registry is unreachable, but does not block', () => {
    const result = runMandrelUpdatePreflight({
      probes: probes({ registryReachable: () => false }),
    });
    assert.equal(result.blocked, false);
    assert.equal(result.ok, false);
    const f = findingById(result, 'offline');
    assert.equal(f.severity, 'warning');
    assert.match(f.summary, /registry/);
  });

  it('does not fire when the registry is reachable', () => {
    const result = runMandrelUpdatePreflight({ probes: probes() });
    assert.equal(findingById(result, 'offline'), undefined);
  });
});

describe('runMandrelUpdatePreflight — severity composition', () => {
  it('a blocker plus warnings still reports blocked:true', () => {
    const result = runMandrelUpdatePreflight({
      probes: probes({
        readPackageJson: () => null,
        hasStagedChanges: () => true,
        registryReachable: () => false,
      }),
    });
    assert.equal(result.blocked, true);
    assert.equal(result.findings.length, 3);
  });

  it('warnings without a blocker report blocked:false, ok:false', () => {
    const result = runMandrelUpdatePreflight({
      probes: probes({
        hasStagedChanges: () => true,
        registryReachable: () => false,
      }),
    });
    assert.equal(result.blocked, false);
    assert.equal(result.ok, false);
    assert.equal(result.findings.length, 2);
  });
});

describe('reportPreflight — rendering + severity routing', () => {
  it('logs a single info line on a clean result', () => {
    const logger = makeLogger();
    reportPreflight({ ok: true, blocked: false, findings: [] }, logger);
    assert.equal(logger._lines.info.length, 1);
    assert.equal(logger._lines.warn.length, 0);
    assert.equal(logger._lines.error.length, 0);
  });

  it('routes blockers to error and warnings to warn', () => {
    const logger = makeLogger();
    const result = runMandrelUpdatePreflight({
      probes: probes({
        readPackageJson: () => null,
        hasStagedChanges: () => true,
      }),
    });
    reportPreflight(result, logger);
    const errText = logger._lines.error.join('\n');
    const warnText = logger._lines.warn.join('\n');
    assert.match(errText, /consumer-shape/);
    assert.match(errText, /exit 2/);
    assert.match(warnText, /dirty-index/);
  });

  it('emits a warn-only summary when no blocker fired', () => {
    const logger = makeLogger();
    const result = runMandrelUpdatePreflight({
      probes: probes({ registryReachable: () => false }),
    });
    reportPreflight(result, logger);
    assert.equal(logger._lines.error.length, 0);
    const warnText = logger._lines.warn.join('\n');
    assert.match(warnText, /Warnings only/);
  });
});
