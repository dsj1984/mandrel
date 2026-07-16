// tests/code-review-audit-routing.test.js
//
// Contract tier (Story #4542): review depth is derived from the diff and the
// derived level reaches BOTH ceremony decisions and the reviewer prompt.
//
// This file replaces the risk-envelope → audit-lens routing contract it used to
// pin (Stories #3876 / #3889 / #3939). That routing module had zero callers
// while three shipped documents claimed it ran inside close, so #4542 deleted
// it. What survives — and what these tests pin — is the chain that is actually
// wired:
//
//   changed files → selectSensitivePathClasses (the audit-suite's own glob
//     machinery, driven by audit-rules.json)
//   → deriveChangeLevel  → resolveDepth              → renderDepthDirective
//                        → resolveCeremonyForRisk
//
// The load-bearing guarantees asserted here:
//   - a NARROW diff touching a sensitive path still resolves `deep`, and the
//     deep directive reaches the reviewer prompt;
//   - a small diff touching nothing sensitive resolves `light`;
//   - depth and the acceptance-critic mode read ONE derived source, so they can
//     never disagree about how risky a change is;
//   - the sensitive-path classes are configuration: the shipped manifest is the
//     registry, and an operator-added class routes with no code change;
//   - an underivable signal fails safe to MORE ceremony, never less.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { selectSensitivePathClasses } from '../.agents/scripts/lib/audit-suite/selector.js';
import { resolveCeremonyForRisk } from '../.agents/scripts/lib/orchestration/ceremony-routing.js';
import {
  deriveChangeLevel,
  resolveDepth,
} from '../.agents/scripts/lib/orchestration/review-depth.js';
import { renderDepthDirective } from '../.agents/scripts/lib/orchestration/review-providers/review-depth.js';

/** Read the shipped manifest — the registry the derivation actually consumes. */
function readShippedRules() {
  const rulesPath = fileURLToPath(
    new URL('../.agents/schemas/audit-rules.json', import.meta.url),
  );
  return JSON.parse(readFileSync(rulesPath, 'utf8'));
}

/** The full close-time chain, end to end, for one change set. */
function resolveDepthForChange(changedFiles, injectedRules) {
  const { level, classes } = deriveChangeLevel({ changedFiles, injectedRules });
  return {
    level,
    classes,
    depth: resolveDepth({
      derivedLevel: level,
      changedFileCount: changedFiles?.length ?? null,
    }),
  };
}

// --- the seeded sensitive-path classes -------------------------------------

describe('audit-rules.json — the shipped sensitive-path registry', () => {
  test('seeds the classes carried over from the retired axis vocabulary', () => {
    const { sensitivePaths } = readShippedRules();
    // These five are the axes the retired verdict schema made REQUIRED; they
    // are the classes whose diffs must still earn a deep pass.
    for (const cls of [
      'security',
      'data-migration',
      'billing',
      'destructive-mutation',
      'public-api',
    ]) {
      assert.ok(sensitivePaths[cls], `expected a '${cls}' class`);
      assert.ok(
        sensitivePaths[cls].filePatterns.length > 0,
        `expected '${cls}' to register at least one glob`,
      );
    }
  });

  test('every registered class routes off the shipped globs, not code', () => {
    const rules = readShippedRules();
    // Drive each class through the real matcher using its own first glob,
    // proving the manifest is the registry the resolver reads.
    for (const [cls, entry] of Object.entries(rules.sensitivePaths)) {
      const sample = entry.filePatterns[0]
        .replace(/\*\*/g, 'x')
        .replace(/\*/g, 'x');
      const matched = selectSensitivePathClasses({
        changedFiles: [sample],
        injectedRules: rules,
      });
      assert.ok(
        matched.includes(cls),
        `expected ${sample} to match class '${cls}'`,
      );
    }
  });
});

// --- the narrow-but-sensitive case: the reason derivation beats deletion ----

describe('a narrow change on a sensitive path still earns a deep review', () => {
  const rules = readShippedRules();

  test('a three-file auth fix → high → deep, despite a tiny diff', () => {
    const { level, classes, depth } = resolveDepthForChange(
      ['src/auth/session.js', 'src/auth/session.test.js', 'docs/changelog.md'],
      rules,
    );
    assert.equal(level, 'high');
    assert.deepEqual(classes, ['security']);
    assert.equal(depth, 'deep');
  });

  test('a one-file migration → deep', () => {
    const { depth, classes } = resolveDepthForChange(
      ['db/migrations/0007_add_index.sql'],
      rules,
    );
    assert.deepEqual(classes, ['data-migration']);
    assert.equal(depth, 'deep');
  });

  test('a one-file billing tweak → deep', () => {
    const { depth, classes } = resolveDepthForChange(
      ['src/billing/proration.js'],
      rules,
    );
    assert.deepEqual(classes, ['billing']);
    assert.equal(depth, 'deep');
  });

  test('the deep directive reaches the reviewer prompt', () => {
    const { depth } = resolveDepthForChange(['src/auth/token.js'], rules);
    const directive = renderDepthDirective(depth);
    assert.match(directive, /Review depth: DEEP/);
    assert.match(directive, /adversarial/);
  });
});

// --- the tiers the derivation preserves ------------------------------------

describe('the existing depth tiers are preserved', () => {
  const rules = readShippedRules();

  test('a small change touching no sensitive path → light, and says so in the prompt', () => {
    const { level, depth } = resolveDepthForChange(
      ['README.md', 'docs/onboarding.md'],
      rules,
    );
    assert.equal(level, 'low');
    assert.equal(depth, 'light');
    assert.match(renderDepthDirective(depth), /Review depth: LIGHT/);
  });

  test('a wide change touching no sensitive path → deep on width alone', () => {
    const changedFiles = Array.from(
      { length: 40 },
      (_, i) => `docs/notes/page-${i}.md`,
    );
    const { level, depth } = resolveDepthForChange(changedFiles, rules);
    assert.equal(level, 'low');
    assert.equal(depth, 'deep');
    assert.match(renderDepthDirective(depth), /Review depth: DEEP/);
  });

  test('an unenumerable diff → standard, never light', () => {
    const { level, depth } = resolveDepthForChange([], rules);
    assert.equal(level, null);
    assert.equal(depth, 'standard');
    assert.match(renderDepthDirective(depth), /Review depth: STANDARD/);
  });
});

// --- one derived source, two decisions -------------------------------------

describe('depth and the acceptance critic read the same derived level', () => {
  const rules = readShippedRules();

  test('a sensitive change routes deep review AND a fresh critic', () => {
    const { level } = deriveChangeLevel({
      changedFiles: ['src/auth/login.js'],
      injectedRules: rules,
    });
    assert.equal(
      resolveDepth({ derivedLevel: level, changedFileCount: 1 }),
      'deep',
    );
    assert.equal(
      resolveCeremonyForRisk({ derivedLevel: level, clusterIndex: 1 }).mode,
      'fresh',
    );
  });

  test('an unremarkable change routes light review AND an inline critic', () => {
    const { level } = deriveChangeLevel({
      changedFiles: ['README.md'],
      injectedRules: rules,
    });
    assert.equal(
      resolveDepth({ derivedLevel: level, changedFileCount: 1 }),
      'light',
    );
    // clusterIndex 1 with the default 0.2 rate is off the sampling stride, so
    // this exercises the un-sampled inline path.
    assert.equal(
      resolveCeremonyForRisk({
        derivedLevel: level,
        clusterIndex: 1,
        freshCriticSampleRate: 0.2,
      }).mode,
      'inline',
    );
  });

  test('an underivable level fails BOTH decisions toward more ceremony', () => {
    const { level } = deriveChangeLevel({ changedFiles: [] });
    assert.equal(resolveDepth({ derivedLevel: level }), 'standard');
    assert.equal(
      resolveCeremonyForRisk({ derivedLevel: level, clusterIndex: 1 }).mode,
      'fresh',
    );
  });
});

// --- extensibility: config, not code ---------------------------------------

test('an operator-added class routes with no code change', () => {
  const rules = readShippedRules();
  const extended = {
    ...rules,
    sensitivePaths: {
      ...rules.sensitivePaths,
      'tenant-isolation': { filePatterns: ['**/tenancy/**'] },
    },
  };
  const { level, classes } = deriveChangeLevel({
    changedFiles: ['src/tenancy/resolver.js'],
    injectedRules: extended,
  });
  assert.equal(level, 'high');
  assert.deepEqual(classes, ['tenant-isolation']);
  assert.equal(
    resolveDepth({ derivedLevel: level, changedFileCount: 1 }),
    'deep',
  );
});
