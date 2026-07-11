/**
 * tests/audit-suite/checklist-threading.test.js — Story #4410 (Epic #4405).
 *
 * Pins the write-time local-lens checklist threading contract:
 *   - selection is `resolveLensTier(lens) === 'local'` + the pure
 *     `matchesAnyFilePattern` matcher against the predicted footprint, NEVER
 *     `selectAudits` — the threading path touches no provider and no git diff
 *     (asserted structurally: the module imports neither, and fully offline
 *     injected inputs drive the whole function);
 *   - a footprint matching a local lens returns that lens's checklist; a
 *     footprint matching only a cumulative/global lens returns nothing;
 *   - the assembled payload never exceeds the configured token budget — an
 *     over-budget match is truncated deterministically (stable prefix) and the
 *     drop is logged.
 *
 * The behavioural tests run against the REAL `audit-rules.json` +
 * `.agents/audit-checklists/*.md` build artifacts so the wiring is exercised
 * end-to-end, not against fixtures that could drift from the shipped manifest.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildChecklistPayload,
  DEFAULT_CHECKLIST_TOKEN_BUDGET,
  matchLocalLenses,
  readAuditRules,
} from '../../.agents/scripts/lib/audit-suite/index.js';
import { estimateTokens } from '../../.agents/scripts/lib/orchestration/context-envelope.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(
  HERE,
  '..',
  '..',
  '.agents',
  'scripts',
  'lib',
  'audit-suite',
  'checklist-threading.js',
);

/** A logger spy that records every `warn` line. */
function makeLoggerSpy() {
  const warnings = [];
  return {
    warnings,
    warn: (msg) => warnings.push(msg),
  };
}

test('matchLocalLenses: footprint matching a local lens returns that lens', () => {
  // `tests/**` and `**/*.test.{ts,js}` are the `audit-quality` (local)
  // triggers. `audit-clean-code` (local, universal `**/*` pattern) also
  // matches every footprint, so it is threaded alongside — both in stable
  // AUDIT_LENSES order (clean-code precedes quality).
  const matched = matchLocalLenses({ footprint: ['tests/foo.test.js'] });
  assert.deepEqual(matched, ['clean-code', 'quality']);
});

test('matchLocalLenses: the universal clean-code lens matches EVERY footprint', () => {
  // `audit-clean-code` carries the universal `**/*` filePattern, so its
  // concern is threaded at write-time for any change set (the write-time tier
  // of its formerly-`alwaysRun` behaviour). It is nonetheless a `local` lens,
  // so it is excluded from the Epic-close roster (no double-verification).
  for (const footprint of [
    ['docs/architecture.md'],
    ['.github/workflows/ci.yml'],
    ['app/routes/registry.config'],
    ['README.md'],
    ['.agents/scripts/lib/foo.js'],
  ]) {
    const matched = matchLocalLenses({ footprint });
    assert.ok(
      matched.includes('clean-code'),
      `clean-code must match footprint ${JSON.stringify(footprint)}; got ${JSON.stringify(matched)}`,
    );
  }
});

test('buildChecklistPayload: local-lens footprint returns that checklist', () => {
  const result = buildChecklistPayload({ footprint: ['tests/foo.test.js'] });
  // The universal clean-code lens is threaded alongside the footprint-matched
  // quality lens, in AUDIT_LENSES order.
  assert.deepEqual(result.matchedLenses, ['clean-code', 'quality']);
  assert.deepEqual(result.includedLenses, ['clean-code', 'quality']);
  assert.deepEqual(result.droppedLenses, []);
  // Payload concatenates both real distilled checklists.
  const cleanCodeOnDisk = readFileSync(
    path.join(HERE, '..', '..', '.agents', 'audit-checklists', 'clean-code.md'),
    'utf8',
  ).trim();
  const qualityOnDisk = readFileSync(
    path.join(HERE, '..', '..', '.agents', 'audit-checklists', 'quality.md'),
    'utf8',
  ).trim();
  assert.equal(result.payload, `${cleanCodeOnDisk}\n\n${qualityOnDisk}`);
  assert.ok(result.payload.includes('authoring checklist'));
});

test('buildChecklistPayload: a cumulative-only footprint threads only the universal clean-code lens', () => {
  // `.github/workflows/**` is an `audit-devops` (cumulative) trigger — a
  // cumulative lens is never threaded at write-time. The only local lens that
  // matches is the universal `audit-clean-code`.
  const result = buildChecklistPayload({
    footprint: ['.github/workflows/ci.yml'],
  });
  assert.deepEqual(result.matchedLenses, ['clean-code']);
  assert.deepEqual(result.includedLenses, ['clean-code']);
  assert.ok(!result.matchedLenses.includes('devops'));
  assert.ok(result.payload.length > 0);
});

test('buildChecklistPayload: a global-only footprint threads only the universal clean-code lens', () => {
  // `audit-navigability` / `audit-sre` (global) are never threaded at
  // write-time. A route-ish path matches no other local lens's filePattern,
  // so only the universal `audit-clean-code` is threaded.
  const result = buildChecklistPayload({
    footprint: ['app/routes/registry.config'],
  });
  assert.deepEqual(result.matchedLenses, ['clean-code']);
  assert.ok(!result.matchedLenses.includes('navigability'));
  assert.ok(!result.matchedLenses.includes('sre'));
  assert.ok(result.payload.length > 0);
});

test('buildChecklistPayload: empty / absent footprint returns nothing', () => {
  assert.deepEqual(buildChecklistPayload({ footprint: [] }).matchedLenses, []);
  assert.deepEqual(
    buildChecklistPayload({ footprint: undefined }).matchedLenses,
    [],
  );
  assert.equal(buildChecklistPayload({ footprint: ['   '] }).payload, '');
});

test('buildChecklistPayload: over-budget match is truncated deterministically and logged', () => {
  // This footprint matches multiple LOCAL lenses: lighthouse (**/*.html),
  // performance (src/**/*.js), quality (tests/**), security (**/auth/*.js),
  // seo (**/*.html) — in AUDIT_LENSES order.
  const footprint = [
    'app/index.html',
    'src/auth/login.js',
    'tests/login.test.js',
  ];
  const full = buildChecklistPayload({ footprint });
  assert.ok(
    full.matchedLenses.length >= 3,
    `expected ≥3 matched local lenses, got ${full.matchedLenses.join(', ')}`,
  );

  // A budget below two checklists' combined size forces truncation after the
  // first lens (each distilled checklist is ~130–190 tokens).
  const logger = makeLoggerSpy();
  const tokenBudget = 200;
  const result = buildChecklistPayload({ footprint, tokenBudget, logger });

  // Deterministic prefix truncation: kept lenses are a prefix of the matched
  // set, and at least one lens was dropped.
  assert.deepEqual(
    result.includedLenses,
    full.matchedLenses.slice(0, result.includedLenses.length),
  );
  assert.ok(
    result.droppedLenses.length > 0,
    'expected the over-budget tail to be dropped',
  );
  assert.deepEqual(
    [...result.includedLenses, ...result.droppedLenses],
    full.matchedLenses,
    'included + dropped must exactly partition the matched set',
  );

  // The assembled payload never exceeds the configured cap.
  assert.ok(
    estimateTokens(result.payload) <= tokenBudget,
    `payload ${estimateTokens(result.payload)} tokens exceeds budget ${tokenBudget}`,
  );

  // The drop is logged, naming the dropped lenses.
  assert.ok(
    logger.warnings.some(
      (w) =>
        w.includes('token budget') &&
        result.droppedLenses.every((lens) => w.includes(lens)),
    ),
    `expected a logged drop naming ${result.droppedLenses.join(', ')}; got ${JSON.stringify(logger.warnings)}`,
  );

  // Determinism: a second run with identical inputs yields identical accounting.
  const rerun = buildChecklistPayload({
    footprint,
    tokenBudget,
    logger: makeLoggerSpy(),
  });
  assert.deepEqual(rerun.includedLenses, result.includedLenses);
  assert.deepEqual(rerun.droppedLenses, result.droppedLenses);
  assert.equal(rerun.payload, result.payload);
});

test('buildChecklistPayload: default budget is generous enough to never truncate the full local set', () => {
  // Every local lens matched at once still fits under the default cap — the
  // cap is a safety ceiling, not a routine squeeze.
  const footprint = [
    'app/index.html', // lighthouse, seo
    'app/styles/main.css', // ux-ui, lighthouse
    'src/auth/login.js', // security, performance
    'src/user-profile/settings.js', // privacy
    'tests/login.test.js', // quality
  ];
  const result = buildChecklistPayload({ footprint });
  assert.equal(result.tokenBudget, DEFAULT_CHECKLIST_TOKEN_BUDGET);
  assert.deepEqual(result.droppedLenses, []);
  assert.ok(result.includedLenses.length >= 5);
  assert.ok(estimateTokens(result.payload) <= DEFAULT_CHECKLIST_TOKEN_BUDGET);
});

test('threading path is provider-free and git-diff-free (no selectAudits)', () => {
  // Structural guarantee: the module never *imports* the gate-aware,
  // provider-backed, git-diffing surfaces, and never *calls* the selector or
  // a git spawn. (Prose mentions in comments — e.g. explaining why
  // `selectAudits` is the wrong tool here — are intentionally allowed, so we
  // scan import lines and call sites rather than any substring.)
  const source = readFileSync(MODULE_PATH, 'utf8');
  const importLines = source
    .split('\n')
    .filter((line) => /^\s*import\b/.test(line));
  for (const forbidden of [
    'selector.js', // selectAudits / the git-diffing selector entry (only the pure matchers are pulled — see below)
    'git-utils',
    'provider-factory',
    'ITicketingProvider',
    './runner.js',
  ]) {
    // `selector.js` is imported for the PURE helpers only; assert the import
    // does not pull `selectAudits`.
    const offending = importLines.filter((line) => line.includes(forbidden));
    if (forbidden === 'selector.js') {
      assert.ok(
        offending.every((line) => !line.includes('selectAudits')),
        `checklist-threading must not import selectAudits: ${offending.join(' | ')}`,
      );
    } else {
      assert.deepEqual(
        offending,
        [],
        `checklist-threading must not import '${forbidden}' — the write-time path is provider/git-free`,
      );
    }
  }
  for (const call of ['selectAudits(', 'gitSpawn(', 'createProvider(']) {
    assert.ok(
      !source.includes(call),
      `checklist-threading must not call '${call}' — the write-time path is provider/git-free`,
    );
  }

  // Behavioural guarantee: the whole function runs on fully-injected offline
  // inputs — no ambient provider, no git repo, no ticket fetch. A resolveTier
  // stub and an injected rules manifest + checklist reader are sufficient.
  const rules = {
    audits: {
      'audit-quality': {
        triggers: { filePatterns: ['tests/**'] },
        scope: 'local',
      },
      'audit-architecture': {
        triggers: { filePatterns: ['src/**'] },
        scope: 'cumulative',
      },
    },
  };
  const tierByKey = {
    'audit-quality': 'local',
    'audit-architecture': 'cumulative',
  };
  const result = buildChecklistPayload({
    footprint: ['tests/x.test.js', 'src/x.js'],
    rules,
    resolveTier: (key) => {
      const tier = tierByKey[key];
      if (!tier) throw new Error(`unknown lens ${key}`);
      return tier;
    },
    readChecklist: (lens) => `# ${lens} checklist\n- [ ] item`,
    logger: makeLoggerSpy(),
  });
  assert.deepEqual(result.includedLenses, ['quality']);
  assert.equal(result.payload, '# quality checklist\n- [ ] item');
});

test('readAuditRules: reads the shipped manifest with a scope on every lens', () => {
  const rules = readAuditRules();
  assert.ok(rules.audits && typeof rules.audits === 'object');
  for (const entry of Object.values(rules.audits)) {
    assert.ok(['local', 'cumulative', 'global'].includes(entry.scope));
  }
});
