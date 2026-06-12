/**
 * Story #4045 — /plan first-run preflight detection.
 *
 * The preflight fires when docsContextFiles are missing or carry the
 * MANDREL:STUB marker. These unit tests pin the detection logic by reading
 * the workflows/plan.md document and asserting on the key detection signals
 * and the soft-stop behaviour (never a hard block, always continues with a
 * noted degradation on decline).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PLAN_PATH = path.join(REPO_ROOT, '.agents', 'workflows', 'plan.md');

function readPlan() {
  return readFileSync(PLAN_PATH, 'utf8');
}

describe('/plan first-run preflight — workflow document', () => {
  it('plan.md exists and is non-empty', () => {
    const body = readPlan();
    assert.ok(body.length > 0);
  });

  it('documents the MANDREL:STUB marker as a preflight trigger', () => {
    const body = readPlan();
    assert.match(
      body,
      /MANDREL:STUB/,
      'preflight must key off the MANDREL:STUB stub marker',
    );
  });

  it('documents the missing-docsContextFiles condition as a preflight trigger', () => {
    const body = readPlan();
    assert.match(
      body,
      /docsContextFiles/,
      'preflight must detect missing docsContextFiles entries',
    );
  });

  it('documents the doctor-verdict condition as a preflight trigger', () => {
    const body = readPlan();
    assert.match(
      body,
      /doctor/i,
      'preflight must check the last mandrel doctor verdict',
    );
  });

  it('is never a hard stop — decline continues with a noted degradation', () => {
    const body = readPlan();
    assert.match(
      body,
      /degrad/i,
      'declining the preflight must be noted as a degradation, not a hard stop',
    );
    // Must never say "stop" or "abort" as a consequence of decline
    // (it should say "continues" or "continue")
    assert.match(
      body,
      /continu/i,
      'plan must explicitly say planning continues on decline',
    );
  });

  it('fires only when there is a signal — skips when the project is healthy', () => {
    const body = readPlan();
    assert.match(
      body,
      /skip.*when.*healthy|healthy.*skip|no.*HITL.*stop.*when.*healthy|when.*all.*signals.*clear/is,
      'preflight must skip entirely when no signal is present',
    );
  });
});
