/**
 * tests/audit-suite/selector-ops-security-routing.test.js — Story #4629.
 *
 * Pins the routing broadenings for the ops/security lenses so a silent
 * narrowing is a test failure, not a quiet coverage gap. All cases drive the
 * REAL `audit-rules.json` through `selectAudits` on the injected-`changedFiles`
 * path (no git spawn), with a deliberately keyword-free provider body so a hit
 * proves *file-pattern* routing — not accidental prose keyword matching.
 *
 *   - AC-3: `audit-security` routes on TypeScript consumers — nested `.ts`/`.tsx`
 *     under auth / middleware directories (it previously matched only a narrow
 *     JS-only auth/crypto glob set).
 *   - AC-4: `audit-privacy` routes on a logging / telemetry file (its close-lens
 *     routing was effectively dead — it matched only a `user-profile` dir).
 *   - AC-6: `audit-sre` participates in automated runs — it routes at gate3 with
 *     ops filePatterns (workflows, Dockerfiles, migrations) and is NOT reachable
 *     from the dead gate4-only state.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { selectAudits } from '../../.agents/scripts/lib/audit-suite/selector.js';
import { MockProvider } from '../fixtures/mock-provider.js';

/** A keyword-free ticket so routing is proven by filePatterns alone. */
function makeProvider() {
  return new MockProvider({
    tickets: {
      900: {
        id: 900,
        title: 'Refactor the widget module',
        body: 'Neutral body prose with no audit-rules.json trigger terms.',
        labels: [],
      },
    },
  });
}

/**
 * Run `selectAudits` over an injected change set with the web-surface probe
 * pinned off (deterministic; no filesystem scan) and no git spawn.
 *
 * @param {string} gate
 * @param {string[]} changedFiles
 * @returns {Promise<string[]>} the selected audit lens ids.
 */
async function select(gate, changedFiles) {
  const result = await selectAudits({
    ticketId: 900,
    gate,
    provider: makeProvider(),
    changedFiles,
    hasWebSurfaceFn: () => false,
    injectedGitSpawn: async () => {
      throw new Error('git must not be spawned on the injected path');
    },
  });
  return result.selectedAudits;
}

test('AC-3: audit-security routes on nested TypeScript auth/middleware files', async () => {
  const selected = await select('gate1', [
    'src/auth/login.ts',
    'src/api/middleware/guard.tsx',
  ]);
  assert.ok(
    selected.includes('audit-security'),
    `a TS auth/middleware diff must route audit-security; got ${JSON.stringify(selected)}`,
  );
});

test('AC-3: audit-security still ignores an unrelated non-sensitive TS file', async () => {
  const selected = await select('gate1', ['docs/notes.md']);
  assert.ok(
    !selected.includes('audit-security'),
    `a docs-only diff must not route audit-security; got ${JSON.stringify(selected)}`,
  );
});

test('AC-4: audit-privacy routes on a logging sink file', async () => {
  const selected = await select('gate1', ['src/lib/logger.ts']);
  assert.ok(
    selected.includes('audit-privacy'),
    `a logging-file diff must route audit-privacy; got ${JSON.stringify(selected)}`,
  );
});

test('AC-4: audit-privacy routes on a telemetry directory file', async () => {
  const selected = await select('gate1', ['src/telemetry/emit.ts']);
  assert.ok(
    selected.includes('audit-privacy'),
    `a telemetry-file diff must route audit-privacy; got ${JSON.stringify(selected)}`,
  );
});

test('AC-6: audit-sre routes at gate3 on a CI workflow change', async () => {
  const selected = await select('gate3', ['.github/workflows/ci.yml']);
  assert.ok(
    selected.includes('audit-sre'),
    `a workflow diff at gate3 must route audit-sre; got ${JSON.stringify(selected)}`,
  );
});

test('AC-6: audit-sre routes at gate3 on a migration change', async () => {
  const selected = await select('gate3', ['db/migrations/001_init.sql']);
  assert.ok(
    selected.includes('audit-sre'),
    `a migration diff at gate3 must route audit-sre; got ${JSON.stringify(selected)}`,
  );
});

test('AC-6: audit-sre is not reachable at gate1 (re-homed off the dead gate4 state, gate3-only)', async () => {
  const selected = await select('gate1', ['.github/workflows/ci.yml']);
  assert.ok(
    !selected.includes('audit-sre'),
    `audit-sre must route only at gate3, not gate1; got ${JSON.stringify(selected)}`,
  );
});
