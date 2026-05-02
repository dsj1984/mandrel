import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolveConfig,
  validateOrchestrationConfig,
} from '../.agents/scripts/lib/config-resolver.js';

// ---------------------------------------------------------------------------
// resolveConfig — orchestration exposure
// ---------------------------------------------------------------------------
describe('resolveConfig — orchestration block', () => {
  it('returns an orchestration property', () => {
    const config = resolveConfig({ bustCache: true });
    assert.ok(
      'orchestration' in config,
      'resolveConfig() result must include an orchestration property',
    );
  });

  it('orchestration is an object or null', () => {
    const config = resolveConfig({ bustCache: true });
    const type = typeof config.orchestration;
    assert.ok(
      config.orchestration === null || type === 'object',
      `orchestration must be null or an object, got: ${type}`,
    );
  });

  // This repo has .agentrc.json with orchestration configured, so it should
  // resolve to a non-null object.
  it('reads orchestration from .agentrc.json (this repo)', () => {
    const config = resolveConfig({ bustCache: true });
    if (config.source.includes('.agentrc.json')) {
      assert.ok(
        config.orchestration !== null,
        'Expected orchestration to be non-null when .agentrc.json has it configured',
      );
      assert.equal(config.orchestration.provider, 'github');
    }
  });
});

// ---------------------------------------------------------------------------
// validateOrchestrationConfig — valid configs
// ---------------------------------------------------------------------------
describe('validateOrchestrationConfig — valid configs', () => {
  it('null orchestration is valid (not configured)', () => {
    assert.doesNotThrow(() => validateOrchestrationConfig(null));
  });

  it('undefined orchestration is valid', () => {
    assert.doesNotThrow(() => validateOrchestrationConfig(undefined));
  });

  it('full valid config passes', () => {
    assert.doesNotThrow(() =>
      validateOrchestrationConfig({
        provider: 'github',
        github: {
          owner: 'dsj1984',
          repo: 'agent-protocols',
          projectNumber: 1,
          operatorHandle: '@dsj1984',
        },
        notifications: {
          mentionOperator: true,
          commentMinLevel: 'medium',
          webhookMinLevel: 'medium',
          terminalMinLevel: 'medium',
        },
      }),
    );
  });

  it('null projectNumber is valid', () => {
    assert.doesNotThrow(() =>
      validateOrchestrationConfig({
        provider: 'github',
        github: {
          owner: 'org',
          repo: 'my-repo',
          projectNumber: null,
        },
      }),
    );
  });

  it('minimal valid config (no notifications, no projectNumber)', () => {
    assert.doesNotThrow(() =>
      validateOrchestrationConfig({
        provider: 'github',
        github: {
          owner: 'org',
          repo: 'my-repo',
        },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// validateOrchestrationConfig — invalid configs (schema violations)
// ---------------------------------------------------------------------------
describe('validateOrchestrationConfig — schema violations', () => {
  it('rejects non-object orchestration', () => {
    assert.throws(
      () => validateOrchestrationConfig('string'),
      /must be an object/,
    );
  });

  it('rejects array orchestration', () => {
    assert.throws(() => validateOrchestrationConfig([]), /must be an object/);
  });

  it('rejects missing provider', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          github: { owner: 'org', repo: 'repo' },
        }),
      /must have required property 'provider'/,
    );
  });

  it('rejects unsupported provider', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'jira',
          github: { owner: 'org', repo: 'repo' },
        }),
      /must be equal to one of the allowed values/,
    );
  });

  it('rejects missing owner', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: { repo: 'my-repo' },
        }),
      /must have required property 'owner'/,
    );
  });

  it('rejects missing repo', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: { owner: 'org' },
        }),
      /must have required property 'repo'/,
    );
  });

  it('rejects empty owner string', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: { owner: '', repo: 'my-repo' },
        }),
      /must NOT have fewer than 1 characters/,
    );
  });

  it('rejects bad operatorHandle (no @ prefix)', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: { owner: 'org', repo: 'repo', operatorHandle: 'no-prefix' },
        }),
      /must match pattern/,
    );
  });

  it('rejects invalid projectNumber (string)', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: { owner: 'org', repo: 'repo', projectNumber: 'abc' },
        }),
      /must be integer,null/,
    );
  });

  it('rejects additional properties at the root', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: { owner: 'org', repo: 'repo' },
          unknownField: true,
        }),
      /must NOT have additional properties/,
    );
  });

  it('rejects typos in the github sub-block', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: {
            owner: 'org',
            repo: 'repo',
            projectNumbre: 1,
          },
        }),
      /must NOT have additional properties/,
    );
  });

  it('rejects typos in the notifications sub-block', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: { owner: 'org', repo: 'repo' },
          notifications: { mentionOperatar: true },
        }),
      /must NOT have additional properties/,
    );
  });

  it('rejects typos in the hitl sub-block', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: { owner: 'org', repo: 'repo' },
          hitl: { riskHigh: true },
        }),
      /must NOT have additional properties/,
    );
  });

  it('rejects typos in the worktreeIsolation sub-block', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: { owner: 'org', repo: 'repo' },
          worktreeIsolation: { enable: true },
        }),
      /must NOT have additional properties/,
    );
  });

  it('rejects typos in the epicRunner sub-block', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: { owner: 'org', repo: 'repo' },
          runners: { epicRunner: { concurencyCap: 3 } },
        }),
      /must NOT have additional properties/,
    );
  });

  it('rejects flat runner sub-blocks at the orchestration root', () => {
    // Story 7 atomic cutover: every runner block now lives under
    // `orchestration.runners`. A flat `epicRunner` is an additional-property
    // violation at the orchestration root.
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: { owner: 'org', repo: 'repo' },
          epicRunner: { enabled: true, concurrencyCap: 3 },
        }),
      /must NOT have additional properties/,
    );
  });

  it("rejects provider:'github' with no github block (conditional require)", () => {
    assert.throws(
      () => validateOrchestrationConfig({ provider: 'github' }),
      /must have required property 'github'/,
    );
  });
});

// ---------------------------------------------------------------------------
// validateOrchestrationConfig — closeRetry
// ---------------------------------------------------------------------------
describe('validateOrchestrationConfig — closeRetry', () => {
  const baseGithub = { owner: 'org', repo: 'repo' };

  it('accepts a full closeRetry block', () => {
    assert.doesNotThrow(() =>
      validateOrchestrationConfig({
        provider: 'github',
        github: baseGithub,
        runners: {
          closeRetry: { maxAttempts: 3, backoffMs: [250, 500, 1000] },
        },
      }),
    );
  });

  it('accepts partial closeRetry (just maxAttempts)', () => {
    assert.doesNotThrow(() =>
      validateOrchestrationConfig({
        provider: 'github',
        github: baseGithub,
        runners: { closeRetry: { maxAttempts: 5 } },
      }),
    );
  });

  it('accepts an empty closeRetry block (defaults apply at consumer)', () => {
    assert.doesNotThrow(() =>
      validateOrchestrationConfig({
        provider: 'github',
        github: baseGithub,
        runners: { closeRetry: {} },
      }),
    );
  });

  it('rejects maxAttempts < 1', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: baseGithub,
          runners: { closeRetry: { maxAttempts: 0 } },
        }),
      /must be >= 1/,
    );
  });

  it('rejects non-integer maxAttempts', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: baseGithub,
          runners: { closeRetry: { maxAttempts: 1.5 } },
        }),
      /must be integer/,
    );
  });

  it('rejects non-array backoffMs', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: baseGithub,
          runners: { closeRetry: { backoffMs: 500 } },
        }),
      /must be array/,
    );
  });

  it('rejects negative backoff entries', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: baseGithub,
          runners: { closeRetry: { backoffMs: [100, -50] } },
        }),
      /must be >= 0/,
    );
  });

  it('rejects typos in closeRetry block', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: baseGithub,
          runners: { closeRetry: { maxAttemps: 3 } },
        }),
      /must NOT have additional properties/,
    );
  });
});

// ---------------------------------------------------------------------------
// validateOrchestrationConfig — worktreeIsolation
// ---------------------------------------------------------------------------
describe('validateOrchestrationConfig — worktreeIsolation', () => {
  const baseGithub = { owner: 'org', repo: 'repo' };

  it('accepts a fully-specified worktreeIsolation block', () => {
    assert.doesNotThrow(() =>
      validateOrchestrationConfig({
        provider: 'github',
        github: baseGithub,
        worktreeIsolation: {
          enabled: true,
          root: '.worktrees',
          nodeModulesStrategy: 'per-worktree',
          primeFromPath: null,
          allowSymlinkOnWindows: false,
          reapOnSuccess: true,
          reapOnCancel: true,
          windowsPathLengthWarnThreshold: 240,
        },
      }),
    );
  });

  it('accepts symlink strategy with primeFromPath + Windows opt-in', () => {
    assert.doesNotThrow(() =>
      validateOrchestrationConfig({
        provider: 'github',
        github: baseGithub,
        worktreeIsolation: {
          nodeModulesStrategy: 'symlink',
          primeFromPath: '.worktrees/primed',
          allowSymlinkOnWindows: true,
        },
      }),
    );
  });

  it('rejects unknown nodeModulesStrategy', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: baseGithub,
          worktreeIsolation: { nodeModulesStrategy: 'bogus' },
        }),
      /must be equal to one of the allowed values/,
    );
  });

  it('rejects unknown property on worktreeIsolation', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: baseGithub,
          worktreeIsolation: { unknownField: true },
        }),
      /must NOT have additional properties/,
    );
  });

  it('rejects root that resolves outside the repo root', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: baseGithub,
          worktreeIsolation: { root: '../../../evil' },
        }),
      /resolves outside the repo root/,
    );
  });

  it('rejects absolute root pointing outside the repo', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: baseGithub,
          worktreeIsolation: { root: '/etc' },
        }),
      /resolves outside the repo root/,
    );
  });

  it('rejects root equal to the repo root itself', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: baseGithub,
          worktreeIsolation: { root: '.' },
        }),
      /resolves outside the repo root/,
    );
  });
});

// ---------------------------------------------------------------------------
// validateOrchestrationConfig — security (shell injection)
// ---------------------------------------------------------------------------
describe('validateOrchestrationConfig — shell injection', () => {
  it('rejects shell injection in owner', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: { owner: 'foo; rm -rf /', repo: 'bar' },
        }),
      /\[Security\]/,
    );
  });

  it('rejects shell injection in repo', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: { owner: 'org', repo: 'bar$(evil)' },
        }),
      /\[Security\]/,
    );
  });

  it('rejects shell injection in operatorHandle', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: { owner: 'org', repo: 'repo', operatorHandle: '@user|hack' },
        }),
      /\[Security\]/,
    );
  });

  it('rejects shell injection in worktreeIsolation.root', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: { owner: 'org', repo: 'repo' },
          worktreeIsolation: { root: '.worktrees;rm -rf /' },
        }),
      /\[Security\]/,
    );
  });
});

// ---------------------------------------------------------------------------
// Conditional required keys (Epic #730 Story 4)
//   - epicRunner.concurrencyCap when enabled !== false
//   - worktreeIsolation.root    when enabled === true
// ---------------------------------------------------------------------------
describe('validateOrchestrationConfig — conditional required keys', () => {
  const baseGithub = { owner: 'org', repo: 'repo' };

  it('rejects epicRunner without concurrencyCap when enabled is omitted', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: baseGithub,
          runners: { epicRunner: { progressReportIntervalSec: 30 } },
        }),
      /must have required property 'concurrencyCap'/,
    );
  });

  it('rejects epicRunner without concurrencyCap when enabled is true', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: baseGithub,
          runners: {
            epicRunner: { enabled: true, progressReportIntervalSec: 30 },
          },
        }),
      /must have required property 'concurrencyCap'/,
    );
  });

  it('accepts epicRunner without concurrencyCap when enabled is false', () => {
    assert.doesNotThrow(() =>
      validateOrchestrationConfig({
        provider: 'github',
        github: baseGithub,
        runners: {
          epicRunner: { enabled: false, progressReportIntervalSec: 30 },
        },
      }),
    );
  });

  it('rejects worktreeIsolation without root when enabled is true', () => {
    assert.throws(
      () =>
        validateOrchestrationConfig({
          provider: 'github',
          github: baseGithub,
          worktreeIsolation: {
            enabled: true,
            nodeModulesStrategy: 'per-worktree',
          },
        }),
      /must have required property 'root'/,
    );
  });

  it('accepts worktreeIsolation without root when enabled is false', () => {
    assert.doesNotThrow(() =>
      validateOrchestrationConfig({
        provider: 'github',
        github: baseGithub,
        worktreeIsolation: { enabled: false },
      }),
    );
  });

  it('accepts worktreeIsolation without root when enabled is omitted', () => {
    // Schema only fires the conditional when `enabled` is explicitly true; an
    // unset block is permitted to omit `root` so partial configs validate.
    assert.doesNotThrow(() =>
      validateOrchestrationConfig({
        provider: 'github',
        github: baseGithub,
        worktreeIsolation: { nodeModulesStrategy: 'per-worktree' },
      }),
    );
  });
});
