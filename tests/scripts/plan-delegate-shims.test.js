/**
 * tests/scripts/plan-delegate-shims.test.js — Epic #4474 PR7.
 *
 * The retired delegate CLIs `epic-plan-spec.js` / `epic-plan-decompose.js`
 * survive one release as **re-export shims** carrying external importers of
 * the historic named-export surface (#4474 design §6 PR7 risk note). This
 * file is the shim's contract:
 *
 *   1. every historic named export still resolves through the shim
 *      (an external `import { … } from 'epic-plan-spec.js'` keeps working);
 *   2. direct CLI execution is refused loudly (exit 1) with a pointer to
 *      the successor CLIs (`plan-context.js` / `plan-persist.js`) — a stale
 *      automation script breaks visibly instead of silently no-oping.
 *
 * When the shims are deleted next release, delete this file with them.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const SPEC_SHIM = path.join(PROJECT_ROOT, '.agents/scripts/epic-plan-spec.js');
const DECOMPOSE_SHIM = path.join(
  PROJECT_ROOT,
  '.agents/scripts/epic-plan-decompose.js',
);

const SPEC_EXPORTS = [
  'buildAuthoringContext',
  'drainPendingCleanupAtBoot',
  'forkAndCommitEpicSnapshot',
  'forkMainToEpic',
  'loadRiskVerdict',
  'planEpic',
  'resolveAcceptancePersistence',
  'resolveMemoryDir',
  'resolveReviewRouting',
  'runSpecFreshnessCheck',
  'runSpecPhase',
  'validateRiskVerdict',
];

const DECOMPOSE_EXPORTS = [
  'buildDecomposerSystemPrompt',
  'buildDecompositionContext',
  'orderTicketsForCreation',
  'resolveDependencies',
  'runDecomposePhase',
];

describe('plan delegate shims — named-export compatibility (one release)', () => {
  it('epic-plan-spec.js re-exports the full historic surface', async () => {
    const mod = await import(pathToFileURL(SPEC_SHIM).href);
    for (const name of SPEC_EXPORTS) {
      assert.equal(
        typeof mod[name],
        'function',
        `shim must re-export ${name} for one more release`,
      );
    }
  });

  it('epic-plan-decompose.js re-exports the full historic surface', async () => {
    const mod = await import(pathToFileURL(DECOMPOSE_SHIM).href);
    for (const name of DECOMPOSE_EXPORTS) {
      assert.equal(
        typeof mod[name],
        'function',
        `shim must re-export ${name} for one more release`,
      );
    }
  });
});

describe('plan delegate shims — CLI execution refused with successor pointer', () => {
  for (const [name, file] of [
    ['epic-plan-spec', SPEC_SHIM],
    ['epic-plan-decompose', DECOMPOSE_SHIM],
  ]) {
    it(`${name} exits 1 and names plan-context.js / plan-persist.js`, () => {
      const res = spawnSync(
        process.execPath,
        [file, '--epic', '1', '--emit-context'],
        { cwd: PROJECT_ROOT, encoding: 'utf8' },
      );
      assert.equal(res.status, 1, 'retired CLI must exit non-zero');
      assert.match(res.stderr, /retired/i);
      assert.match(res.stderr, /plan-context\.js/);
      assert.match(res.stderr, /plan-persist\.js/);
    });
  }
});
