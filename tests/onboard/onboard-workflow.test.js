import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Story #3522 — Guided /onboard workflow.
 *
 * The `/onboard` workflow is a markdown document that composes four
 * already-shipped building blocks (stack detection, docs scaffolding, the
 * `mandrel doctor` readiness gate, and a started /plan handoff) into a
 * single guided first-successful-run path. These unit tests assert the
 * document exists and documents each required composition point so the
 * workflow cannot silently drop a phase or its first-run framing.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/onboard/ → tests/ → <repo root>
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ONBOARD_PATH = path.join(REPO_ROOT, '.agents', 'workflows', 'onboard.md');

/** Read the onboard workflow doc once for the suite. */
function readOnboard() {
  return readFileSync(ONBOARD_PATH, 'utf8');
}

describe('/onboard workflow document', () => {
  it('exists at .agents/workflows/onboard.md and is non-empty', () => {
    const body = readOnboard();
    assert.ok(body.length > 0, 'onboard.md should not be empty');
  });

  it('documents stack detection via the detect-stack helper', () => {
    const body = readOnboard();
    assert.match(
      body,
      /detect-stack\.js/,
      'should reference the stack-detection helper module',
    );
    assert.match(
      body,
      /detectStack/,
      'should reference the detectStack entry point',
    );
    assert.match(body, /stack/i, 'should describe detecting the stack');
  });

  it('documents a docsContextFiles scaffolding offer', () => {
    const body = readOnboard();
    assert.match(
      body,
      /scaffold-docs\.js/,
      'should reference the docs-scaffolding helper module',
    );
    assert.match(
      body,
      /scaffoldDocs/,
      'should reference the scaffoldDocs entry point',
    );
    assert.match(
      body,
      /docsContextFiles/,
      'should mention the docsContextFiles list it scaffolds',
    );
    assert.match(
      body,
      /\bwrite:\s*false\b/,
      'should preview the missing set without writing before offering',
    );
    assert.match(
      body,
      /offer/i,
      'should frame scaffolding as an offer to the operator',
    );
  });

  it('documents a mandrel doctor readiness gate', () => {
    const body = readOnboard();
    assert.match(
      body,
      /mandrel doctor/,
      'should invoke the mandrel doctor command',
    );
    assert.match(
      body,
      /readiness gate/i,
      'should frame doctor as a readiness gate',
    );
    assert.match(
      body,
      /lib\/cli\/doctor\.js/,
      'should reference the doctor implementation',
    );
    // The gate must stop the handoff on a non-zero doctor exit.
    assert.match(
      body,
      /non-?zero/i,
      'should describe the non-zero (not ready) doctor outcome',
    );
  });

  it('documents a started /plan handoff that is not auto-run', () => {
    const body = readOnboard();
    assert.match(body, /\/plan/, 'should hand off to /plan');
    assert.match(body, /handoff/i, 'should describe the planning handoff');
    assert.match(
      body,
      /not\s+auto-run|do not auto-run|does \*\*not\*\* auto-run/i,
      'should make clear the handoff starts planning but does not auto-run it',
    );
  });

  it('documents a ~15-minute first-successful-run path', () => {
    const body = readOnboard();
    assert.match(
      body,
      /15[\s-]?min/i,
      'should reference the ~15-minute budget',
    );
    assert.match(
      body,
      /first[\s-]success/i,
      'should frame the path as the first successful run',
    );
  });

  it('documents a sample-repo pointer', () => {
    const body = readOnboard();
    assert.match(
      body,
      /sample[\s-]?repo/i,
      'should point at a sample repo for a dry first run',
    );
    assert.match(
      body,
      /detect-stack\.test\.js/,
      'should point at the on-disk sample-repo fixture exercised by the detect-stack tests',
    );
  });

  it('sequences all four phases in order', () => {
    const body = readOnboard();
    const detectIdx = body.indexOf('Phase 1');
    const scaffoldIdx = body.indexOf('Phase 2');
    const doctorIdx = body.indexOf('Phase 3');
    const handoffIdx = body.indexOf('Phase 4');
    assert.ok(detectIdx >= 0, 'Phase 1 should be present');
    assert.ok(scaffoldIdx > detectIdx, 'Phase 2 should follow Phase 1');
    assert.ok(doctorIdx > scaffoldIdx, 'Phase 3 should follow Phase 2');
    assert.ok(handoffIdx > doctorIdx, 'Phase 4 should follow Phase 3');
  });
});
