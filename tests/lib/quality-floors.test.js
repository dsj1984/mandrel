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

describe('quality-floors — loadFloorConfig (workspace-keyed floors)', () => {
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

  /** Build a gate-shaped config snippet for the test fixtures. */
  function gates(block) {
    return { delivery: { quality: { gates: block } } };
  }

  it('returns documented defaults when the file is missing', () => {
    const cfg = loadFloorConfig(path.join(tmpDir, 'nope.json'));
    assert.equal(cfg.maintainability, 70);
    assert.equal(cfg.crap, 20);
    assert.deepEqual(cfg.coverage, { lines: 90, branches: 85, functions: 90 });
  });

  it('returns documented defaults when the gates block is absent', () => {
    fs.writeFileSync(agentrcPath, JSON.stringify({ delivery: {} }));
    const cfg = loadFloorConfig(agentrcPath);
    assert.equal(cfg.maintainability, DEFAULT_FLOORS.maintainability);
    assert.equal(cfg.crap, DEFAULT_FLOORS.crap);
    assert.deepEqual(cfg.coverage, DEFAULT_FLOORS.coverage);
  });

  it('layers explicit values over the defaults', () => {
    fs.writeFileSync(
      agentrcPath,
      JSON.stringify(
        gates({
          coverage: { floors: { '*': { lines: 95 } } },
          maintainability: { floors: { '*': { maintainability: 75 } } },
          crap: { floors: { '*': { crap: 15 } } },
        }),
      ),
    );
    const cfg = loadFloorConfig(agentrcPath);
    assert.equal(cfg.coverage.lines, 95);
    assert.equal(cfg.coverage.branches, 85); // default preserved
    assert.equal(cfg.coverage.functions, 90); // default preserved
    assert.equal(cfg.maintainability, 75);
    assert.equal(cfg.crap, 15);
  });

  it('honours a per-workspace override over the catch-all', () => {
    fs.writeFileSync(
      agentrcPath,
      JSON.stringify(
        gates({
          coverage: {
            floors: {
              '*': { lines: 90 },
              'packages/web': { lines: 80 },
            },
          },
        }),
      ),
    );
    const cfg = loadFloorConfig(agentrcPath, { workspace: 'packages/web' });
    assert.equal(cfg.coverage.lines, 80);
  });

  it('falls back to the catch-all when the workspace is undeclared', () => {
    fs.writeFileSync(
      agentrcPath,
      JSON.stringify(gates({ coverage: { floors: { '*': { lines: 87 } } } })),
    );
    const cfg = loadFloorConfig(agentrcPath, { workspace: 'packages/api' });
    assert.equal(cfg.coverage.lines, 87);
  });

  it('throws on unknown coverage sub-axes inside the workspace bag', () => {
    fs.writeFileSync(
      agentrcPath,
      JSON.stringify(
        gates({ coverage: { floors: { '*': { statements: 90 } } } }),
      ),
    );
    assert.throws(
      () => loadFloorConfig(agentrcPath),
      /unknown axis "statements"/,
    );
  });

  it('throws on the legacy flat scalar shape', () => {
    fs.writeFileSync(
      agentrcPath,
      JSON.stringify(
        gates({ coverage: { floors: { lines: 90, branches: 85 } } }),
      ),
    );
    assert.throws(
      () => loadFloorConfig(agentrcPath),
      /must point to an object/,
    );
  });

  it('throws when maintainability is out of range', () => {
    fs.writeFileSync(
      agentrcPath,
      JSON.stringify(
        gates({
          maintainability: { floors: { '*': { maintainability: 150 } } },
        }),
      ),
    );
    assert.throws(
      () => loadFloorConfig(agentrcPath),
      /qualityFloors\.maintainability/,
    );
  });

  it('throws when crap is negative', () => {
    fs.writeFileSync(
      agentrcPath,
      JSON.stringify(gates({ crap: { floors: { '*': { crap: -1 } } } })),
    );
    assert.throws(() => loadFloorConfig(agentrcPath), /qualityFloors\.crap/);
  });
});

describe('quality-floors — loadFloorConfig (path overrides)', () => {
  /** @type {string} */
  let tmpDir;
  /** @type {string} */
  let agentrcPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-paths-'));
    agentrcPath = path.join(tmpDir, '.agentrc.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function gates(block) {
    return { delivery: { quality: { gates: block } } };
  }

  it('seeds an empty pathOverrides Map when no overrides are configured', () => {
    const cfg = loadFloorConfig(path.join(tmpDir, 'nope.json'));
    assert.ok(cfg.pathOverrides instanceof Map);
    assert.equal(cfg.pathOverrides.size, 0);
  });

  it('parses a coverage path override and returns it in pathOverrides', () => {
    fs.writeFileSync(
      agentrcPath,
      JSON.stringify(
        gates({
          coverage: {
            floors: {
              '*': { lines: 90 },
              paths: {
                'src/example.js': { lines: 80, follow_up: '#1' },
              },
            },
          },
        }),
      ),
    );
    const cfg = loadFloorConfig(agentrcPath);
    assert.equal(cfg.coverage.lines, 90); // workspace untouched
    assert.equal(cfg.pathOverrides.size, 1);
    const ov = cfg.pathOverrides.get('src/example.js');
    assert.ok(ov);
    assert.equal(ov.lines, 80);
    assert.equal(ov.follow_up, '#1');
  });

  it('throws when follow_up is missing on a path override', () => {
    fs.writeFileSync(
      agentrcPath,
      JSON.stringify(
        gates({
          coverage: {
            floors: {
              '*': { lines: 90 },
              paths: { 'src/example.js': { lines: 80 } },
            },
          },
        }),
      ),
    );
    assert.throws(() => loadFloorConfig(agentrcPath), /follow_up/);
  });

  it('throws when follow_up is malformed', () => {
    fs.writeFileSync(
      agentrcPath,
      JSON.stringify(
        gates({
          coverage: {
            floors: {
              '*': { lines: 90 },
              paths: {
                'src/example.js': { lines: 80, follow_up: 'not-an-issue' },
              },
            },
          },
        }),
      ),
    );
    assert.throws(
      () => loadFloorConfig(agentrcPath),
      /invalid follow_up/,
    );
  });

  it('throws when a path override carries an unknown axis', () => {
    fs.writeFileSync(
      agentrcPath,
      JSON.stringify(
        gates({
          coverage: {
            floors: {
              '*': { lines: 90 },
              paths: {
                'src/example.js': { statements: 80, follow_up: '#1' },
              },
            },
          },
        }),
      ),
    );
    assert.throws(
      () => loadFloorConfig(agentrcPath),
      /unknown axis "statements"/,
    );
  });

  it('normalises backslash path keys to forward slashes', () => {
    fs.writeFileSync(
      agentrcPath,
      JSON.stringify(
        gates({
          maintainability: {
            floors: {
              '*': { maintainability: 70 },
              paths: {
                'src\\foo\\bar.js': { maintainability: 50, follow_up: '#9' },
              },
            },
          },
        }),
      ),
    );
    const cfg = loadFloorConfig(agentrcPath);
    assert.equal(cfg.pathOverrides.size, 1);
    assert.ok(cfg.pathOverrides.has('src/foo/bar.js'));
  });

  it('rejects absolute paths in path-override keys', () => {
    fs.writeFileSync(
      agentrcPath,
      JSON.stringify(
        gates({
          crap: {
            floors: {
              '*': { crap: 20 },
              paths: {
                '/etc/foo.js': { crap: 30, follow_up: '#1' },
              },
            },
          },
        }),
      ),
    );
    assert.throws(() => loadFloorConfig(agentrcPath), /repo-relative/);
  });

  it('accepts a URL follow_up reference', () => {
    fs.writeFileSync(
      agentrcPath,
      JSON.stringify(
        gates({
          crap: {
            floors: {
              '*': { crap: 20 },
              paths: {
                'src/foo.js': {
                  crap: 30,
                  follow_up: 'https://example.com/track/1',
                },
              },
            },
          },
        }),
      ),
    );
    const cfg = loadFloorConfig(agentrcPath);
    assert.equal(
      cfg.pathOverrides.get('src/foo.js').follow_up,
      'https://example.com/track/1',
    );
  });

  it('preserves coverage / maintainability / crap fields for existing consumers', () => {
    fs.writeFileSync(
      agentrcPath,
      JSON.stringify(
        gates({
          coverage: {
            floors: {
              '*': { lines: 95 },
              paths: { 'src/a.js': { lines: 80, follow_up: '#1' } },
            },
          },
        }),
      ),
    );
    const { coverage, maintainability, crap } = loadFloorConfig(agentrcPath);
    assert.equal(coverage.lines, 95);
    assert.equal(maintainability, 70);
    assert.equal(crap, 20);
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
