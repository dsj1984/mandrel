/**
 * lib/audit-suite/__tests__/lens-contract.test.js — the suite-wide findings
 * contract conformance gate (Story #4625, recomposed under Story #4665).
 *
 * Every non-retired audit lens report must be machine-visible to the
 * `audit-to-stories` pipeline. Under Story #4665 the shared finding-block
 * skeleton, severity scale, self-cross-check, and execution strategy are
 * single-sourced into `helpers/audit-lens-core.md`, and each lens carries only
 * its own frontmatter, preamble, `{{changedFiles}}` fence, and lens-specific
 * dimensions. This gate therefore asserts a **composition** contract rather
 * than per-lens template byte-identity:
 *
 *   - the shared core exposes a `## Detailed Findings` finding-block skeleton
 *     that renders — through the real `parseAuditReport` — to a finding with a
 *     recognized severity, a recognized dimension key, and a harvested
 *     `Location:` into `files[]`;
 *   - the three absorbed helpers (severity-scale / self-check / dual-path) are
 *     gone and no lens references them;
 *   - each lens references the core, keeps its own `{{changedFiles}}` fence,
 *     names its canonical `{{auditOutputDir}}/audit-<lens>-results.md` path,
 *     and states subagent dispatch as its execution path.
 *
 * The parsed report contract consumed by `audit-to-stories` is unchanged: the
 * `parseAuditReport` findings-contract units at the bottom still pin the exact
 * field normalisation the pipeline relies on.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AUDIT_LENSES } from '../../audit-to-stories/audit-lenses.js';
import {
  __testing,
  parseAuditReport,
} from '../../audit-to-stories/parse-audit-md.js';

/**
 * Registered exemption list for the findings-contract gate (Story #4625). A
 * retired lens keeps its `audit-<lens>.md` workflow for history but is exempt
 * from the unified contract; `audit-lighthouse` is retired wholesale by the
 * accessibility Story.
 */
const RETIRED_LENSES = Object.freeze(['lighthouse']);
const isRetiredLens = (lens) => RETIRED_LENSES.includes(lens);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKFLOWS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'workflows',
);
const HELPERS_DIR = path.join(WORKFLOWS_DIR, 'helpers');
const CORE_HELPER = path.join(HELPERS_DIR, 'audit-lens-core.md');

/** Helpers absorbed into `audit-lens-core.md` (Story #4665) and deleted. */
const ABSORBED_HELPERS = Object.freeze([
  'audit-severity-scale.md',
  'audit-self-check.md',
  'audit-dual-path.md',
]);

const RECOGNIZED_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const DIMENSION_KEYS = ['dimension', 'category', 'area', 'type'];

const NON_RETIRED_LENSES = AUDIT_LENSES.filter((lens) => !isRetiredLens(lens));

/**
 * @param {string} lens
 * @returns {string} raw `audit-<lens>.md` markdown.
 */
function readLens(lens) {
  return fs.readFileSync(path.join(WORKFLOWS_DIR, `audit-${lens}.md`), 'utf8');
}

/**
 * Extract the fenced ```markdown report-template block that contains the
 * `## Detailed Findings` section — the exact finding-block skeleton the core
 * mandates and every lens composes onto.
 *
 * @param {string} md
 * @returns {string|null}
 */
function extractReportTemplate(md) {
  const lines = md.split(/\r?\n/);
  let inFence = false;
  let buf = null;
  for (const line of lines) {
    if (!inFence && /^```markdown\s*$/.test(line)) {
      inFence = true;
      buf = [];
      continue;
    }
    if (inFence && /^```\s*$/.test(line)) {
      const body = buf.join('\n');
      if (body.includes('## Detailed Findings')) return body;
      inFence = false;
      buf = null;
      continue;
    }
    if (inFence) buf.push(line);
  }
  return null;
}

describe('audit-lens-core shared contract (Story #4665)', () => {
  const coreMd = fs.readFileSync(CORE_HELPER, 'utf8');
  const coreTemplate = extractReportTemplate(coreMd);

  it('single-sources the core helper and deletes the three absorbed helpers', () => {
    assert.ok(
      fs.existsSync(CORE_HELPER),
      'helpers/audit-lens-core.md does not exist',
    );
    for (const gone of ABSORBED_HELPERS) {
      assert.ok(
        !fs.existsSync(path.join(HELPERS_DIR, gone)),
        `helpers/${gone} should be absorbed into audit-lens-core.md and deleted`,
      );
    }
  });

  it('exposes a Detailed Findings finding-block skeleton', () => {
    assert.ok(
      coreTemplate,
      'audit-lens-core.md has no ```markdown skeleton containing "## Detailed Findings"',
    );
  });

  it('the skeleton parses to a finding with a recognized severity and dimension', () => {
    const findings = parseAuditReport({
      markdown: coreTemplate,
      sourceReport: 'temp/audits/audit-security-results.md',
    });
    assert.ok(findings.length >= 1, 'core skeleton parsed to zero findings');
    const [first] = findings;
    assert.ok(
      RECOGNIZED_SEVERITIES.has(first.severity),
      `core skeleton severity "${first.severity}" is not on the Critical|High|Medium|Low scale`,
    );
    const hasDimensionKey = DIMENSION_KEYS.some((k) =>
      Object.hasOwn(first.rawFields, k),
    );
    assert.ok(
      hasDimensionKey,
      'core skeleton finding carries no dimension/category/area/type field',
    );
  });

  it('harvests the mandated Location bullet into files[]', () => {
    const [first] = parseAuditReport({
      markdown: coreTemplate,
      sourceReport: 'temp/audits/audit-security-results.md',
    });
    assert.ok(
      first.files.length >= 1,
      'core skeleton Location bullet was not harvested into files[]',
    );
  });

  it('documents the severity scale, self-cross-check, and Acceptance signal + Agent Prompt fields', () => {
    assert.match(
      coreTemplate,
      /\*\*Severity:\*\*\s*\[Critical \| High \| Medium \| Low\]/,
      'core skeleton does not offer the Critical|High|Medium|Low scale',
    );
    assert.ok(
      coreTemplate.includes('**Acceptance signal:**'),
      'core skeleton has no Acceptance signal field',
    );
    assert.ok(
      coreTemplate.includes('**Agent Prompt:**'),
      'core skeleton has no Agent Prompt field',
    );
    assert.ok(
      /##\s+Severity scale/.test(coreMd),
      'audit-lens-core.md has no Severity scale section',
    );
    assert.ok(
      /self-cross-check/i.test(coreMd),
      'audit-lens-core.md has no self-cross-check section',
    );
    assert.ok(
      /subagent_type: auditor/.test(coreMd),
      'audit-lens-core.md does not name the subagent_type: auditor dispatch',
    );
  });
});

describe('lens composition contract (Story #4665)', () => {
  for (const lens of NON_RETIRED_LENSES) {
    describe(`audit-${lens}`, () => {
      const md = readLens(lens);

      it('references the shared audit-lens-core helper', () => {
        assert.ok(
          md.includes('](helpers/audit-lens-core.md)'),
          `audit-${lens} does not reference helpers/audit-lens-core.md — the shared contract is not composed`,
        );
      });

      it('keeps its own {{changedFiles}} substitution fence', () => {
        assert.ok(
          md.includes('{{changedFiles}}'),
          `audit-${lens} dropped its {{changedFiles}} fence — the substitution anchor consumed by lib/audit-suite/ must stay per-file`,
        );
      });

      it('names its canonical audit output path', () => {
        assert.ok(
          md.includes(`{{auditOutputDir}}/audit-${lens}-results.md`),
          `audit-${lens} does not name its canonical output path`,
        );
      });

      it('does not re-reference the three absorbed helpers', () => {
        for (const gone of ABSORBED_HELPERS) {
          assert.ok(
            !md.includes(`](helpers/${gone})`),
            `audit-${lens} still links the absorbed helper helpers/${gone}`,
          );
        }
      });

      it('states subagent dispatch as its execution path', () => {
        assert.ok(
          /subagent_type: auditor/.test(md),
          `audit-${lens} does not state the subagent_type: auditor execution path`,
        );
      });
    });
  }
});

describe('audit-performance lens rework (Story #4631)', () => {
  const md = readLens('performance');

  it('AC-1: measures before judging — mandates cpu-prof and an Evidence field', () => {
    assert.ok(
      md.includes('cpu-prof'),
      'performance lens names no `node --cpu-prof` measurement command',
    );
    assert.ok(
      /##\s+Step 0/.test(md) && /measure/i.test(md),
      'performance lens has no mandatory measurement Step 0',
    );
    assert.ok(
      md.includes('**Evidence:**'),
      'performance lens template has no per-finding Evidence field',
    );
    assert.ok(
      /measured/.test(md) && /estimated/.test(md),
      'performance lens does not require a measured-or-estimated tag',
    );
  });

  it('AC-2: interleaving is a first-class dimension covering the concurrency defect classes', () => {
    assert.ok(
      /TOCTOU/i.test(md),
      'performance lens does not cover TOCTOU / check-then-act',
    );
    for (const concern of [
      /unawaited|floating/i,
      /read-modify-write/i,
      /temp-file/i,
      /idempoten/i,
      /shared-cache poisoning/i,
    ]) {
      assert.ok(
        concern.test(md),
        `performance lens omits a required concurrency concern: ${concern}`,
      );
    }
  });

  it('AC-3: dimensions adapt to the detected repo profile', () => {
    assert.ok(
      /profile/i.test(md) && /inapplicable/i.test(md),
      'performance lens does not branch on repo profile / declare inapplicable dimensions',
    );
    // Web-only dimension must be gated, not universal.
    assert.ok(
      /web only/i.test(md),
      'performance lens does not gate the payload/bundle dimension to web repos',
    );
  });

  it('AC-4: runs trend instead of amnesia — per-run baseline + delta reporting', () => {
    assert.ok(
      /perf-baseline\.json/.test(md),
      'performance lens does not mandate a per-run perf baseline artifact',
    );
    assert.ok(
      /(delta|diff)/i.test(md) && /baseline/i.test(md),
      'performance lens does not report deltas vs the previous baseline',
    );
    assert.ok(
      /suppress/i.test(md) && /unchanged/i.test(md),
      'performance lens does not suppress unchanged known findings',
    );
    assert.ok(
      /regress/i.test(md) && /High/.test(md),
      'performance lens does not make a regression vs baseline an automatic High',
    );
  });

  it("re-homes lighthouse's measured CWV material into the web branch", () => {
    assert.ok(
      /median-of-3/i.test(md) && /per-route/i.test(md),
      'performance lens web branch does not carry the per-route / median-of-3 CWV protocol',
    );
  });
});

describe('parseAuditReport findings-contract units (Story #4625)', () => {
  const wrap = (block) => `# Report\n\n## Detailed Findings\n\n${block}\n`;

  it('recognizes the Critical severity level', () => {
    const [f] = parseAuditReport({
      markdown: wrap(
        '### `src/a.js` — leak\n\n- **Dimension:** Injection\n- **Severity:** Critical\n- **Location:** `src/a.js:5`\n',
      ),
      sourceReport: 'audit-security-results.md',
    });
    assert.equal(f.severity, 'critical');
  });

  it('derives a per-finding dimension from a Dimension: label (no report-name fallback)', () => {
    const [f] = parseAuditReport({
      markdown: wrap(
        '### `src/log.js` — leaky log\n\n- **Dimension:** Leaky Log\n- **Impact:** High\n- **Location:** `src/log.js:9`\n',
      ),
      sourceReport: 'temp/audits/audit-privacy-results.md',
    });
    assert.equal(f.dimension, 'leaky log');
    assert.notEqual(f.dimension, 'privacy');
  });

  it('accepts the legacy Type: label via the dimension alias list', () => {
    const [f] = parseAuditReport({
      markdown: wrap(
        '### `src/log.js` — over-collection\n\n- **Type:** Data Over-collection\n- **Impact:** Medium\n- **Location:** `src/log.js:3`\n',
      ),
      sourceReport: 'temp/audits/audit-privacy-results.md',
    });
    assert.equal(f.dimension, 'data over-collection');
  });

  it('harvests Location into files[] ahead of prose scraping', () => {
    const files = __testing.deriveLocationFiles({
      location: '`src/deep/x.js:42`',
    });
    assert.deepEqual(files, ['src/deep/x.js']);
  });
});
