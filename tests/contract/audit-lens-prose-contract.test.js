/**
 * Story #4877 — contract tests over the audit lens *prose*.
 *
 * The lens markdown is executable in the only sense that matters: it is the
 * prompt an auditor runs on. When the prose documents a narrower severity
 * vocabulary than the code recognises, the lens grades findings the pipeline
 * then discards — and no code test can catch it, because the defect is in the
 * instructions rather than the parser.
 *
 * So these assert three things the prose must keep saying:
 *
 *  1. Every level of the canonical scale appears in every place a lens is told
 *     what to grade on, and no place offers a truncated list (AC-1).
 *  2. The architecture and quality lenses carry the dead-wiring mandate, naming
 *     both of its concrete shapes (AC-7).
 *  3. `ci-remediation.md` defines the capacity verdict and still forbids
 *     rerunning to green under every verdict (AC-8).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SEVERITIES } from '../../.agents/scripts/lib/findings/severity.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** Every file that tells an auditor what vocabulary to grade on. */
const SEVERITY_VOCABULARY_SURFACES = [
  '.agents/workflows/helpers/audit-lens-core.md',
  '.agents/agents/auditor.md',
];

describe('the severity vocabulary is one vocabulary (Story #4877, AC-1)', () => {
  for (const surface of SEVERITY_VOCABULARY_SURFACES) {
    it(`${surface} documents every canonical level`, () => {
      const text = read(surface).toLowerCase();
      for (const level of SEVERITIES) {
        assert.ok(
          text.includes(`**${level}**`),
          `${surface} does not define the "${level}" level. A lens cannot grade ` +
            'on a level its instructions never mention, and the code treats ' +
            'anything outside SEVERITIES as no severity at all.',
        );
      }
    });

    it(`${surface} offers the full scale in its finding-block skeleton`, () => {
      const text = read(surface);
      assert.ok(
        text.includes('[Critical | High | Medium | Low | Info]'),
        `${surface}'s Severity field must offer all five levels — a truncated ` +
          'list is what taught lenses to invent below-Low words that parse as ' +
          'no severity and get dropped by every filtered run',
      );
    });

    it(`${surface} does not offer the old truncated four-level list`, () => {
      assert.ok(
        !read(surface).includes('[Critical | High | Medium | Low]'),
        `${surface} still carries the four-level list that omits Info`,
      );
    });
  }

  it('the shared core points at the code that owns the vocabulary', () => {
    const core = read('.agents/workflows/helpers/audit-lens-core.md');
    assert.ok(
      core.includes('lib/findings/severity.js'),
      'the core must name the module that owns the scale, so the prose is ' +
        'derivative of the code rather than a second source of truth',
    );
  });

  it('the architecture lens grades on the canonical scale, not a High/Medium/Low axis', () => {
    const lens = read('.agents/workflows/audit-architecture.md');
    assert.ok(
      lens.includes('Critical | High | Medium | Low | Info'),
      'the architecture lens must name the canonical five levels for its ' +
        'relabelled Impact axis',
    );
    assert.ok(
      !/grade \*\*Impact\*\* on a High \/ Medium \/ Low axis/.test(lens),
      'the architecture lens still restricts Impact to High/Medium/Low, which ' +
        'silently has no way to express a Critical or an Info finding',
    );
    assert.ok(
      !/keyed to High\/Medium\/Low severity/.test(lens),
      'the lens frontmatter still advertises the truncated scale',
    );
  });
});

describe('the dead-wiring mandate (Story #4877, AC-7)', () => {
  const MANDATED_LENSES = [
    '.agents/workflows/audit-architecture.md',
    '.agents/workflows/audit-quality.md',
  ];

  for (const lens of MANDATED_LENSES) {
    it(`${lens} mandates reporting code with no live production caller`, () => {
      const text = read(lens);
      assert.ok(
        /no live production caller|no live production path/i.test(text),
        `${lens} must explicitly mandate reporting shipped code that no live ` +
          'production caller reaches — the failure mode per-Story verification ' +
          'structurally cannot catch',
      );
      assert.ok(
        /mandatory/i.test(text),
        `${lens}'s dead-wiring dimension must be mandatory, not optional`,
      );
    });

    it(`${lens} names the produced-but-never-consumed artifact shape`, () => {
      assert.match(
        read(lens),
        /produced-but-never-consumed artifact/i,
        `${lens} must name the writer-with-no-reader shape concretely`,
      );
    });

    it(`${lens} names the optional-field-nothing-populates shape`, () => {
      assert.match(
        read(lens),
        /optional field nothing populates/i,
        `${lens} must name the unreachable-branch shape concretely`,
      );
    });
  }

  it('the shared core reconciles the mandate with its exclusion list', () => {
    // The core tells every lens to drop findings resting on entry points and
    // test seams. Without an explicit boundary the mandate and the exclusions
    // read as contradictory, and an auditor resolves the contradiction by
    // dropping the finding.
    const core = read('.agents/workflows/helpers/audit-lens-core.md');
    assert.match(
      core,
      /Boundary with the dead-wiring mandate/,
      'the core must state how its exclusion list bounds the dead-wiring mandate',
    );
  });
});

describe('the capacity verdict (Story #4877, AC-8)', () => {
  const rule = () => read('.agents/rules/ci-remediation.md');

  it('defines a capacity verdict', () => {
    assert.match(
      rule(),
      /### The `capacity` verdict/,
      'the rule must define the capacity verdict it previously had no landing for',
    );
  });

  it('routes capacity to a framework-gap filing and operator escalation', () => {
    const text = rule();
    const section = text.slice(text.indexOf('### The `capacity` verdict'));
    assert.match(
      section,
      /meta::framework-gap/,
      'the capacity verdict must route to a meta::framework-gap filing',
    );
    assert.match(
      section,
      /operator/,
      'the capacity verdict must escalate to the operator, who owns the runner pool',
    );
    assert.match(
      section,
      /agent::blocked/,
      'a capacity-blocked delivery must end at agent::blocked, not merged',
    );
  });

  it('requires capacity to be proven rather than inferred from a green re-run', () => {
    const text = rule();
    const section = text.slice(text.indexOf('### The `capacity` verdict'));
    assert.match(
      section,
      /proven, not inferred/i,
      'capacity must be proven — a green re-run is what a flaky test produces, ' +
        'so accepting it as evidence would launder every flake as capacity',
    );
    assert.match(
      section,
      /flaky, not capacity/i,
      'the rule must name the default verdict when the resource reading is absent',
    );
  });

  it('still forbids rerunning a failed job to reach green under EVERY verdict', () => {
    const text = rule();
    assert.match(
      text,
      /forbidden under every verdict/i,
      'adding a verdict must not open a rerun path — the prohibition has to be ' +
        'restated as universal, or `capacity` becomes the excuse it was meant to remove',
    );
    assert.match(
      text,
      /may \*\*not\*\*\s*\n?re-run a failed job/,
      'the original no-rerun prohibition must remain intact',
    );
  });

  it('enumerates every verdict with the evidence that reaches it', () => {
    const text = rule();
    assert.match(text, /## Verdicts/, 'the rule must enumerate its verdicts');
    for (const verdict of ['defect-in-diff', 'pre-existing', 'capacity']) {
      assert.ok(
        text.includes(`**${verdict}**`),
        `the verdict table must carry ${verdict}`,
      );
    }
  });
});

/**
 * Story #5281 — the runtime-pass scaffold is written once.
 *
 * Two lenses carried the same four numbered steps verbatim. Duplicated prose is
 * duplicated in the sense that matters here: the tool-unavailable skip reason
 * was added to the shared scaffold, and a lens still restating the steps would
 * quietly keep instructing an auditor to report a runtime section it never ran.
 */
describe('the runtime-pass scaffold is shared, not restated (Story #5281)', () => {
  const RUNTIME_LENSES = [
    '.agents/workflows/audit-mobile.md',
    '.agents/workflows/audit-accessibility.md',
  ];
  const CORE = '.agents/workflows/helpers/audit-lens-core.md';

  it('the core carries the scaffold, its anchor, and both skip reasons', () => {
    const text = read(CORE);
    assert.match(text, /## Runtime pass scaffold \{#runtime-pass\}/);
    assert.match(text, /qa\.environments\.<env>\.baseUrl/);
    assert.match(text, /Sample routes from the navigability SSOT/);
    assert.match(text, /median-of-3/);
    assert.match(text, /browser tooling unavailable/);
  });

  for (const lens of RUNTIME_LENSES) {
    it(`${lens} cites the scaffold`, () => {
      assert.match(read(lens), /audit-lens-core\.md#runtime-pass/);
    });

    it(`${lens} restates neither target resolution nor route sampling`, () => {
      const text = read(lens);
      for (const restated of [
        /qa\.environments\.<env>\.baseUrl/,
        /resolveQaEnvironment/,
        /Sample routes from the navigability SSOT/,
        /planning\.navigation\.navRegistry/,
      ]) {
        assert.doesNotMatch(
          text,
          restated,
          `${lens} still restates the shared scaffold. One copy of these steps ` +
            'is the point: a second one goes stale the next time the scaffold ' +
            'gains a step.',
        );
      }
    });
  }
});
