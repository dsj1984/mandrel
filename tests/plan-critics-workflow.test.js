/**
 * /plan critic passes after the 3-step collapse (Epic #4474 PR5; formerly
 * tests/plan-phase8-critics.test.js against the 12-phase pipeline).
 *
 * Pins the critic surface of `plan-epic.md`'s author step:
 *
 *   - The consolidation critic and the pre-mortem critic survive as
 *     fresh-context sub-agent dispatches between authoring and gate #2 —
 *     report-only, never writing to GitHub, and risk/size-conditional
 *     since PR6: the deterministic `plan-critics.js` CLI owns the
 *     dispatch decision and every skip is ledger-logged for audit.
 *   - The consolidation critic keeps its scope-preserving conservation
 *     invariant (merge-and-rewire only, never adds scope).
 *   - The reachability completeness check is DEMOTED from a workflow
 *     critic to a deterministic persist-side soft failure (design §4):
 *     `plan-epic.md` documents it under the persist step's soft failures
 *     with the one-targeted-amend recovery, not as an authoring critic.
 *
 * Structural assertions over the authored documentation + skill sources —
 * this does not execute the planning flow.
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

const criticsSection =
  planEpic.match(/### Conditional critics[\s\S]*?(?=\n## Step 3)/)?.[0] ?? '';

describe('author-step critics — shared sub-agent mechanics', () => {
  it('hooks the critics between authoring and gate #2', () => {
    assert.ok(
      criticsSection,
      'plan-epic.md must carry a "Conditional critics" section inside the author step',
    );
    assert.match(
      criticsSection,
      /between authoring and gate #2/i,
      'the critics must be anchored between authoring and gate #2',
    );
  });

  it('dispatches both critics as fresh-context sub-agents, never inline', () => {
    assert.match(
      criticsSection,
      /fresh-context sub-agents/i,
      'critics must be fresh-context sub-agents',
    );
    assert.match(
      criticsSection,
      /never inline skill activations/i,
      'inline activation must be prohibited',
    );
    assert.match(
      criticsSection,
      /cannot grade their own homework/i,
      'the fresh-context rationale must survive',
    );
  });

  it('keeps both critics report-only (no GitHub writes, no tickets persist)', () => {
    assert.match(
      criticsSection,
      /report-only[\s\S]*never write to\s*\n?GitHub/i,
      'critics must never write to GitHub',
    );
    assert.match(
      criticsSection,
      /never persist `tickets\.json`/,
      'critics must never persist tickets.json',
    );
  });

  it('folds critic findings into the gate #2 view with one targeted amend pass', () => {
    assert.match(
      criticsSection,
      /fold into the gate #2\s*\n?view/i,
      'critic findings must surface in the gate #2 view',
    );
    assert.match(
      criticsSection,
      /one targeted amend pass/i,
      'accepted findings get exactly one targeted amend pass',
    );
  });

  it('routes the dispatch decision through the deterministic plan-critics CLI', () => {
    assert.match(
      criticsSection,
      /node \.agents\/scripts\/plan-critics\.js --epic/,
      'the dispatch conditions must be evaluated by the plan-critics CLI, never judged inline',
    );
    assert.match(
      criticsSection,
      /dispatch: true\|false/,
      'the CLI verdict shape must be documented',
    );
    assert.doesNotMatch(
      criticsSection,
      /PR6 wires/i,
      'the PR6 deferral note must be gone — the conditions are wired now',
    );
  });

  it('documents the persist fold + the headless no-dispatch rule (#4496 fix 6)', () => {
    assert.match(
      criticsSection,
      /folded into `plan-persist\.js` as a deterministic\s*\n?pre-write phase/i,
      'the persist fold must be documented',
    );
    assert.match(
      criticsSection,
      /thin shim/i,
      'the standalone CLI must be described as a one-release thin shim',
    );
    assert.match(
      criticsSection,
      /Do \*\*not\*\* run the standalone CLI/,
      'headless runs must not pay the standalone CLI turn',
    );
    assert.match(
      criticsSection,
      /do \*\*not\*\*\s*\n?>?\s*dispatch critic sub-agents/i,
      'headless runs must not dispatch critic sub-agents',
    );
  });

  it('logs every skip decision to the plan-metrics ledger for audit', () => {
    assert.match(
      criticsSection,
      /plan-metrics ledger/,
      'skips must be recorded in the plan-metrics ledger',
    );
    assert.match(
      criticsSection,
      /`kind: "critic-skip"`/,
      'the additive critic-skip record kind must be named',
    );
    assert.match(
      criticsSection,
      /under-firing is auditable/i,
      'the under-firing audit rationale must survive',
    );
    assert.match(
      criticsSection,
      /persist validators remain unchanged hard gates/i,
      'the unchanged-hard-gates guarantee must be stated',
    );
  });
});

describe('consolidation critic — conservation invariant', () => {
  it('links the epic-plan-consolidate skill and keeps the 1:1 skip precondition', () => {
    assert.match(
      criticsSection,
      /\[`epic-plan-consolidate`\]\(\.\.\/\.\.\/skills\/core\/epic-plan-consolidate\/SKILL\.md\)/,
      'the consolidation critic must link its skill',
    );
    assert.match(
      criticsSection,
      /match[\s\S]*?Delivery Slicing table 1:1/i,
      'the deterministic 1:1 skip precondition must survive',
    );
  });

  it('documents the PR6 size/divergence dispatch condition', () => {
    assert.match(
      criticsSection,
      /more than 5 stories/,
      'the >5-stories size condition must be stated',
    );
    assert.match(
      criticsSection,
      /mismatch is confirmed/i,
      'the confirmed-divergence condition must be stated',
    );
  });

  it('keeps the scope-preserving conservation language intact', () => {
    assert.match(
      consolidate,
      /Scope conservation is the load-bearing invariant/,
      'consolidate SKILL must still declare scope conservation load-bearing',
    );
    assert.match(
      criticsSection,
      /scope-preserving only/,
      'plan-epic.md must still call consolidation scope-preserving only',
    );
    assert.match(
      criticsSection,
      /MUST NOT add scope or invent tickets/,
      'the no-added-scope prohibition must survive',
    );
  });
});

describe('pre-mortem critic — code-reading skill (F9)', () => {
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
  });

  it('is wired in plan-epic.md with its report path, before the persist step', () => {
    assert.match(
      criticsSection,
      /\[`epic-plan-premortem`\]\(\.\.\/\.\.\/skills\/core\/epic-plan-premortem\/SKILL\.md\)/,
      'the author step must link the epic-plan-premortem SKILL.md',
    );
    assert.match(
      criticsSection,
      /premortem-report\.md/,
      'the pre-mortem critic must emit its temp report',
    );
    const criticsIdx = planEpic.indexOf('### Conditional critics');
    const persistIdx = planEpic.indexOf('### Run the persist CLI');
    assert.ok(
      criticsIdx > 0 && persistIdx > criticsIdx,
      'the critics must be documented before the persist call',
    );
  });

  it('documents the PR6 risk/size dispatch conditions', () => {
    assert.match(
      criticsSection,
      /overall level is\s*\n?\s*high/i,
      'the high-risk condition must be stated',
    );
    assert.match(
      criticsSection,
      /at least half `maxTickets`/,
      'the half-budget size condition must be stated',
    );
    assert.match(
      criticsSection,
      /`planning\.riskHeuristics` phrase matches/,
      'the risk-heuristics condition must be stated',
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

describe('reachability — demoted to a deterministic persist-side check (design §4)', () => {
  it('documents reachability orphans as a persist-side soft failure', () => {
    const softFailures =
      planEpic.match(
        /### Persist rejections and soft failures[\s\S]*?(?=\n### Handoff)/,
      )?.[0] ?? '';
    assert.ok(
      softFailures,
      'plan-epic.md must carry a persist soft-failures section',
    );
    assert.match(
      softFailures,
      /Reachability orphans/i,
      'reachability must be a named persist-side soft failure',
    );
    assert.match(
      softFailures,
      /navRegistry/,
      'the check must be described as route-glob vs navRegistry',
    );
    assert.match(
      softFailures,
      /one targeted amend/i,
      'the recovery is one targeted amend then re-persist',
    );
    assert.match(
      softFailures,
      /at most one reachability Story/i,
      'the one-reachability-Story cap must survive the demotion',
    );
  });

  it('no longer wires a reachability critic in the author step', () => {
    assert.doesNotMatch(
      criticsSection,
      /Reachability Completeness Critic/,
      'the author step must not carry the retired 8.4 workflow critic',
    );
  });
});
