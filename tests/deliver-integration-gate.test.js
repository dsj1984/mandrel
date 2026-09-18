/**
 * tests/deliver-integration-gate.test.js
 *
 * Epic #4131 (F1/F4 / AC-1, AC-5) — after the Stage 4 delivery collapse, the
 * navigability journey-suite contract lives in the unified `/mandrel-deliver` per-Story
 * ceremony and configuration docs, not the deleted `deliver-epic.md` Phase 6.5
 * helper. This spec pins that documentation surface without reading retired
 * workflow files.
 *
 * Story #4542 re-pointed the ceremony wording: it is routed off the change level
 * derived from the Story diff, not a planner-authored risk verdict, and the
 * risk→audit-lens router is gone (it had zero callers). The assertions below
 * track the mechanism that actually runs.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertDocMentions, assertDocOmits } from './helpers/doc-assert.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'workflows',
  'mandrel-deliver.md',
);
const CONFIG_DOC_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'docs',
  'configuration.md',
);

const source = readFileSync(WORKFLOW_PATH, 'utf8');
const configDoc = readFileSync(CONFIG_DOC_PATH, 'utf8');

describe('/mandrel-deliver navigability journey-suite contract (Epic #4131 F1/F4)', () => {
  it('keeps navigability journey-suite config tied to the per-Story ceremony', () => {
    assertDocMentions(
      configDoc,
      /quality\.navigability.*per-Story ceremony/,
      'configuration docs must tie navigability to the per-Story ceremony',
    );
    assertDocMentions(
      configDoc,
      /journey suite|journeySuite/,
      'configuration docs must still name the journey suite',
    );
  });

  it('documents the two per-Story decisions in /mandrel-deliver', () => {
    // Story #5366 — the derived level feeds REVIEW DEPTH, not the acceptance
    // verdict owner, which the ceremony profile alone names. The workflow has
    // to name both mechanisms so a reader does not collapse them into one.
    assertDocMentions(
      source,
      /derived level.*review depth/i,
      '/mandrel-deliver must say the derived level feeds review depth',
    );
    assertDocMentions(
      source,
      /ceremony profile alone/i,
      '/mandrel-deliver must name the profile as the sole ceremony input',
    );
    assertDocMentions(
      source,
      /ceremony-routing\.js/,
      '/mandrel-deliver must name the routing mechanism for the ceremony',
    );
  });

  it('never advertises the deleted risk-routed audit-lens router', () => {
    // Story #4542: three shipped docs claimed `resolveAuditLenses` ran inside
    // close while it had zero callers. Deleting the module without this guard
    // would let the claim creep back.
    assertDocOmits(
      source,
      /resolveAuditLenses|audit-lens-routing/,
      '/mandrel-deliver must not advertise the deleted risk-routed audit-lens router',
    );
    assertDocOmits(
      source,
      /risk-routed/i,
      'ceremony is routed off the derived change level, never a risk verdict',
    );
  });
});
