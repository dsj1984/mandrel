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
    assert.equal(paths.auditOutputDir, 'temp/audit');
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

  it('getQuality reads delivery.quality.*', () => {
    const q = getQuality({
      delivery: {
        quality: { maintainability: { targetDirs: ['src'] } },
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

  it('getBaselines reads delivery.quality.baselines.*', () => {
    const b = getBaselines({
      delivery: {
        quality: {
          baselines: { lint: { path: 'custom/lint.json' } },
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
