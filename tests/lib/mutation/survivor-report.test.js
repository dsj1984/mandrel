import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACTIONABLE_STATUSES,
  enumerateSurvivors,
} from '../../../.agents/scripts/lib/mutation/survivor-report.js';

/**
 * Story #3428. Unit coverage for the survivor-report helper. All fixtures
 * are inline plain objects (the parsed shape of a Stryker JSON report) so
 * the suite never touches the filesystem or a real Stryker run.
 */

function mutant(status, overrides = {}) {
  return {
    id: overrides.id ?? `${status}-1`,
    mutatorName: overrides.mutatorName ?? 'ConditionalExpression',
    status,
    location: overrides.location ?? {
      start: { line: 1, column: 1 },
      end: { line: 1, column: 9 },
    },
    ...overrides,
  };
}

describe('mutation/survivor-report — enumerateSurvivors guards', () => {
  it('rejects a non-object report', () => {
    // Arrange / Act
    const result = enumerateSurvivors(null);

    // Assert
    assert.deepEqual(result, {
      ok: false,
      error: 'Stryker report must be a JSON object',
    });
  });

  it('rejects an array report', () => {
    const result = enumerateSurvivors([]);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Stryker report must be a JSON object');
  });

  it("rejects a report missing the 'files' map", () => {
    const result = enumerateSurvivors({ metrics: { mutationScore: 90 } });
    assert.deepEqual(result, {
      ok: false,
      error: "Stryker report missing 'files' map",
    });
  });

  it("rejects a report whose 'files' is an array", () => {
    const result = enumerateSurvivors({ files: [] });
    assert.equal(result.ok, false);
    assert.equal(result.error, "Stryker report missing 'files' map");
  });
});

describe('mutation/survivor-report — enumerateSurvivors enumeration', () => {
  it('enumerates Survived and NoCoverage mutants per file', () => {
    // Arrange
    const report = {
      files: {
        'src/a.js': {
          mutants: [
            mutant('Killed', { id: 'k1' }),
            mutant('Survived', { id: 's1', location: { start: { line: 4 } } }),
            mutant('NoCoverage', {
              id: 'n1',
              location: { start: { line: 9 } },
            }),
          ],
        },
      },
    };

    // Act
    const result = enumerateSurvivors(report);

    // Assert
    assert.equal(result.ok, true);
    assert.equal(result.files.length, 1);
    const file = result.files[0];
    assert.equal(file.file, 'src/a.js');
    assert.equal(file.survived.length, 1);
    assert.equal(file.survived[0].id, 's1');
    assert.equal(file.survived[0].line, 4);
    assert.equal(file.noCoverage.length, 1);
    assert.equal(file.noCoverage[0].id, 'n1');
    assert.equal(file.noCoverage[0].line, 9);
    assert.equal(file.count, 2);
  });

  it('excludes Killed, Timeout, CompileError, and RuntimeError mutants', () => {
    const report = {
      files: {
        'src/a.js': {
          mutants: [
            mutant('Killed'),
            mutant('Timeout'),
            mutant('CompileError'),
            mutant('RuntimeError'),
          ],
        },
      },
    };

    const result = enumerateSurvivors(report);

    assert.equal(result.ok, true);
    assert.equal(result.files.length, 0);
    assert.deepEqual(result.totals, {
      survived: 0,
      noCoverage: 0,
      actionable: 0,
      files: 0,
    });
  });

  it('omits files that have no actionable survivors', () => {
    const report = {
      files: {
        'src/clean.js': { mutants: [mutant('Killed'), mutant('Killed')] },
        'src/leaky.js': { mutants: [mutant('Survived')] },
      },
    };

    const result = enumerateSurvivors(report);

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].file, 'src/leaky.js');
  });

  it('sorts files by descending actionable count, ties broken by path', () => {
    const report = {
      files: {
        'src/b.js': { mutants: [mutant('Survived')] },
        'src/a.js': { mutants: [mutant('Survived')] },
        'src/c.js': {
          mutants: [mutant('Survived'), mutant('NoCoverage')],
        },
      },
    };

    const result = enumerateSurvivors(report);

    // c.js (count 2) first; a.js and b.js (count 1) sorted by path.
    assert.deepEqual(
      result.files.map((f) => f.file),
      ['src/c.js', 'src/a.js', 'src/b.js'],
    );
  });

  it('aggregates totals across multiple files', () => {
    const report = {
      files: {
        'src/a.js': {
          mutants: [mutant('Survived'), mutant('NoCoverage')],
        },
        'src/b.js': {
          mutants: [mutant('Survived'), mutant('Survived')],
        },
      },
    };

    const result = enumerateSurvivors(report);

    assert.deepEqual(result.totals, {
      survived: 3,
      noCoverage: 1,
      actionable: 4,
      files: 2,
    });
  });

  it('returns an empty enumeration for an empty files map', () => {
    const result = enumerateSurvivors({ files: {} });
    assert.deepEqual(result, {
      ok: true,
      totals: { survived: 0, noCoverage: 0, actionable: 0, files: 0 },
      files: [],
    });
  });

  it('skips file entries with no mutants array', () => {
    const report = {
      files: {
        'src/a.js': { language: 'javascript' },
        'src/b.js': { mutants: [mutant('Survived')] },
      },
    };

    const result = enumerateSurvivors(report);

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].file, 'src/b.js');
  });

  it('tolerates mutants with a missing or malformed location', () => {
    const report = {
      files: {
        'src/a.js': {
          mutants: [
            { id: 's1', status: 'Survived' },
            { id: 's2', status: 'Survived', location: 'nope' },
            { id: 's3', status: 'Survived', location: { start: {} } },
          ],
        },
      },
    };

    const result = enumerateSurvivors(report);

    assert.equal(result.files[0].survived.length, 3);
    for (const m of result.files[0].survived) {
      assert.equal('line' in m, false);
    }
  });

  it('exposes the actionable status allowlist', () => {
    assert.deepEqual([...ACTIONABLE_STATUSES], ['Survived', 'NoCoverage']);
  });
});
