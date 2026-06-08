import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  QA_REPORT_DIRNAME,
  renderCoverageReport,
  reportPathFor,
  writeCoverageReport,
} from '../../../.agents/scripts/lib/qa/coverage-report.js';
import { acceptanceMatrix } from '../../../.agents/scripts/lib/qa/coverage-verdict.js';

/**
 * Unit tests for `lib/qa/coverage-report.js` — renders the AC × test-tier
 * matrix produced by `coverage-verdict.js#acceptanceMatrix` to a markdown
 * report and persists it under `<tempRoot>/qa/`. `renderCoverageReport` and
 * `reportPathFor` are pure; `writeCoverageReport` does filesystem I/O against
 * a real temp dir created/torn-down per test, so this stays a unit-tier suite
 * per `.agents/rules/testing-standards.md`.
 */

const SAMPLE_CRITERIA = [
  {
    id: 'AC-1',
    label: 'parses the row',
    symbol: 'parseRow',
    tests: ['src/parse-row.test.js'],
  },
  {
    id: 'AC-2',
    label: 'renders | the report',
    surface: {
      symbol: 'renderReport',
      tests: [
        'src/render.test.js',
        'tests/contract/render.test.js',
        'tests/features/render.feature',
      ],
    },
  },
];

describe('renderCoverageReport', () => {
  it('renders a markdown report with a title, matrix table, and notes', () => {
    // Arrange / Act
    const md = renderCoverageReport(SAMPLE_CRITERIA);

    // Assert — structure.
    assert.match(md, /^# QA Coverage — AC × Test-Tier Matrix/);
    assert.match(
      md,
      /\| Acceptance Criterion \| Unit \| Contract \| Acceptance \|/,
    );
    assert.match(md, /## Notes/);
    // One body row per criterion.
    assert.match(md, /\| AC-1: parses the row \|/);
    assert.match(md, /\| AC-2: renders/);
  });

  it('shows present and absent verdicts per tier', () => {
    const md = renderCoverageReport(SAMPLE_CRITERIA);
    // AC-1 is unit-only: unit present, contract + acceptance absent.
    const ac1Row = md.split('\n').find((line) => line.startsWith('| AC-1:'));
    assert.ok(ac1Row, 'AC-1 row should exist');
    assert.match(ac1Row, /present/);
    assert.match(ac1Row, /absent/);
  });

  it('summarizes how many criteria are fully covered', () => {
    const md = renderCoverageReport(SAMPLE_CRITERIA);
    // AC-2 is covered at all three tiers; AC-1 is not.
    assert.match(
      md,
      /2 acceptance criteria, 1 fully covered across all 3 tiers\./,
    );
  });

  it('escapes pipe characters in a label so the table stays well-formed', () => {
    const md = renderCoverageReport(SAMPLE_CRITERIA);
    // The literal pipe in "renders | the report" must be escaped.
    assert.match(md, /renders \\\| the report/);
  });

  it('accepts a pre-built matrix as well as raw criteria', () => {
    const matrix = acceptanceMatrix(SAMPLE_CRITERIA);
    const fromMatrix = renderCoverageReport(matrix);
    const fromCriteria = renderCoverageReport(SAMPLE_CRITERIA);
    assert.equal(fromMatrix, fromCriteria);
  });

  it('includes a generated-at line when provided', () => {
    const md = renderCoverageReport(SAMPLE_CRITERIA, {
      generatedAt: '2026-06-08T00:00:00.000Z',
    });
    assert.match(md, /_Generated: 2026-06-08T00:00:00\.000Z_/);
  });

  it('handles an empty criteria list', () => {
    const md = renderCoverageReport([]);
    assert.match(md, /0 acceptance criteria, 0 fully covered/);
  });
});

describe('reportPathFor', () => {
  it('resolves under <tempRoot>/qa/ with a default file name', () => {
    const p = reportPathFor(undefined, {
      project: { paths: { tempRoot: 'temp' } },
    });
    const segments = p.split(/[\\/]/);
    assert.equal(segments.at(-2), QA_REPORT_DIRNAME);
    assert.equal(segments.at(-1), 'coverage-report.md');
  });

  it('honors a custom file name', () => {
    const p = reportPathFor('run-42.md', {
      project: { paths: { tempRoot: 'temp' } },
    });
    assert.equal(p.split(/[\\/]/).at(-1), 'run-42.md');
  });

  it('rejects a file name containing path separators', () => {
    assert.throws(() => reportPathFor('../escape.md'), /path separators/);
    assert.throws(() => reportPathFor('sub/dir.md'), /path separators/);
  });
});

describe('writeCoverageReport', () => {
  let tmpDir;
  let config;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-coverage-report-'));
    config = { project: { paths: { tempRoot: tmpDir } } };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes the rendered markdown under <tempRoot>/qa/ and returns the path', () => {
    // Act
    const { path: reportPath, markdown } = writeCoverageReport(
      SAMPLE_CRITERIA,
      {
        config,
      },
    );

    // Assert — file landed under the qa/ dir and content round-trips.
    assert.equal(
      path.dirname(reportPath),
      path.join(tmpDir, QA_REPORT_DIRNAME),
    );
    const onDisk = fs.readFileSync(reportPath, 'utf8');
    assert.equal(onDisk, markdown);
    assert.match(onDisk, /# QA Coverage/);
  });

  it('creates the qa/ directory if it does not yet exist', () => {
    const qaDir = path.join(tmpDir, QA_REPORT_DIRNAME);
    assert.equal(fs.existsSync(qaDir), false);
    writeCoverageReport(SAMPLE_CRITERIA, { config });
    assert.equal(fs.existsSync(qaDir), true);
  });

  it('uses an injected fsImpl when provided', () => {
    // Arrange — capture the write without touching the real filesystem.
    const calls = { mkdir: [], write: [] };
    const fsImpl = {
      mkdirSync: (dir, opts) => calls.mkdir.push([dir, opts]),
      writeFileSync: (file, data, enc) => calls.write.push([file, data, enc]),
    };

    // Act
    const { path: reportPath, markdown } = writeCoverageReport(
      SAMPLE_CRITERIA,
      {
        config,
        fsImpl,
      },
    );

    // Assert
    assert.equal(calls.mkdir.length, 1);
    assert.equal(calls.write.length, 1);
    assert.equal(calls.write[0][0], reportPath);
    assert.equal(calls.write[0][1], markdown);
    assert.equal(calls.write[0][2], 'utf8');
  });
});
