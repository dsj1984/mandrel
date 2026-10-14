/**
 * Contract tests binding the `audit-adrs` lens to the decisions-log contract
 * it audits against.
 *
 * The lens is prose: it is the prompt an auditor runs on, so a claim it makes
 * about ADR structure is only as good as its agreement with the skill that
 * defines that structure. Nothing mechanical couples the two files — the lens
 * could name five canonical sections while the skill names seven, and both
 * would keep "passing" while auditors graded real ADRs against a vocabulary
 * the project never adopted.
 *
 * So these pin the couplings that must not drift independently:
 *
 *  1. The canonical ADR section list and both layout names are stated by the
 *     skill and honoured by the lens (AC-6).
 *  2. The ADR *status* vocabulary is likewise stated by the skill and honoured
 *     by the lens. This one drifted for real: the lens inherited a three-word
 *     list while the log had been using `Reverted (<date>)` for months, so the
 *     lens would have graded a conforming entry as a free-invented status.
 *  3. The lens keeps the shared-machinery contract every lens carries — one
 *     substitution fence, the core reference, its own report path (AC-1).
 *  4. The lens's five dimensions are its finding vocabulary, and the
 *     Accepted-only scoping of the drift claim-check survives (AC-3).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const LENS_PATH = '.agents/workflows/audit-adrs.md';
const SKILL_PATH = '.agents/skills/core/documentation-and-adrs/SKILL.md';

/**
 * The canonical ADR sections, as the documentation-and-adrs Policy Capsule
 * names them. `Alternatives Considered` is the one optional member, which is
 * why the lens must mention it without requiring it.
 */
const CANONICAL_SECTIONS = [
  'Status',
  'Date',
  'Deciders',
  'Context',
  'Decision',
  'Alternatives Considered',
  'Consequences',
];

/**
 * The ADR status vocabulary, as the documentation-and-adrs Policy Capsule
 * names it. Pinned by the substring both surfaces share: the skill writes
 * `Superseded by ADR-XXX` and the lens `Superseded by <ref>`, so only
 * `Superseded by` is common to the two.
 */
const STATUS_VOCABULARY = [
  'Accepted',
  'Superseded by',
  'Deprecated',
  'Reverted (<date>)',
];

/**
 * The clause separating a reverted decision from a superseded one. Without it
 * the two statuses read as synonyms and an auditor demands a successor
 * reference from an entry that correctly has none.
 */
const REVERTED_GLOSS =
  /reverted decision was \*\*undone\*\*\s+rather than replaced/i;

/** The five dimensions that make up this lens's finding vocabulary. */
const DIMENSIONS = [
  'Decision Drift',
  'Supersede-Chain Integrity',
  'Structure & Status Hygiene',
  'Missing Decision',
  'Layout Conformance',
];

describe('audit-adrs is pinned to the documentation-and-adrs contract', () => {
  it('the skill still owns the canonical ADR section list', () => {
    const skill = read(SKILL_PATH);
    for (const section of CANONICAL_SECTIONS) {
      assert.ok(
        skill.includes(section),
        `${SKILL_PATH} no longer names the canonical ADR section "${section}". ` +
          'The skill is the SSOT for ADR structure — if the section list moved, ' +
          'update this list and the lens together, never one alone.',
      );
    }
  });

  it('the lens audits against every canonical section the skill defines', () => {
    const lens = read(LENS_PATH);
    for (const section of CANONICAL_SECTIONS) {
      assert.ok(
        lens.includes(section),
        `${LENS_PATH} does not mention the canonical ADR section "${section}", ` +
          'so its structure sweep would grade ADRs against a narrower ' +
          'vocabulary than the skill mandates.',
      );
    }
  });

  it('the skill still owns the ADR status vocabulary', () => {
    const skill = read(SKILL_PATH);
    for (const status of STATUS_VOCABULARY) {
      assert.ok(
        skill.includes(status),
        `${SKILL_PATH} no longer names the ADR status "${status}". The skill ` +
          'is the SSOT for the status vocabulary — if a status moved, update ' +
          'this list and the lens together, never one alone.',
      );
    }
  });

  it('the lens accepts every status the skill defines', () => {
    const lens = read(LENS_PATH);
    for (const status of STATUS_VOCABULARY) {
      assert.ok(
        lens.includes(status),
        `${LENS_PATH} does not name the ADR status "${status}", so its ` +
          'Status-vocabulary sweep would grade a conforming entry as a ' +
          'free-invented status and manufacture a finding from it.',
      );
    }
  });

  it('skill and lens both gloss Reverted as undone rather than replaced', () => {
    for (const [rel, surface] of [
      [SKILL_PATH, read(SKILL_PATH)],
      [LENS_PATH, read(LENS_PATH)],
    ]) {
      assert.ok(
        REVERTED_GLOSS.test(surface),
        `${rel} must distinguish Reverted from Superseded: a reverted ` +
          'decision was undone, not replaced, so it has no successor to ' +
          'point at and its missing "by <ref>" is correct.',
      );
    }
  });

  it('both first-class decisions-log layouts are named by skill and lens alike', () => {
    const skill = read(SKILL_PATH);
    const lens = read(LENS_PATH);
    for (const surface of [skill, lens]) {
      assert.ok(
        surface.includes('decisions.md'),
        'the single-file dated-entry layout must be named by its entry file',
      );
      assert.ok(
        surface.includes('decisions/'),
        'the index + directory (MADR-style) layout must be named',
      );
    }
  });

  it('the lens knows both layouts share one entry filename', () => {
    const lens = read(LENS_PATH);
    assert.ok(
      /[Bb]oth layouts keep the same entry file/.test(lens),
      `${LENS_PATH} must state that both layouts keep the same entry file. ` +
        'Detecting the layout by the presence of decisions.md alone is wrong ' +
        'in exactly the case the directory layout exists, where that file is ' +
        'the index.',
    );
  });

  it('the lens mandates the not-applicable report rather than empty findings', () => {
    const lens = read(LENS_PATH);
    assert.ok(
      lens.includes('Not applicable'),
      `${LENS_PATH} must carry the explicit not-applicable report so a repo ` +
        'with no decisions log reads as skipped, never as clean.',
    );
  });

  it('the operator override is --paths / --dir and no config key', () => {
    const lens = read(LENS_PATH);
    assert.ok(
      lens.includes('--paths') && lens.includes('--dir'),
      `${LENS_PATH} must document both override flags`,
    );
    assert.ok(
      /no\s+`?\.agentrc(\.json)?`?\s+key/i.test(lens),
      `${LENS_PATH} must state that no .agentrc key configures the ` +
        'decisions-log location — the flags are the only override.',
    );
  });
});

describe('audit-adrs keeps the shared lens contract', () => {
  it('carries exactly one {{changedFiles}} substitution fence', () => {
    const lens = read(LENS_PATH);
    const fences = lens.match(/```text\n\{\{changedFiles\}\}\n```/g) || [];
    assert.equal(
      fences.length,
      1,
      `${LENS_PATH} must contain exactly one {{changedFiles}} fence — the ` +
        'substitution anchor lib/audit-suite/ consumes.',
    );
  });

  it('references the shared core instead of restating its machinery', () => {
    const lens = read(LENS_PATH);
    assert.ok(
      lens.includes('](helpers/audit-lens-core.md)'),
      `${LENS_PATH} must reference helpers/audit-lens-core.md`,
    );
  });

  it('names its own report path so audit-to-stories can glob it', () => {
    const lens = read(LENS_PATH);
    assert.ok(
      lens.includes('{{auditResultsDir}}/audit-adrs-results.md'),
      `${LENS_PATH} must name {{auditResultsDir}}/audit-adrs-results.md`,
    );
  });

  it('declares its global-scope deviation from the change-set fence', () => {
    const lens = read(LENS_PATH);
    assert.ok(
      lens.includes('"scope": "global"'),
      `${LENS_PATH} must declare its global scope, matching audit-rules.json`,
    );
    assert.ok(
      /ignore.*\{\{changedFiles\}\}/is.test(lens),
      `${LENS_PATH} must tell the auditor to ignore the fence even when it is ` +
        'populated — otherwise a scoped run silently narrows a global lens.',
    );
  });

  it('is registered as a global lens in audit-rules.json', () => {
    const rules = JSON.parse(read('.agents/schemas/audit-rules.json'));
    const entry = rules.audits['audit-adrs'];
    assert.ok(entry, 'audit-rules.json has no audit-adrs entry');
    assert.equal(entry.scope, 'global');
    assert.ok(
      (entry.triggers.keywords ?? []).length > 0,
      'audit-adrs must carry keyword triggers',
    );
    assert.ok(
      (entry.triggers.filePatterns ?? []).some((pattern) =>
        pattern.includes('decisions'),
      ),
      'audit-adrs must carry a decisions-path file trigger',
    );
  });
});

describe('audit-adrs scopes its claim-check to Accepted entries', () => {
  it('states every dimension of its finding vocabulary', () => {
    const lens = read(LENS_PATH);
    for (const dimension of DIMENSIONS) {
      assert.ok(
        lens.includes(dimension),
        `${LENS_PATH} does not name the "${dimension}" dimension`,
      );
    }
  });

  it('restricts drift claim-checking to Accepted entries', () => {
    const lens = read(LENS_PATH);
    assert.ok(
      /Accepted.*only/i.test(lens),
      `${LENS_PATH} must scope the Decision Drift claim-check to Accepted ` +
        'entries only.',
    );
    assert.ok(
      /Superseded/.test(lens) &&
        /chain checks|chain-check|Chain only/i.test(lens),
      `${LENS_PATH} must say Superseded entries get chain checks only — ` +
        'claim-checking retired history manufactures findings from decisions ' +
        'that were correctly retired.',
    );
  });

  it('keeps supersede-in-place as the remediation, never deletion', () => {
    const lens = read(LENS_PATH);
    assert.ok(
      /supersede/i.test(lens) && /never.*delet/i.test(lens),
      `${LENS_PATH} must keep the skill's lifecycle rule: an ADR is ` +
        'superseded in place, never deleted or archived.',
    );
  });
});

describe('audit-documentation hands decision semantics to audit-adrs', () => {
  it('carries the boundary demarcation', () => {
    const doc = read('.agents/workflows/audit-documentation.md');
    assert.ok(
      doc.includes('audit-adrs.md'),
      'audit-documentation.md must point decision-log semantics at audit-adrs',
    );
    assert.ok(
      /decision-log semantics belong to/i.test(doc),
      'audit-documentation.md must state the boundary explicitly, so the two ' +
        'lenses do not double-report the same defect.',
    );
  });

  it('retains its own generic documentation coverage', () => {
    const doc = read('.agents/workflows/audit-documentation.md');
    assert.ok(
      doc.includes('History Bloat'),
      'the boundary must not strip audit-documentation of its Context ' +
        'Economy categories — it keeps generic coverage of the decisions file.',
    );
  });
});
