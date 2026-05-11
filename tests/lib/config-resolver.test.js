import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { Volume } from 'memfs';
import {
  BASELINES_DEFAULTS,
  COMMANDS_DEFAULTS,
  getCommands,
  getLimits,
  getPaths,
  getQuality,
  LIMITS_DEFAULTS,
  MAINTAINABILITY_CRAP_DEFAULTS,
  PR_GATE_DEFAULTS,
  PROJECT_ROOT,
  resolveConfig,
  resolveListValue,
  resolveMaintainabilityCrap,
  resolveQuality,
} from '../../.agents/scripts/lib/config-resolver.js';
import { setupFsMock } from './fs-mock.js';

/** The schema requires `paths.agentRoot` / `paths.docsRoot` / `paths.tempRoot`
 * on every loaded agentSettings block (Epic #730 Story 7 — lifted out of the
 * flat root). Spread this into fixtures that aren't testing the required-key
 * behaviour itself so the resolver gets past validation. */
const REQ = Object.freeze({
  paths: Object.freeze({
    agentRoot: '.agents',
    docsRoot: 'docs',
    tempRoot: 'temp',
  }),
});

describe('config-resolver library tests', () => {
  let vol;

  beforeEach((t) => {
    vol = new Volume();
    setupFsMock(t, vol);
    // Reset cached config for each test
    resolveConfig({ bustCache: true });
  });

  it('uses default config when .agentrc.json is missing', () => {
    const config = resolveConfig({ bustCache: true });
    assert.equal(config.source, 'built-in defaults');
    // `agentRoot` is no longer a zero-config default — it is hard-required by
    // the schema so a config without it cannot be silently filled in.
    assert.equal(config.agentSettings.paths.agentRoot, undefined);
    // The seven `*Root` keys moved under `paths` in Epic #773 Story 9 —
    // their defaults flow through `resolvePaths`, not the top-level apply
    // loop, so they live at `settings.paths.scriptsRoot` (etc.) now.
    assert.equal(config.agentSettings.paths.scriptsRoot, '.agents/scripts');
    assert.equal(config.orchestration, null);
  });

  it('throws error when .agentrc.json is malformed JSON', () => {
    const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
    vol.mkdirSync(PROJECT_ROOT, { recursive: true });
    vol.writeFileSync(agentrcPath, '{ invalid json }');

    assert.throws(
      () => resolveConfig({ bustCache: true }),
      /\[config\] Failed to parse .agentrc.json/,
    );
  });

  it('throws error when agentSettings contain security violations', () => {
    const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
    vol.mkdirSync(PROJECT_ROOT, { recursive: true });
    vol.writeFileSync(
      agentrcPath,
      JSON.stringify({
        agentSettings: {
          ...REQ,
          baseBranch: 'main; rm -rf /',
        },
      }),
    );

    assert.throws(
      () => resolveConfig({ bustCache: true }),
      /\[config\] Invalid agentSettings in .agentrc.json/,
    );
  });

  it('rejects malformed release block in agentSettings', () => {
    const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
    vol.mkdirSync(PROJECT_ROOT, { recursive: true });
    vol.writeFileSync(
      agentrcPath,
      JSON.stringify({
        agentSettings: {
          ...REQ,
          release: { autoVersionBump: 'yes-please' },
        },
      }),
    );

    assert.throws(() => resolveConfig({ bustCache: true }), /release/);
  });

  it('rejects shell metacharacters in release.versionFile', () => {
    const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
    vol.mkdirSync(PROJECT_ROOT, { recursive: true });
    vol.writeFileSync(
      agentrcPath,
      JSON.stringify({
        agentSettings: {
          ...REQ,
          release: { versionFile: 'VERSION; rm -rf /' },
        },
      }),
    );

    assert.throws(() => resolveConfig({ bustCache: true }));
  });

  it('accepts release.versionFile: null (default shape)', () => {
    const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
    vol.mkdirSync(PROJECT_ROOT, { recursive: true });
    vol.writeFileSync(
      agentrcPath,
      JSON.stringify({
        agentSettings: {
          ...REQ,
          release: { versionFile: null },
        },
      }),
    );

    assert.doesNotThrow(() => resolveConfig({ bustCache: true }));
  });

  it('resolves .agentrc.json relative to an injected cwd', () => {
    // Two distinct roots, each with its own .agentrc.json — proves the
    // resolver does not read PROJECT_ROOT when an explicit cwd is provided.
    // This is the worktree-isolation invariant: a story agent in a worktree
    // must see its worktree's config, never the main checkout's.
    const rootA = path.resolve(PROJECT_ROOT, '.worktrees/story-A');
    const rootB = path.resolve(PROJECT_ROOT, '.worktrees/story-B');
    vol.mkdirSync(rootA, { recursive: true });
    vol.mkdirSync(rootB, { recursive: true });
    vol.writeFileSync(
      path.join(rootA, '.agentrc.json'),
      JSON.stringify({
        agentSettings: { paths: { ...REQ.paths, agentRoot: 'A-agents' } },
      }),
    );
    vol.writeFileSync(
      path.join(rootB, '.agentrc.json'),
      JSON.stringify({
        agentSettings: { paths: { ...REQ.paths, agentRoot: 'B-agents' } },
      }),
    );

    const cfgA = resolveConfig({ bustCache: true, cwd: rootA });
    const cfgB = resolveConfig({ bustCache: true, cwd: rootB });

    assert.equal(cfgA.agentSettings.paths.agentRoot, 'A-agents');
    assert.equal(cfgB.agentSettings.paths.agentRoot, 'B-agents');
    assert.equal(cfgA.source, path.join(rootA, '.agentrc.json'));
    assert.equal(cfgB.source, path.join(rootB, '.agentrc.json'));
  });

  it('caches per-root, returning distinct objects for distinct cwds', () => {
    const rootA = path.resolve(PROJECT_ROOT, '.worktrees/story-X');
    const rootB = path.resolve(PROJECT_ROOT, '.worktrees/story-Y');
    vol.mkdirSync(rootA, { recursive: true });
    vol.mkdirSync(rootB, { recursive: true });
    vol.writeFileSync(
      path.join(rootA, '.agentrc.json'),
      JSON.stringify({
        agentSettings: { paths: { ...REQ.paths, agentRoot: 'X' } },
      }),
    );
    vol.writeFileSync(
      path.join(rootB, '.agentrc.json'),
      JSON.stringify({
        agentSettings: { paths: { ...REQ.paths, agentRoot: 'Y' } },
      }),
    );

    const a1 = resolveConfig({ bustCache: true, cwd: rootA });
    const a2 = resolveConfig({ cwd: rootA }); // cache hit
    const b1 = resolveConfig({ bustCache: true, cwd: rootB });

    assert.equal(a1, a2, 'same root → cached identity');
    assert.notEqual(a1, b1, 'different roots → different cached objects');
    assert.equal(b1.agentSettings.paths.agentRoot, 'Y');
  });

  it('falls back to defaults when the injected cwd has no .agentrc.json', () => {
    const emptyRoot = path.resolve(PROJECT_ROOT, '.worktrees/story-empty');
    vol.mkdirSync(emptyRoot, { recursive: true });

    const cfg = resolveConfig({ bustCache: true, cwd: emptyRoot });
    assert.equal(cfg.source, 'built-in defaults');
    assert.equal(cfg.orchestration, null);
  });

  it('throws when orchestration.runners.deliverRunner is missing concurrencyCap', () => {
    const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
    vol.mkdirSync(PROJECT_ROOT, { recursive: true });
    vol.writeFileSync(
      agentrcPath,
      JSON.stringify({
        agentSettings: { ...REQ },
        orchestration: {
          provider: 'github',
          github: { owner: 'org', repo: 'repo' },
          runners: {
            deliverRunner: { enabled: true, progressReportIntervalSec: 30 },
          },
        },
      }),
    );

    assert.throws(
      () => resolveConfig({ bustCache: true }),
      /Invalid orchestration configuration/,
    );
  });

  it('skips orchestration validation when { validate: false }', () => {
    const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
    vol.mkdirSync(PROJECT_ROOT, { recursive: true });
    vol.writeFileSync(
      agentrcPath,
      JSON.stringify({
        agentSettings: { ...REQ },
        orchestration: {
          provider: 'github',
          github: { owner: 'org', repo: 'repo' },
          runners: {
            deliverRunner: { enabled: true, progressReportIntervalSec: 30 },
          },
        },
      }),
    );

    assert.doesNotThrow(() =>
      resolveConfig({ bustCache: true, validate: false }),
    );
  });

  it('merges defaults with loaded config', () => {
    const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
    vol.mkdirSync(PROJECT_ROOT, { recursive: true });
    vol.writeFileSync(
      agentrcPath,
      JSON.stringify({
        agentSettings: {
          paths: { ...REQ.paths, agentRoot: 'custom-agents' },
        },
      }),
    );

    const config = resolveConfig({ bustCache: true });
    assert.equal(config.agentSettings.paths.agentRoot, 'custom-agents');
    assert.equal(config.agentSettings.paths.scriptsRoot, '.agents/scripts'); // default
  });

  describe('quality.crap defaults + deep-merge', () => {
    it('injects full crap defaults when the block is absent', () => {
      const config = resolveConfig({ bustCache: true });
      assert.deepEqual(config.agentSettings.quality.crap, {
        enabled: true,
        targetDirs: ['src'],
        newMethodCeiling: 30,
        coveragePath: 'coverage/coverage-final.json',
        // Default tolerance bumped 0.001 → 0.05 in 5.36.1.
        tolerance: 0.05,
        requireCoverage: true,
        friction: { markerKey: 'crap-baseline-regression' },
        refreshTag: 'baseline-refresh:',
        // Story #1394 (Epic #1386): diff-scoped default + ref live in the
        // crap config block so the precedence chain in
        // `resolveCrapChangedSince` reads them like any other config field.
        defaultScope: 'diff',
        diffRef: 'main',
      });
    });

    it('injects crap defaults when loaded config omits the block', () => {
      const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
      vol.mkdirSync(PROJECT_ROOT, { recursive: true });
      vol.writeFileSync(
        agentrcPath,
        JSON.stringify({ agentSettings: { ...REQ } }),
      );

      const config = resolveConfig({ bustCache: true });
      assert.equal(config.agentSettings.quality.crap.newMethodCeiling, 30);
      assert.deepEqual(config.agentSettings.quality.crap.targetDirs, ['src']);
    });

    it('{ append } extends targetDirs and dedupes within user input', () => {
      const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
      vol.mkdirSync(PROJECT_ROOT, { recursive: true });
      vol.writeFileSync(
        agentrcPath,
        JSON.stringify({
          agentSettings: {
            ...REQ,
            quality: {
              crap: {
                targetDirs: {
                  // Intentionally include a duplicate to prove dedupe within
                  // the user-supplied list.
                  append: ['packages/foo/src', 'packages/foo/src'],
                },
              },
            },
          },
        }),
      );

      const config = resolveConfig({ bustCache: true });
      assert.deepEqual(config.agentSettings.quality.crap.targetDirs, [
        'src',
        'packages/foo/src',
      ]);
    });

    it('{ prepend } places entries before append, atop the framework default', () => {
      const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
      vol.mkdirSync(PROJECT_ROOT, { recursive: true });
      vol.writeFileSync(
        agentrcPath,
        JSON.stringify({
          agentSettings: {
            ...REQ,
            quality: {
              crap: {
                targetDirs: {
                  prepend: ['apps/web/src'],
                  append: ['packages/lib/src'],
                },
              },
            },
          },
        }),
      );

      const config = resolveConfig({ bustCache: true });
      assert.deepEqual(config.agentSettings.quality.crap.targetDirs, [
        'apps/web/src',
        'src',
        'packages/lib/src',
      ]);
    });

    it('plain-array targetDirs replaces framework defaults', () => {
      const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
      vol.mkdirSync(PROJECT_ROOT, { recursive: true });
      vol.writeFileSync(
        agentrcPath,
        JSON.stringify({
          agentSettings: {
            ...REQ,
            quality: { crap: { targetDirs: ['src'] } },
          },
        }),
      );

      const config = resolveConfig({ bustCache: true });
      assert.deepEqual(config.agentSettings.quality.crap.targetDirs, ['src']);
    });

    it('scalar override leaves other crap defaults intact', () => {
      const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
      vol.mkdirSync(PROJECT_ROOT, { recursive: true });
      vol.writeFileSync(
        agentrcPath,
        JSON.stringify({
          agentSettings: {
            ...REQ,
            quality: { crap: { newMethodCeiling: 40 } },
          },
        }),
      );

      const config = resolveConfig({ bustCache: true });
      const crap = config.agentSettings.quality.crap;
      assert.equal(crap.newMethodCeiling, 40);
      assert.equal(crap.enabled, true);
      assert.equal(crap.tolerance, 0.05);
      assert.equal(crap.coveragePath, 'coverage/coverage-final.json');
      assert.deepEqual(crap.targetDirs, ['src']);
      assert.deepEqual(crap.friction, {
        markerKey: 'crap-baseline-regression',
      });
    });

    it('unknown crap key warns but does not fail resolution', (t) => {
      const warnings = [];
      t.mock.method(console, 'warn', (msg) => warnings.push(msg));

      const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
      vol.mkdirSync(PROJECT_ROOT, { recursive: true });
      vol.writeFileSync(
        agentrcPath,
        JSON.stringify({
          agentSettings: {
            ...REQ,
            quality: {
              crap: { newMethodCeiling: 40, nonsenseKey: true },
            },
          },
        }),
      );

      const config = resolveConfig({ bustCache: true });
      assert.equal(config.agentSettings.quality.crap.newMethodCeiling, 40);
      assert.ok(
        warnings.some((m) => /nonsenseKey/.test(m)),
        `expected a warning mentioning 'nonsenseKey'; got ${JSON.stringify(warnings)}`,
      );
    });

    it('quality.maintainability.targetDirs supports { append }', () => {
      const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
      vol.mkdirSync(PROJECT_ROOT, { recursive: true });
      vol.writeFileSync(
        agentrcPath,
        JSON.stringify({
          agentSettings: {
            ...REQ,
            quality: {
              maintainability: { targetDirs: { append: ['packages/foo'] } },
            },
          },
        }),
      );

      const config = resolveConfig({ bustCache: true });
      assert.deepEqual(
        config.agentSettings.quality.maintainability.targetDirs,
        ['packages/foo'],
      );
    });

    it('friction.markerKey override merges shallowly with defaults', () => {
      const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
      vol.mkdirSync(PROJECT_ROOT, { recursive: true });
      vol.writeFileSync(
        agentrcPath,
        JSON.stringify({
          agentSettings: {
            ...REQ,
            quality: {
              crap: { friction: { markerKey: 'custom-marker' } },
            },
          },
        }),
      );

      const config = resolveConfig({ bustCache: true });
      assert.deepEqual(config.agentSettings.quality.crap.friction, {
        markerKey: 'custom-marker',
      });
    });

    it('rejects a malformed crap block (invalid scalar type)', () => {
      const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
      vol.mkdirSync(PROJECT_ROOT, { recursive: true });
      vol.writeFileSync(
        agentrcPath,
        JSON.stringify({
          agentSettings: {
            ...REQ,
            quality: { crap: { newMethodCeiling: 'tall' } },
          },
        }),
      );

      assert.throws(() => resolveConfig({ bustCache: true }));
    });
  });

  describe('deep-merge helpers (unit)', () => {
    it('resolveListValue: undefined → copy of default', () => {
      const d = ['a', 'b'];
      const result = resolveListValue(d, undefined);
      assert.deepEqual(result, ['a', 'b']);
      assert.notEqual(result, d, 'returns a fresh array');
    });

    it('resolveListValue: plain array replaces', () => {
      assert.deepEqual(resolveListValue(['a'], ['x', 'y']), ['x', 'y']);
    });

    it('resolveListValue: { append } extends and dedupes', () => {
      assert.deepEqual(resolveListValue(['a', 'b'], { append: ['b', 'c'] }), [
        'a',
        'b',
        'c',
      ]);
    });

    it('resolveListValue: { prepend } places before defaults and dedupes', () => {
      assert.deepEqual(resolveListValue(['a', 'b'], { prepend: ['z', 'a'] }), [
        'z',
        'a',
        'b',
      ]);
    });

    it('resolveListValue: { append, prepend } combine', () => {
      assert.deepEqual(
        resolveListValue(['b'], { prepend: ['a'], append: ['c'] }),
        ['a', 'b', 'c'],
      );
    });

    it('resolveMaintainabilityCrap: returns frozen-ish fresh object from defaults', () => {
      const a = resolveMaintainabilityCrap(undefined);
      const b = resolveMaintainabilityCrap(undefined);
      assert.notEqual(a, b, 'distinct instances per call');
      assert.notEqual(
        a.targetDirs,
        MAINTAINABILITY_CRAP_DEFAULTS.targetDirs,
        'targetDirs is a copy, not the frozen default array',
      );
      a.targetDirs.push('mutate');
      assert.deepEqual(b.targetDirs, ['src']);
    });

    it('resolveQuality: userQuality null → all sub-blocks default-populated', () => {
      const out = resolveQuality(undefined);
      assert.deepEqual(out.maintainability.targetDirs, []);
      assert.equal(out.crap.newMethodCeiling, 30);
      assert.deepEqual(out.prGate.checks, []);
      assert.equal(out.baselines.lint.path, BASELINES_DEFAULTS.lint.path);
    });
  });

  describe('getQuality (Epic #730 Story 6)', () => {
    it('returns full default tree when quality block is absent', () => {
      const out = getQuality({ agentSettings: { ...REQ } });
      assert.deepEqual(out.maintainability.targetDirs, []);
      assert.equal(out.crap.enabled, MAINTAINABILITY_CRAP_DEFAULTS.enabled);
      assert.deepEqual(out.prGate.checks, [...PR_GATE_DEFAULTS.checks]);
      assert.equal(out.baselines.crap.path, BASELINES_DEFAULTS.crap.path);
    });

    it('honours user overrides per sub-block', () => {
      const out = getQuality({
        agentSettings: {
          ...REQ,
          quality: {
            maintainability: { targetDirs: ['src', 'lib'] },
            crap: { newMethodCeiling: 50 },
            prGate: { checks: ['lint'] },
            baselines: { lint: { path: 'custom/lint.json' } },
          },
        },
      });
      assert.deepEqual(out.maintainability.targetDirs, ['src', 'lib']);
      assert.equal(out.crap.newMethodCeiling, 50);
      assert.deepEqual(out.prGate.checks, ['lint']);
      assert.equal(out.baselines.lint.path, 'custom/lint.json');
      // Defaults preserved for sibling baselines
      assert.equal(out.baselines.crap.path, BASELINES_DEFAULTS.crap.path);
    });

    it('accepts a bare agentSettings bag (no enclosing config)', () => {
      const out = getQuality({
        ...REQ,
        quality: { crap: { tolerance: 0.05 } },
      });
      assert.equal(out.crap.tolerance, 0.05);
      assert.equal(out.crap.newMethodCeiling, 30);
    });

    it('returns defaults for null/undefined input', () => {
      assert.deepEqual(getQuality(null).prGate.checks, []);
      assert.deepEqual(getQuality(undefined).prGate.checks, []);
    });
  });

  describe('getCommands (Epic #730 Story 5)', () => {
    it('returns COMMANDS_DEFAULTS when commands block is absent', () => {
      const out = getCommands({ agentSettings: { ...REQ } });
      assert.deepEqual(out, { ...COMMANDS_DEFAULTS });
    });

    it('preserves user values and fills missing keys with defaults', () => {
      const out = getCommands({
        agentSettings: {
          ...REQ,
          commands: { validate: 'pnpm lint', test: 'pnpm test' },
        },
      });
      assert.equal(out.validate, 'pnpm lint');
      assert.equal(out.test, 'pnpm test');
      assert.equal(out.lintBaseline, COMMANDS_DEFAULTS.lintBaseline);
      assert.equal(out.typecheck, null);
      assert.equal(out.build, null);
    });

    it('honours explicit null on typecheck/build (not the default)', () => {
      const out = getCommands({
        agentSettings: { ...REQ, commands: { typecheck: null, build: null } },
      });
      assert.equal(out.typecheck, null);
      assert.equal(out.build, null);
    });

    it('accepts a bare agentSettings bag (no enclosing config)', () => {
      const out = getCommands({
        ...REQ,
        commands: { validate: 'make lint' },
      });
      assert.equal(out.validate, 'make lint');
      assert.equal(out.test, COMMANDS_DEFAULTS.test);
    });

    it('returns defaults for null/undefined input', () => {
      assert.deepEqual(getCommands(null), { ...COMMANDS_DEFAULTS });
      assert.deepEqual(getCommands(undefined), { ...COMMANDS_DEFAULTS });
    });

    it('resolveConfig surfaces the grouped commands block on .agentrc.json reads', () => {
      vol.fromJSON({
        [path.join(PROJECT_ROOT, '.agentrc.json')]: JSON.stringify({
          agentSettings: {
            ...REQ,
            commands: {
              validate: 'npm run check',
              test: 'npm run spec',
              typecheck: 'tsc --noEmit',
            },
          },
        }),
      });
      const { agentSettings } = resolveConfig({ bustCache: true });
      const cmds = getCommands({ agentSettings });
      assert.equal(cmds.validate, 'npm run check');
      assert.equal(cmds.test, 'npm run spec');
      assert.equal(cmds.typecheck, 'tsc --noEmit');
    });
  });

  describe('getPaths (Epic #730 Story 7; extended in Epic #773 Story 9)', () => {
    it('returns the configured roots + auditOutputDir default', () => {
      const out = getPaths({ agentSettings: { ...REQ } });
      assert.equal(out.agentRoot, '.agents');
      assert.equal(out.docsRoot, 'docs');
      assert.equal(out.tempRoot, 'temp');
      assert.equal(out.auditOutputDir, 'temp');
    });

    it('honours operator-supplied auditOutputDir override', () => {
      const out = getPaths({
        agentSettings: {
          paths: { ...REQ.paths, auditOutputDir: 'reports' },
        },
      });
      assert.equal(out.auditOutputDir, 'reports');
    });

    it('returns undefined required roots + default auditOutputDir for null/undefined input', () => {
      const out = getPaths(null);
      assert.equal(out.agentRoot, undefined);
      assert.equal(out.docsRoot, undefined);
      assert.equal(out.tempRoot, undefined);
      assert.equal(out.auditOutputDir, 'temp');
    });

    it('accepts a bare agentSettings bag', () => {
      const out = getPaths({
        paths: { ...REQ.paths, agentRoot: 'custom' },
      });
      assert.equal(out.agentRoot, 'custom');
      assert.equal(out.docsRoot, 'docs');
    });

    it('fills in framework defaults for the seven *Root keys', () => {
      const out = getPaths({ agentSettings: { ...REQ } });
      assert.equal(out.scriptsRoot, '.agents/scripts');
      assert.equal(out.workflowsRoot, '.agents/workflows');
      assert.equal(out.personasRoot, '.agents/personas');
      assert.equal(out.schemasRoot, '.agents/schemas');
      assert.equal(out.skillsRoot, '.agents/skills');
      assert.equal(out.templatesRoot, '.agents/templates');
      assert.equal(out.rulesRoot, '.agents/rules');
    });

    it('honours operator-supplied *Root overrides', () => {
      const out = getPaths({
        agentSettings: {
          paths: {
            ...REQ.paths,
            scriptsRoot: 'custom/scripts',
            personasRoot: 'custom/personas',
          },
        },
      });
      assert.equal(out.scriptsRoot, 'custom/scripts');
      assert.equal(out.personasRoot, 'custom/personas');
      // Untouched keys still fall back to defaults.
      assert.equal(out.skillsRoot, '.agents/skills');
    });
  });

  describe('getLimits (Epic #730 Story 8)', () => {
    it('returns LIMITS_DEFAULTS when limits block is absent', () => {
      const out = getLimits({ agentSettings: { ...REQ } });
      assert.deepEqual(out, {
        ...LIMITS_DEFAULTS,
        friction: { ...LIMITS_DEFAULTS.friction },
      });
    });

    it('preserves user scalar overrides + falls back on the rest', () => {
      const out = getLimits({
        agentSettings: {
          ...REQ,
          limits: { maxTickets: 99, executionTimeoutMs: 60000 },
        },
      });
      assert.equal(out.maxTickets, 99);
      assert.equal(out.executionTimeoutMs, 60000);
      assert.equal(out.maxTokenBudget, LIMITS_DEFAULTS.maxTokenBudget);
      assert.equal(
        out.maxInstructionSteps,
        LIMITS_DEFAULTS.maxInstructionSteps,
      );
    });

    it('shallow-merges friction overrides without re-listing siblings', () => {
      const out = getLimits({
        agentSettings: {
          ...REQ,
          limits: { friction: { stagnationStepCount: 7 } },
        },
      });
      assert.equal(out.friction.stagnationStepCount, 7);
      assert.equal(
        out.friction.repetitiveCommandCount,
        LIMITS_DEFAULTS.friction.repetitiveCommandCount,
      );
    });

    it('returns defaults for null/undefined input', () => {
      assert.deepEqual(getLimits(null).friction, {
        ...LIMITS_DEFAULTS.friction,
      });
      assert.deepEqual(getLimits(undefined).friction, {
        ...LIMITS_DEFAULTS.friction,
      });
    });

    it('exposes planningContext defaults (Epic #817 Story 9)', () => {
      const out = getLimits({ agentSettings: { ...REQ } });
      assert.deepEqual(out.planningContext, {
        ...LIMITS_DEFAULTS.planningContext,
      });
    });

    it('shallow-merges planningContext overrides without re-listing siblings', () => {
      const out = getLimits({
        agentSettings: {
          ...REQ,
          limits: { planningContext: { summaryMode: 'always' } },
        },
      });
      assert.equal(out.planningContext.summaryMode, 'always');
      assert.equal(
        out.planningContext.maxBytes,
        LIMITS_DEFAULTS.planningContext.maxBytes,
      );
    });
  });

  // Epic #1142 Story #1157 deleted the prior close-tail config accessor
  // block in lockstep with the SDL surface collapse. The retro skip is
  // now CLI-only via `--skip-retro` on /epic-deliver. See
  // `docs/CHANGELOG.md` 5.40.0 for the full deletion list and migration.
});
