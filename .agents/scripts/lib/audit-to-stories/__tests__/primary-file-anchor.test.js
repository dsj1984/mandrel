/**
 * Regression tests for the finding → primary-file anchor that drives grouping.
 *
 * A live full-scope sweep grouped 39 unrelated documentation findings under a
 * single `file:docs/CHANGELOG.md` key — a file only 3 of them even mentioned,
 * and one the documentation lens explicitly excludes from semantic review. The
 * cause was in the parser, not the grouper: `files[]` was built from a
 * slash-only guard, so every **root-level** file (`AGENTS.md`, `README.md`,
 * `package.json`) was discarded even when it was the finding's explicit
 * `Location:`. Parsing then fell through to prose scraping and picked up an
 * incidental path quoted in the finding's prose, which `pickPrimaryFile`
 * returns verbatim as the group key.
 *
 * These tests pin the four shapes that failure depended on.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { groupFindings } from '../group-findings.js';
import { parseAuditReport, parseAuditReports } from '../parse-audit-md.js';

const REPO_ROOT = '/repo';

function report(body) {
  return {
    markdown: `## Detailed Findings\n\n${body}\n`,
    sourceReport: 'temp/audits/audit-documentation-results.md',
    repoRoot: REPO_ROOT,
  };
}

describe('primary-file anchor', () => {
  it('keeps a root-level Location path instead of discarding it', () => {
    const [finding] = parseAuditReport(
      report(
        '### `AGENTS.md` — distribution claim contradicts the package contents\n\n' +
          '- **Category:** Contradiction\n' +
          '- **Severity:** High\n' +
          '- **Location:** `AGENTS.md:28`\n' +
          '- **Current State:** the blockquote claims only `.agents/` ships.\n',
      ),
    );

    assert.equal(
      finding.files[0],
      'AGENTS.md',
      'a root-level file must survive as the primary anchor',
    );
  });

  it('prefers the title anchor over a path quoted in the prose', () => {
    // The Recommendation quotes a `files` array; none of those paths is the
    // finding's subject, and one of them used to win the primary slot.
    const [finding] = parseAuditReport(
      report(
        '### `AGENTS.md` — distribution claim contradicts the package contents\n\n' +
          '- **Category:** Contradiction\n' +
          '- **Severity:** High\n' +
          '- **Location:** `AGENTS.md:28`\n' +
          '- **Recommendation & Rationale:** `package.json files is [".agents/","bin/","docs/CHANGELOG.md","lib/"] — fix AGENTS.md.`\n',
      ),
    );

    assert.equal(finding.files[0], 'AGENTS.md');
    assert.ok(
      finding.files.includes('docs/CHANGELOG.md'),
      'incidental prose paths are still captured, just never primary',
    );
  });

  it('relativises an absolute path so it can match a repo-relative key', () => {
    const [finding] = parseAuditReport(
      report(
        '### `docs/architecture.md` — Tech Stack names a retired distribution channel\n\n' +
          '- **Category:** Stale Description\n' +
          '- **Severity:** High\n' +
          '- **Location:** `/repo/docs/architecture.md:349`\n',
      ),
    );

    assert.equal(finding.files[0], 'docs/architecture.md');
    assert.ok(
      !finding.files.some((f) => f.startsWith('/')),
      'no absolute path may survive into files[]',
    );
  });

  it('drops degenerate and out-of-repo tokens', () => {
    const [finding] = parseAuditReport(
      report(
        '### `knip.json` — unused-dependency rules are disabled\n\n' +
          '- **Category:** Removal\n' +
          '- **Severity:** Medium\n' +
          '- **Location:** `knip.json:33`\n' +
          '- **Current State:** compare / against /elsewhere/outside.md for context.\n',
      ),
    );

    assert.equal(finding.files[0], 'knip.json');
    assert.ok(!finding.files.includes('/'), 'a bare separator is not a file');
    assert.ok(
      !finding.files.includes('/elsewhere/outside.md'),
      'a path outside the repo can never be a valid group key',
    );
  });

  it('accepts a bare root-level file in a structured field but not in prose', () => {
    // The separator guard is deliberate for prose (see the sibling suite in
    // tests/audit-to-stories/) — it stops a word like `description.md` being
    // read as a path. It must not apply to the mandated structured fields.
    const [finding] = parseAuditReport(
      report(
        '### `package.json` — overrides pin blocks a devDependency upgrade\n\n' +
          '- **Severity:** High\n' +
          '- **Location:** `package.json:64`\n' +
          '- **Current State:** covered in the release notes, not just description.md\n',
      ),
    );

    assert.equal(finding.files[0], 'package.json');
    assert.ok(
      !finding.files.includes('description.md'),
      'a bare filename in prose stays excluded',
    );
  });

  it('groups findings under their own subject file, not a shared prose mention', () => {
    // Both findings quote docs/CHANGELOG.md in prose; neither is about it.
    const findings = parseAuditReports(
      [
        {
          markdown:
            '## Detailed Findings\n\n' +
            '### `AGENTS.md` — distribution claim is wrong\n\n' +
            '- **Severity:** High\n' +
            '- **Location:** `AGENTS.md:28`\n' +
            '- **Current State:** package.json ships docs/CHANGELOG.md too.\n\n' +
            '### `README.md` — Quickstart repeats the same wrong claim\n\n' +
            '- **Severity:** Medium\n' +
            '- **Location:** `README.md:184`\n' +
            '- **Current State:** package.json ships docs/CHANGELOG.md too.\n',
          sourceReport: 'temp/audits/audit-documentation-results.md',
        },
      ],
      { repoRoot: REPO_ROOT },
    );

    const { groups } = groupFindings(findings);
    const keys = groups.map((g) => g.groupKey).sort();

    assert.deepEqual(keys, ['file:AGENTS.md', 'file:README.md']);
    assert.ok(
      !keys.includes('file:docs/CHANGELOG.md'),
      'a file merely mentioned in prose must never become a group key',
    );
  });
});
