/**
 * tests/deliver-integration-gate.test.js
 *
 * Epic #4131 (F1/F4 / AC-1, AC-5) — after the Stage 4 delivery collapse, the
 * navigability journey-suite contract lives in the unified `/deliver` risk
 * ceremony and configuration docs, not the deleted `deliver-epic.md` Phase 6.5
 * helper. This spec pins that documentation surface without reading retired
 * workflow files.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'workflows',
  'deliver.md',
);
const CONFIG_DOC_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'docs',
  'configuration.md',
);

const source = readFileSync(WORKFLOW_PATH, 'utf8');
const configDoc = readFileSync(CONFIG_DOC_PATH, 'utf8');

describe('/deliver navigability journey-suite contract (Epic #4131 F1/F4)', () => {
  it('keeps navigability journey-suite config tied to the risk-routed ceremony', () => {
    assert.match(
      configDoc,
      /quality\.navigability[\s\S]*risk-routed ceremony/,
      'configuration docs must tie navigability to the risk-routed ceremony',
    );
    assert.match(
      configDoc,
      /journey suite|journeySuite/,
      'configuration docs must still name the journey suite',
    );
  });

  it('documents per-Story risk-routed audit lenses in /deliver', () => {
    assert.match(
      source,
      /risk-routed[\s\S]*audit lenses/i,
      '/deliver must name the risk-routed audit-lens ceremony',
    );
    assert.match(
      source,
      /ceremony-routing\.js/,
      '/deliver must name the routing mechanism for the ceremony',
    );
  });
});
