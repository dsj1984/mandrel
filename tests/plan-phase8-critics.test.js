/**
 * Phase 8 critics (Epic #4131 / Story #4141, F6 + F9).
 *
 * Pins the two critic sub-steps authored into the `/plan` Phase 8 surface:
 *
 *   - F6 — a completeness critic sub-step in `plan-epic.md` Phase 8 that may
 *     ADD a single reachability Story when a surface has no nav owner, gated
 *     by the existing HITL diff, and explicitly DISTINCT from (and not a
 *     relaxation of) the scope-preserving conservation invariant of the
 *     `epic-plan-consolidate` skill (AC-7).
 *   - F9 — a fresh-context pre-mortem critic, implemented as the new
 *     `.agents/skills/core/epic-plan-premortem/SKILL.md`, that reads the cited
 *     code surfaces and emits predicted-rework findings to a temp report
 *     before any GitHub write; `plan-epic.md` Phase 8 wires it before the
 *     decompose persist call (AC-10).
 *
 * This is a structural assertion over the authored documentation + skill
 * source — it does not execute the planning flow. It also guards the
 * additive-only invariant: the pre-existing 8.3 consolidation language and
 * its scope-conservation contract must survive untouched.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const PLAN_EPIC_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'workflows',
  'helpers',
  'plan-epic.md',
);

const PREMORTEM_SKILL_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'skills',
  'core',
  'epic-plan-premortem',
  'SKILL.md',
);

const CONSOLIDATE_SKILL_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'skills',
  'core',
  'epic-plan-consolidate',
  'SKILL.md',
);

const SKILLS_INDEX_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'skills',
  'skills.index.json',
);

const planEpic = readFileSync(PLAN_EPIC_PATH, 'utf8');
const premortem = readFileSync(PREMORTEM_SKILL_PATH, 'utf8');
const consolidate = readFileSync(CONSOLIDATE_SKILL_PATH, 'utf8');

// The Phase 8 decompose-persist step is anchored on its unique CLI phrase; the
// Phase 7 spec-persist step shares the `**Persist to GitHub**` heading text.
const DECOMPOSE_PERSIST = "decompose CLI's persist half";

describe('Phase 8 completeness critic — reachability-Story adder (F6 / AC-7)', () => {
  it('documents a completeness critic that may ADD a single reachability Story', () => {
    assert.match(
      planEpic,
      /Reachability Completeness Critic/,
      'plan-epic.md must name the reachability completeness critic sub-step',
    );
    assert.match(
      planEpic,
      /single reachability Story/,
      'the critic must be documented as adding a single reachability Story',
    );
    assert.match(
      planEpic,
      /at most one\*\* reachability Story per decompose run/,
      'the critic must cap the addition at one reachability Story per run',
    );
  });

  it('is HITL-gated before any GitHub write', () => {
    assert.match(
      planEpic,
      /same Phase 8 HITL diff\*\* as\s+consolidation,\s+\*\*before\*\* any GitHub write/,
      'the added Story must surface in the HITL diff before any GitHub write',
    );
  });

  it('is explicitly distinct from the consolidate conservation invariant and does not relax it', () => {
    assert.match(
      planEpic,
      /\*\*distinct pass\*\* from\s+\[`epic-plan-consolidate`\]/,
      'the critic must be a distinct pass from epic-plan-consolidate',
    );
    assert.match(
      planEpic,
      /must NOT relax\*\* that skill's scope-preserving conservation invariant/,
      'the critic must not relax the consolidate conservation invariant',
    );
  });

  it('keeps the pre-existing 8.3 consolidation scope-conservation language intact', () => {
    // The consolidate skill remains merge-and-rewire-only — additive-only
    // invariant: this Story must NOT have weakened it.
    assert.match(
      consolidate,
      /Scope conservation is the load-bearing invariant/,
      'consolidate SKILL must still declare scope conservation load-bearing',
    );
    assert.match(
      planEpic,
      /Its operations are\s+scope-preserving only/,
      'plan-epic.md 8.3 must still call consolidation scope-preserving only',
    );
  });

  it('keys detection off the F7 navigation config and no-ops when unconfigured', () => {
    assert.match(
      planEpic,
      /planning\.navigation\.routeGlobs/,
      'detection must reference the navigation routeGlobs config',
    );
    assert.match(
      planEpic,
      /planning\.navigation\.navRegistry/,
      'detection must reference the nav-registry config',
    );
    assert.match(
      planEpic,
      /silent no-op/,
      'the critic must degrade to a silent no-op when unconfigured',
    );
  });
});

describe('Phase 8 pre-mortem critic — code-reading skill (F9 / AC-10)', () => {
  it('the epic-plan-premortem SKILL.md exists with correct frontmatter name', () => {
    assert.match(
      premortem,
      /^---[\s\S]*?\nname:\s*epic-plan-premortem\b/,
      'SKILL frontmatter must declare name: epic-plan-premortem',
    );
  });

  it('defines a fresh-context critic that reads the cited code surfaces', () => {
    assert.match(
      premortem,
      /fresh-context pre-mortem critic/i,
      'SKILL must describe itself as a fresh-context pre-mortem critic',
    );
    assert.match(
      premortem,
      /You MUST read the actual cited code surfaces/,
      'SKILL must require reading the actual cited code surfaces',
    );
  });

  it('emits predicted-rework findings (the three classes)', () => {
    assert.match(premortem, /unverifiable acceptance criteria/i);
    assert.match(premortem, /over- or under-specified Stories/i);
    assert.match(premortem, /semantically-wrong assumptions/i);
  });

  it('never writes to GitHub and never persists tickets.json (report-only)', () => {
    assert.match(
      premortem,
      /never writes to GitHub and never persists `tickets\.json`/,
      'SKILL must declare itself report-only (no GitHub write, no persist)',
    );
    assert.match(
      premortem,
      /predicted-rework findings .*before any GitHub write/i,
      'SKILL description must emit findings before any GitHub write',
    );
  });

  it('is registered in the generated skills index', () => {
    const index = JSON.parse(readFileSync(SKILLS_INDEX_PATH, 'utf8'));
    const entries = Array.isArray(index) ? index : index.skills;
    assert.ok(
      Array.isArray(entries),
      'skills index must be an array of entries',
    );
    const entry = entries.find((s) => s && s.name === 'epic-plan-premortem');
    assert.ok(
      entry,
      'epic-plan-premortem must be present in skills.index.json',
    );
    assert.equal(
      entry.path,
      '.agents/skills/core/epic-plan-premortem/SKILL.md',
      'index path must point at the core skill',
    );
  });
});

describe('plan-epic.md Phase 8 wiring', () => {
  it('runs the pre-mortem critic before the decompose persist call', () => {
    const premortemIdx = planEpic.indexOf('Planning Pre-Mortem Critic');
    const persistIdx = planEpic.indexOf(DECOMPOSE_PERSIST);
    assert.ok(premortemIdx > 0, 'plan-epic.md must wire the pre-mortem critic');
    assert.ok(
      persistIdx > 0,
      'plan-epic.md must retain the decompose persist step',
    );
    assert.ok(
      premortemIdx < persistIdx,
      'the pre-mortem critic must be documented before the persist call',
    );
  });

  it('links the new epic-plan-premortem skill from Phase 8', () => {
    assert.match(
      planEpic,
      /\[`epic-plan-premortem`\]\(\.\.\/\.\.\/skills\/core\/epic-plan-premortem\/SKILL\.md\)/,
      'Phase 8 must link the epic-plan-premortem SKILL.md',
    );
  });

  it('orders the critics: consolidation (8.3) → completeness (8.4) → pre-mortem (8.5) → persist', () => {
    const consolidateIdx = planEpic.indexOf(
      'Phase 8.3 — Holistic Consolidation',
    );
    const completenessIdx = planEpic.indexOf(
      'Reachability Completeness Critic',
    );
    const premortemIdx = planEpic.indexOf('Planning Pre-Mortem Critic');
    const persistIdx = planEpic.indexOf(DECOMPOSE_PERSIST);
    assert.ok(
      consolidateIdx > 0 &&
        consolidateIdx < completenessIdx &&
        completenessIdx < premortemIdx &&
        premortemIdx < persistIdx,
      'Phase 8 sub-steps must be ordered 8.3 → 8.4 → 8.5 → persist',
    );
  });
});
