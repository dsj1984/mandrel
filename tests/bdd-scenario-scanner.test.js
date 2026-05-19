import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { resolveFeatureRoots } from '../.agents/scripts/lib/bdd-runner-detect.js';
import {
  extractOutcomeKeywords,
  findBestScenarioMatch,
  parseFeatureBody,
  scanBddScenarios,
  scoreMatch,
} from '../.agents/scripts/lib/bdd-scenario-scanner.js';

/**
 * Story #2637 — BDD scenario cross-reference scanner.
 *
 * The Acceptance Engineer step in /epic-plan Phase 7 reads the scanner
 * output to annotate planned ACs with matching existing scenarios. The
 * scanner is deterministic, conservative on match scoring, and silent
 * when the project has no .feature files.
 */

function mkFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bdd-scanner-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('resolveFeatureRoots — canonical probe', () => {
  it('returns empty when no canonical directory exists', () => {
    const { dir, cleanup } = mkFixture();
    try {
      const roots = resolveFeatureRoots({ cwd: dir });
      assert.deepEqual(roots, []);
    } finally {
      cleanup();
    }
  });

  it('detects tests/features when present', () => {
    const { dir, cleanup } = mkFixture();
    try {
      mkdirSync(path.join(dir, 'tests', 'features'), { recursive: true });
      const roots = resolveFeatureRoots({ cwd: dir });
      assert.equal(roots.length, 1);
      assert.ok(roots[0].endsWith(path.join('tests', 'features')));
    } finally {
      cleanup();
    }
  });
});

describe('extractOutcomeKeywords — tokeniser', () => {
  it('strips stop words and lowercases', () => {
    const out = extractOutcomeKeywords('The invoice appears in the outbox');
    assert.deepEqual(out.sort(), ['appears', 'invoice', 'outbox']);
  });

  it('returns an empty array for empty input', () => {
    assert.deepEqual(extractOutcomeKeywords(''), []);
    assert.deepEqual(extractOutcomeKeywords(null), []);
  });

  it('dedupes repeated tokens', () => {
    const out = extractOutcomeKeywords('login login success success');
    assert.deepEqual(out.sort(), ['login', 'success']);
  });
});

describe('parseFeatureBody — single-file parser', () => {
  it('extracts each scenario with its line number, tags, and Then keywords', () => {
    const body = [
      'Feature: Login',
      '',
      '  Background:',
      '    Given the app is running',
      '',
      '  @smoke @auth',
      '  Scenario: Login succeeds with valid credentials',
      '    Given a registered user',
      '    When they submit valid credentials',
      '    Then the dashboard appears',
      '    And a welcome banner is shown',
      '',
      '  Scenario: Login fails on bad credentials',
      '    Given a registered user',
      '    When they submit a bad password',
      '    Then an error banner appears',
    ].join('\n');

    const scenarios = parseFeatureBody(body);
    assert.equal(scenarios.length, 2);

    assert.equal(
      scenarios[0].scenarioTitle,
      'Login succeeds with valid credentials',
    );
    assert.equal(scenarios[0].line, 7);
    assert.deepEqual(scenarios[0].tags.sort(), ['@auth', '@smoke']);
    assert.ok(scenarios[0].outcomeKeywords.includes('dashboard'));
    assert.ok(scenarios[0].outcomeKeywords.includes('banner'));

    assert.equal(scenarios[1].scenarioTitle, 'Login fails on bad credentials');
    assert.equal(scenarios[1].line, 13);
    assert.deepEqual(scenarios[1].tags, []);
    assert.ok(scenarios[1].outcomeKeywords.includes('error'));
  });

  it('returns empty for a body with no scenarios', () => {
    assert.deepEqual(parseFeatureBody('Feature: nothing'), []);
  });
});

describe('scanBddScenarios — directory walk', () => {
  it('returns an empty list when no feature roots exist', () => {
    const out = scanBddScenarios({ featureRoots: [] });
    assert.deepEqual(out, []);
  });

  it('walks a single feature tree and returns parsed scenarios', () => {
    const { dir, cleanup } = mkFixture();
    try {
      const featureDir = path.join(dir, 'tests', 'features');
      mkdirSync(featureDir, { recursive: true });
      writeFileSync(
        path.join(featureDir, 'login.feature'),
        [
          'Feature: Login',
          '  Scenario: Login succeeds',
          '    When the user logs in',
          '    Then the dashboard appears',
        ].join('\n'),
      );
      writeFileSync(
        path.join(featureDir, 'logout.feature'),
        [
          'Feature: Logout',
          '  Scenario: Logout clears session',
          '    Then the login screen appears',
        ].join('\n'),
      );
      const out = scanBddScenarios({ featureRoots: [featureDir] });
      assert.equal(out.length, 2);
      const titles = out.map((s) => s.scenarioTitle).sort();
      assert.deepEqual(titles, ['Login succeeds', 'Logout clears session']);
      for (const row of out) {
        assert.ok(row.file.endsWith('.feature'));
        assert.equal(typeof row.line, 'number');
      }
    } finally {
      cleanup();
    }
  });
});

describe('scoreMatch / findBestScenarioMatch — fuzzy matching', () => {
  const scenarios = [
    {
      scenarioTitle: 'Login succeeds',
      outcomeKeywords: ['dashboard', 'appears', 'welcome'],
    },
    {
      scenarioTitle: 'Invoice published',
      outcomeKeywords: ['invoice', 'appears', 'outbox'],
    },
  ];

  it('scores higher when keyword overlap is larger', () => {
    const a = scoreMatch('the dashboard appears after login', scenarios[0]);
    const b = scoreMatch('the dashboard appears after login', scenarios[1]);
    assert.ok(a > b);
  });

  it('returns the best-matching scenario above the threshold', () => {
    const m = findBestScenarioMatch(
      'the invoice appears in the outbox',
      scenarios,
    );
    assert.ok(m !== null);
    assert.equal(m.scenario.scenarioTitle, 'Invoice published');
  });

  it('returns null when no scenario meets the minScore threshold', () => {
    const m = findBestScenarioMatch(
      'something completely unrelated to anything in feature files',
      scenarios,
    );
    assert.equal(m, null);
  });
});
