import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { Volume } from 'memfs';
import {
  BASELINES_DEFAULTS,
  CODING_GUARDRAILS_DEFAULTS,
  COMMANDS_DEFAULTS,
  getBaselines,
  getCommands,
  getLimits,
  getPaths,
  getQuality,
  LIMITS_DEFAULTS,
  MAINTAINABILITY_CRAP_DEFAULTS,
  PROJECT_ROOT,
  resolveCodingGuardrails,
  resolveConfig,
  resolveListValue,
  resolveMaintainabilityCrap,
  resolveQuality,
} from '../../.agents/scripts/lib/config-resolver.js';
import { setupFsMock } from './fs-mock.js';

/**
 * Post-reshape (Epic #1720 Story #1739) the resolver loads the new
 * top-level shape `{ project, github, planning, delivery }`. The required
 * keys are now `project.paths.{agentRoot, docsRoot, tempRoot}`. The
 * resolver still exposes a legacy `agentSettings` + `orchestration` shim
 * for the migration window.
 */
const REQ = Object.freeze({
  project: Object.freeze({
    paths: Object.freeze({
      agentRoot: '.agents',
      docsRoot: 'docs',
      tempRoot: 'temp',
    }),
  }),
});

describe('config-resolver — loading + legacy shim', () => {
  let vol;

  beforeEach((t) => {
    vol = new Volume();
    setupFsMock(t, vol);
    resolveConfig({ bustCache: true });
  });

  it('uses zero-config defaults when .agentrc.json is missing', () => {
    const config = resolveConfig({ bustCache: true });
    assert.equal(config.source, 'built-in defaults');
    assert.equal(config.project.paths.agentRoot, '.agents');
    assert.equal(config.project.paths.scriptsRoot, '.agents/scripts');
    assert.equal(config.github, null);
  });

  it('throws on malformed JSON', () => {
    const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
    vol.mkdirSync(PROJECT_ROOT, { recursive: true });
    vol.writeFileSync(agentrcPath, '{ invalid json }');
    assert.throws(
      () => resolveConfig({ bustCache: true }),
      /\[config\] Failed to parse .agentrc.json/,
    );
  });

  it('throws on shell-injection in project.baseBranch', () => {
    const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
    vol.mkdirSync(PROJECT_ROOT, { recursive: true });
    vol.writeFileSync(
      agentrcPath,
      JSON.stringify({
        project: { ...REQ.project, baseBranch: 'main; rm -rf /' },
      }),
    );
    assert.throws(
      () => resolveConfig({ bustCache: true }),
      /\[config\] Invalid \.agentrc\.json/,
    );
  });

  it('loads a valid doc and surfaces project / github / planning / delivery', () => {
    const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
    vol.mkdirSync(PROJECT_ROOT, { recursive: true });
    vol.writeFileSync(
      agentrcPath,
      JSON.stringify({
        project: { ...REQ.project, baseBranch: 'develop' },
        github: { owner: 'org', repo: 'repo', operatorHandle: '@me' },
        planning: { maxTickets: 40 },
        delivery: { maxTokenBudget: 100000 },
      }),
    );
    const config = resolveConfig({ bustCache: true });
    assert.equal(config.project.baseBranch, 'develop');
    assert.equal(config.github.owner, 'org');
    assert.equal(config.planning.maxTickets, 40);
    assert.equal(config.delivery.maxTokenBudget, 100000);
  });

  it('exposes a legacy agentSettings + orchestration shim', () => {
    const agentrcPath = path.join(PROJECT_ROOT, '.agentrc.json');
    vol.mkdirSync(PROJECT_ROOT, { recursive: true });
    vol.writeFileSync(
      agentrcPath,
      JSON.stringify({
        project: REQ.project,
        github: { owner: 'org', repo: 'repo', operatorHandle: '@me' },
      }),
    );
    const config = resolveConfig({ bustCache: true });
    assert.ok(config.agentSettings);
    assert.equal(config.agentSettings.paths.agentRoot, '.agents');
    assert.ok(config.orchestration);
    assert.equal(config.orchestration.provider, 'github');
    assert.equal(config.orchestration.github.owner, 'org');
  });

  it('caches per resolved root path', () => {
    const first = resolveConfig({ bustCache: true });
    const second = resolveConfig({});
    assert.equal(first, second);
  });
});

describe('helper accessors against the post-reshape shape', () => {
  it('getCommands defaults work when commands block is absent', () => {
    const cmds = getCommands({ project: REQ.project });
    assert.equal(cmds.test, COMMANDS_DEFAULTS.test);
    assert.equal(cmds.typecheck, COMMANDS_DEFAULTS.typecheck);
  });

  it('getCommands reads project.commands', () => {
    const cmds = getCommands({
      project: { ...REQ.project, commands: { test: 'pytest' } },
    });
    assert.equal(cmds.test, 'pytest');
  });

  it('getPaths derives every *Root from agentRoot', () => {
    const paths = getPaths({ project: REQ.project });
    assert.equal(paths.scriptsRoot, '.agents/scripts');
    assert.equal(paths.workflowsRoot, '.agents/workflows');
    assert.equal(paths.auditOutputDir, 'temp/audits');
  });

  it('getLimits exposes the surviving budget + signals surface', () => {
    const lim = getLimits({
      planning: { maxTickets: 100 },
      delivery: {
        maxTokenBudget: 50000,
        execution: { timeoutMs: 1234 },
        signals: { hotspot: { p95Multiplier: 2 } },
      },
    });
    assert.equal(lim.maxTickets, 100);
    assert.equal(lim.maxTokenBudget, 50000);
    assert.equal(lim.executionTimeoutMs, 1234);
    assert.equal(lim.signals.hotspot.p95Multiplier, 2);
    assert.equal(lim.signals.rework.editsPerFile, 5);
  });

  it('getLimits applies framework defaults for empty config', () => {
    const lim = getLimits({});
    assert.equal(lim.maxTickets, LIMITS_DEFAULTS.maxTickets);
    assert.equal(lim.executionTimeoutMs, LIMITS_DEFAULTS.executionTimeoutMs);
  });

  it('getQuality reads delivery.quality.gates.<tier>.*', () => {
    const q = getQuality({
      delivery: {
        quality: {
          gates: { maintainability: { targetDirs: ['src'] } },
        },
      },
    });
    assert.deepEqual(q.maintainability.targetDirs, ['src']);
  });

  it('getQuality defaults match exported defaults', () => {
    const q = getQuality({});
    assert.equal(q.crap.enabled, MAINTAINABILITY_CRAP_DEFAULTS.enabled);
    assert.equal(
      q.codingGuardrails.cyclomaticFlag,
      CODING_GUARDRAILS_DEFAULTS.cyclomaticFlag,
    );
  });

  it('getBaselines reads delivery.quality.gates.<tier>.baselinePath', () => {
    const b = getBaselines({
      delivery: {
        quality: {
          gates: { lint: { baselinePath: 'custom/lint.json' } },
        },
      },
    });
    assert.equal(b.lint.path, 'custom/lint.json');
    assert.equal(b.crap.path, BASELINES_DEFAULTS.crap.path);
  });
});

describe('resolveListValue (extender pattern)', () => {
  it('returns defaults when override is null/undefined', () => {
    assert.deepEqual(resolveListValue(['a', 'b'], undefined), ['a', 'b']);
  });
  it('replaces wholesale when override is an array', () => {
    assert.deepEqual(resolveListValue(['a'], ['x', 'y']), ['x', 'y']);
  });
  it('appends via { append }', () => {
    assert.deepEqual(resolveListValue(['a'], { append: ['z'] }), ['a', 'z']);
  });
  it('prepends via { prepend }', () => {
    assert.deepEqual(resolveListValue(['a'], { prepend: ['z'] }), ['z', 'a']);
  });
});

describe('resolveQuality / resolveMaintainabilityCrap / resolveCodingGuardrails', () => {
  it('resolveQuality returns a fully populated bag for empty input', () => {
    const q = resolveQuality(undefined);
    assert.ok(q.crap);
    assert.ok(q.maintainability);
    assert.ok(q.codingGuardrails);
    assert.ok(q.autoRefresh);
    assert.ok(q.baselines);
    assert.ok(q.gateScoping);
  });

  describe('resolveQuality floors injection (Story #2125)', () => {
    it('does NOT synthesise gate blocks the consumer did not declare', () => {
      // The dispatcher (`selectEnabledGates`) treats a missing gate
      // block as "kind disabled". Injecting synthetic blocks here would
      // silently enable gates the consumer never asked for, so the
      // resolver leaves omitted kinds omitted.
      const q = resolveQuality(undefined);
      assert.ok(
        !Object.hasOwn(q.gates, 'coverage'),
        'coverage gate should be absent when consumer omits it',
      );
      assert.ok(
        !Object.hasOwn(q.gates, 'crap'),
        'crap gate should be absent when consumer omits it',
      );
      assert.ok(
        !Object.hasOwn(q.gates, 'maintainability'),
        'maintainability gate should be absent when consumer omits it',
      );
    });

    it('injects framework defaults when consumer supplies empty floors block', () => {
      const q = resolveQuality({
        gates: {
          coverage: { floors: {} },
          crap: { floors: {} },
          maintainability: { floors: {} },
        },
      });
      assert.deepEqual(q.gates.coverage.floors, {
        '*': { lines: 90, branches: 85, functions: 90 },
      });
      assert.deepEqual(q.gates.crap.floors, { '*': { crap: 20 } });
      // Story #2193: default MI floor targets the rollup `min` axis (the
      // legacy `maintainability` key silently no-oped because the rollup
      // exposes `min` / `p50` / `p95`, not `maintainability`).
      assert.deepEqual(q.gates.maintainability.floors, {
        '*': { min: 70 },
      });
    });

    it('consumer-supplied `*` workspace floor wins over framework default', () => {
      const q = resolveQuality({
        gates: {
          coverage: {
            floors: { '*': { lines: 80, branches: 70, functions: 75 } },
          },
          crap: { floors: { '*': { crap: 25 } } },
          maintainability: { floors: { '*': { maintainability: 60 } } },
        },
      });
      assert.deepEqual(q.gates.coverage.floors['*'], {
        lines: 80,
        branches: 70,
        functions: 75,
      });
      assert.deepEqual(q.gates.crap.floors['*'], { crap: 25 });
      assert.deepEqual(q.gates.maintainability.floors['*'], {
        maintainability: 60,
      });
    });

    it('preserves non-* workspaces and injects framework `*` default alongside', () => {
      const q = resolveQuality({
        gates: {
          coverage: {
            floors: { 'team-a': { lines: 75, branches: 60, functions: 70 } },
          },
        },
      });
      // Consumer's named workspace is preserved as-is.
      assert.deepEqual(q.gates.coverage.floors['team-a'], {
        lines: 75,
        branches: 60,
        functions: 70,
      });
      // The catch-all `*` from defaults is injected alongside.
      assert.deepEqual(q.gates.coverage.floors['*'], {
        lines: 90,
        branches: 85,
        functions: 90,
      });
    });

    it('returns a fresh floors object that does not alias the frozen default', () => {
      const input = { gates: { coverage: { floors: {} } } };
      const q1 = resolveQuality(input);
      const q2 = resolveQuality(input);
      // Mutate q1's floor and confirm q2 is unaffected (i.e. defaults
      // were cloned, not aliased).
      q1.gates.coverage.floors['*'].lines = 50;
      assert.equal(q2.gates.coverage.floors['*'].lines, 90);
    });

    it('preserves non-floors gate fields when injecting defaults', () => {
      const q = resolveQuality({
        gates: {
          crap: { targetDirs: ['src'], floors: {} },
          maintainability: { targetDirs: ['src', 'tests'], floors: {} },
        },
      });
      assert.deepEqual(q.gates.crap.targetDirs, ['src']);
      assert.deepEqual(q.gates.maintainability.targetDirs, ['src', 'tests']);
      // Floors still get defaults injected.
      assert.deepEqual(q.gates.crap.floors, { '*': { crap: 20 } });
      // Story #2193: maintainability default targets rollup `min` axis.
      assert.deepEqual(q.gates.maintainability.floors, {
        '*': { min: 70 },
      });
    });
  });

  it('resolveMaintainabilityCrap applies gateScoping when crap omits the scope keys', () => {
    const crap = resolveMaintainabilityCrap(
      { enabled: true },
      { scope: 'full', diffRef: 'develop' },
    );
    assert.equal(crap.defaultScope, 'full');
    assert.equal(crap.diffRef, 'develop');
  });

  it('resolveCodingGuardrails preserves miDropMustRefactor', () => {
    const guard = resolveCodingGuardrails({ miDropMustRefactor: 2.0 });
    assert.equal(guard.miDropMustRefactor, 2.0);
  });
});
