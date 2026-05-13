import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  applyFloorPolicy,
  DEFAULT_FLOORS,
  formatViolation,
  loadFloorConfig,
} from '../../.agents/scripts/lib/quality-floors.js';

describe('quality-floors — loadFloorConfig', () => {
  /** @type {string} */
  let tmpDir;
  /** @type {string} */
  let agentrcPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-load-'));
    agentrcPath = path.join(tmpDir, '.agentrc.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns documented defaults when the file is missing', () => {
    const cfg = loadFloorConfig(path.join(tmpDir, 'nope.json'));
    assert.equal(cfg.maintainability, 70);
    assert.equal(cfg.crap, 20);
    assert.deepEqual(cfg.coverage, { lines: 90, branches: 85, functions: 90 });
  });

  it('returns documented defaults when qualityFloors block is absent', () => {
    fs.writeFileSync(agentrcPath, JSON.stringify({ agentSettings: {} }));
    const cfg = loadFloorConfig(agentrcPath);
    assert.equal(cfg.maintainability, DEFAULT_FLOORS.maintainability);
    assert.equal(cfg.crap, DEFAULT_FLOORS.crap);
    assert.deepEqual(cfg.coverage, DEFAULT_FLOORS.coverage);
  });

  it('layers explicit values over the defaults', () => {
    fs.writeFileSync(
      agentrcPath,
      JSON.stringify({
        agentSettings: {
          quality: {
            qualityFloors: {
              coverage: { lines: 95 },
              maintainability: 75,
              crap: 15,
            },
          },
        },
      }),
    );
    const cfg = loadFloorConfig(agentrcPath);
    assert.equal(cfg.coverage.lines, 95);
    assert.equal(cfg.coverage.branches, 85); // default preserved
    assert.equal(cfg.coverage.functions, 90); // default preserved
    assert.equal(cfg.maintainability, 75);
    assert.equal(cfg.crap, 15);
  });

  it('throws on unknown top-level axes', () => {
    fs.writeFileSync(
      agentrcPath,
      JSON.stringify({
        agentSettings: { quality: { qualityFloors: { lint: 9 } } },
      }),
    );
    assert.throws(() => loadFloorConfig(agentrcPath), /unknown axis "lint"/);
  });

  it('throws on unknown coverage sub-axes', () => {
    fs.writeFileSync(
      agentrcPath,
      JSON.stringify({
        agentSettings: {
          quality: { qualityFloors: { coverage: { statements: 90 } } },
        },
      }),
    );
    assert.throws(
      () => loadFloorConfig(agentrcPath),
      /unknown axis "statements"/,
    );
  });

  it('throws when maintainability is out of range', () => {
    fs.writeFileSync(
      agentrcPath,
      JSON.stringify({
        agentSettings: { quality: { qualityFloors: { maintainability: 150 } } },
      }),
    );
    assert.throws(
      () => loadFloorConfig(agentrcPath),
      /qualityFloors\.maintainability/,
    );
  });

  it('throws when crap is negative', () => {
    fs.writeFileSync(
      agentrcPath,
      JSON.stringify({
        agentSettings: { quality: { qualityFloors: { crap: -1 } } },
      }),
    );
    assert.throws(() => loadFloorConfig(agentrcPath), /qualityFloors\.crap/);
  });
});

describe('quality-floors — applyFloorPolicy coverage', () => {
  const floors = {
    coverage: { lines: 90, branches: 85, functions: 90 },
    maintainability: 70,
    crap: 20,
  };

  it('passes records that clear every axis', () => {
    const { violations, passed } = applyFloorPolicy(
      [{ file: 'a.js', lines: 95, branches: 90, functions: 92 }],
      floors,
      'coverage',
    );
    assert.equal(violations.length, 0);
    assert.equal(passed.length, 1);
    assert.equal(passed[0].file, 'a.js');
  });

  it('flags one violation per failing axis', () => {
    const { violations } = applyFloorPolicy(
      [{ file: 'b.js', lines: 80, branches: 70, functions: 95 }],
      floors,
      'coverage',
    );
    assert.equal(violations.length, 2);
    const axes = violations.map((v) => v.axis).sort();
    assert.deepEqual(axes, ['branches', 'lines']);
    for (const v of violations) {
      assert.equal(v.scope, 'coverage');
      assert.equal(v.file, 'b.js');
      assert.equal(v.reason, 'below-floor');
    }
  });

  it('routes malformed records to violations with invalid-record', () => {
    const { violations, passed } = applyFloorPolicy(
      [{ file: 'c.js', lines: 'NaN' }],
      floors,
      'coverage',
    );
    assert.equal(passed.length, 0);
    assert.ok(violations.length >= 1);
    assert.ok(violations.some((v) => v.reason === 'invalid-record'));
  });
});

describe('quality-floors — applyFloorPolicy maintainability', () => {
  const floors = { ...DEFAULT_FLOORS };

  it('flags records below the MI floor', () => {
    const { violations, passed } = applyFloorPolicy(
      [
        { file: 'lo.js', mi: 65.4 },
        { file: 'hi.js', mi: 88.1 },
      ],
      floors,
      'maintainability',
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, 'lo.js');
    assert.equal(violations[0].reason, 'below-floor');
    assert.equal(passed.length, 1);
    assert.equal(passed[0].file, 'hi.js');
  });

  it('does not throw when mi is missing', () => {
    const { violations } = applyFloorPolicy(
      [{ file: 'oops.js' }],
      floors,
      'maintainability',
    );
    assert.ok(violations.some((v) => v.reason === 'invalid-record'));
  });
});

describe('quality-floors — applyFloorPolicy crap', () => {
  const floors = { ...DEFAULT_FLOORS };

  it('flags methods above the CRAP ceiling', () => {
    const { violations, passed } = applyFloorPolicy(
      [
        { file: 'x.js', method: 'a', score: 5 },
        { file: 'x.js', method: 'b', score: 30 },
      ],
      floors,
      'crap',
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].method, 'b');
    assert.equal(violations[0].reason, 'above-ceiling');
    assert.equal(passed.length, 1);
    assert.equal(passed[0].method, 'a');
  });

  it('returns invalid-scope for an unknown scope without throwing', () => {
    const { violations, passed } = applyFloorPolicy(
      [{ file: 'x.js' }],
      floors,
      'bogus',
    );
    assert.equal(passed.length, 0);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].reason, 'invalid-scope');
  });

  it('returns invalid-records when records is not an array', () => {
    const { violations } = applyFloorPolicy(null, floors, 'crap');
    assert.equal(violations[0].reason, 'invalid-records');
  });
});

describe('quality-floors — formatViolation', () => {
  it('formats a coverage violation', () => {
    const s = formatViolation({
      scope: 'coverage',
      reason: 'below-floor',
      file: 'a.js',
      axis: 'lines',
      observed: 82.5,
      floor: 90,
    });
    assert.match(s, /a\.js: lines 82\.50% < floor 90%/);
  });

  it('formats a maintainability violation', () => {
    const s = formatViolation({
      scope: 'maintainability',
      reason: 'below-floor',
      file: 'b.js',
      observed: 65.1,
      floor: 70,
    });
    assert.match(s, /b\.js: MI 65\.10 < floor 70/);
  });

  it('formats a CRAP violation', () => {
    const s = formatViolation({
      scope: 'crap',
      reason: 'above-ceiling',
      file: 'c.js',
      method: 'fn',
      observed: 32.0,
      floor: 20,
    });
    assert.match(s, /c\.js:fn: CRAP 32\.00 > ceiling 20/);
  });
});
