/**
 * /mandrel-leverage workflow contract (Story #5839).
 *
 * A structural assertion over the authored workflow source and the generated
 * workflows catalog — it does not execute the workflow (that is the host
 * LLM's job). It pins the load-bearing contract: the five phases, the `--bar`
 * default and `--evidence` input, the bets-document sections, the citation
 * bar, the two maker-blind skeptics per bet, the survivor rule, the
 * no-override rule, carried-forward refutations, the per-write HITL gate, and
 * that the workflow never files an issue or mutates a label itself.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertDocMentions } from './helpers/doc-assert.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const source = readFileSync(
  path.join(REPO_ROOT, '.agents', 'workflows', 'mandrel-leverage.md'),
  'utf8',
);

describe('mandrel-leverage workflow contract', () => {
  it('opens with a frontmatter description of at least 30 characters', () => {
    const match = source.match(
      /^---\r?\n[\s\S]*?\bdescription:\s*(.+)\r?\n[\s\S]*?---\r?\n/,
    );
    assert.ok(
      match,
      'mandrel-leverage.md must begin with a description frontmatter block',
    );
    assert.ok(
      match[1].trim().length >= 30,
      'description must be at least 30 characters',
    );
  });

  it('defines the five phases', () => {
    for (const heading of [
      /^## Phase 0 — Evidence intake/m,
      /^## Phase 1 — Diverge/m,
      /^## Phase 2 — Skeptics/m,
      /^## Phase 3 — Converge/m,
      /^## Phase 4 — Hand-off/m,
    ]) {
      assert.match(source, heading, `missing phase heading ${heading}`);
    }
  });

  it('documents the --bar default of 10 and the --evidence input', () => {
    assertDocMentions(
      source,
      /`--bar`[^|]*\|[^|]*\|[^|]*\|[^|]*Default `10`/,
      '--bar must default to 10',
    );
    assertDocMentions(
      source,
      /`--evidence` \|/,
      'must document the --evidence input',
    );
  });

  it('writes temp/leverage/<run-id>/bets.md with the four outcome sections', () => {
    assertDocMentions(
      source,
      /`temp\/leverage\/<run-id>\/bets\.md`/,
      'must name the bets artifact',
    );
    for (const section of [
      'Survivors',
      'Downgraded',
      'Refuted',
      'Missing evidence',
    ]) {
      assert.match(
        source,
        new RegExp(`^- \`## ${section}\``, 'm'),
        `bets.md must carry ## ${section}`,
      );
    }
  });

  it('requires a path:line or signal citation on every bet', () => {
    assertDocMentions(
      source,
      /every bet carries at least one `path:line` or signal citation/,
      'every bet must carry a citation',
    );
  });

  it('dispatches two maker-blind general-purpose skeptics per bet with only the bet block and evidence paths', () => {
    assertDocMentions(
      source,
      /## Phase 2 — Skeptics \(maker-blind\)/,
      'skeptic phase must be maker-blind',
    );
    assertDocMentions(
      source,
      /two independent `subagent_type: general-purpose` skeptics/,
      'must dispatch two general-purpose skeptics',
    );
    assertDocMentions(
      source,
      /only the bet block and the evidence paths/,
      'skeptics see only the bet block and evidence paths',
    );
  });

  it('survives a bet only when both skeptics clear the bar, and never overrides a verdict', () => {
    assertDocMentions(
      source,
      /survivor\*\* — both skeptics credit at least the bar/,
      'survivor rule',
    );
    assertDocMentions(
      source,
      /The caller never overrides a verdict/,
      'no-override rule',
    );
  });

  it('carries prior refutations forward unless new evidence names what changed', () => {
    assertDocMentions(
      source,
      /carried forward as refuted unless new evidence names what changed/,
      'prior refutations must carry forward',
    );
  });

  it('confirms every seed write and /mandrel-plan invocation individually and never files or labels itself', () => {
    assertDocMentions(
      source,
      /Every seed write and every `\/mandrel-plan` invocation is confirmed individually/,
      'seed writes and plan invocations must be confirmed individually',
    );
    assertDocMentions(
      source,
      /never persists an issue, never mutates a label/,
      'must never persist an issue or mutate a label',
    );
    assertDocMentions(
      source,
      /\/mandrel-plan --seed-file/,
      'must chain /mandrel-plan --seed-file',
    );
  });

  it('is listed in the generated workflows catalog doc and wired into SDLC and mandrel-plan', () => {
    const doc = readFileSync(
      path.join(REPO_ROOT, '.agents', 'docs', 'workflows.md'),
      'utf8',
    );
    assert.match(
      doc,
      /\|\s*`\/mandrel-leverage`\s*\|/,
      'workflows.md must list /mandrel-leverage',
    );
    const sdlc = readFileSync(path.join(REPO_ROOT, 'docs', 'SDLC.md'), 'utf8');
    assert.match(
      sdlc,
      /^\| `\/mandrel-leverage/m,
      'SDLC quick reference must carry a /mandrel-leverage row',
    );
    const plan = readFileSync(
      path.join(REPO_ROOT, '.agents', 'workflows', 'mandrel-plan.md'),
      'utf8',
    );
    assert.match(
      plan,
      /\(mandrel-leverage\.md\)/,
      'mandrel-plan.md See also must point at /mandrel-leverage',
    );
  });
});
