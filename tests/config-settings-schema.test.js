import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getAgentrcValidator } from '../.agents/scripts/lib/config-settings-schema.js';

const validate = getAgentrcValidator();

/** Schema-required root: every `.agentrc.json` must declare a `project`
 * block with `paths.{agentRoot, docsRoot, tempRoot}`. Spread `REQ` into
 * accept-test inputs that aren't exercising the required-key behaviour
 * itself. */
const REQ = Object.freeze({
  project: Object.freeze({
    paths: Object.freeze({
      agentRoot: '.agents',
      docsRoot: 'docs',
      tempRoot: 'temp',
    }),
  }),
});

const expectErrors = (doc, ...needles) => {
  const ok = validate(doc);
  assert.equal(ok, false, 'expected schema validation to fail');
  const joined = (validate.errors || [])
    .map((e) => `${e.instancePath} ${e.message}`)
    .join(' | ');
  for (const needle of needles) {
    assert.match(joined, needle, `missing expected error: ${needle}`);
  }
};

describe('AGENTRC_SCHEMA — top-level shape', () => {
  it('accepts a minimal valid doc with project.paths', () => {
    assert.equal(validate({ ...REQ }), true);
  });

  it('rejects an empty doc (missing project)', () => {
    expectErrors({}, /must have required property 'project'/);
  });

  it('rejects an unknown top-level key (typo guard)', () => {
    expectErrors({ ...REQ, unknown: true }, /additional properties/);
  });

  it('rejects legacy agentSettings at the top level', () => {
    expectErrors(
      { agentSettings: { paths: REQ.project.paths } },
      /additional properties/,
    );
  });

  it('rejects legacy orchestration at the top level', () => {
    expectErrors(
      { ...REQ, orchestration: { provider: 'github' } },
      /additional properties/,
    );
  });

  it('accepts the $schema string', () => {
    assert.equal(validate({ $schema: 'x', ...REQ }), true);
  });
});

describe('project.* shape', () => {
  it('requires paths', () => {
    expectErrors({ project: {} }, /must have required property 'paths'/);
  });

  it('rejects paths missing agentRoot', () => {
    expectErrors(
      { project: { paths: { docsRoot: 'docs', tempRoot: 'temp' } } },
      /agentRoot/,
    );
  });

  it('rejects unknown property under paths', () => {
    expectErrors(
      {
        project: {
          paths: { ...REQ.project.paths, scriptsRoot: '.agents/scripts' },
        },
      },
      /additional properties/,
    );
  });

  it('accepts commands.{lintBaseline,test,typecheck,formatCheck,formatWrite}', () => {
    assert.equal(
      validate({
        project: {
          ...REQ.project,
          commands: {
            lintBaseline: 'npm run lint',
            test: 'npm test',
            typecheck: 'node --version',
            formatCheck: 'npx biome format .',
            formatWrite: 'npx biome format --write .',
          },
        },
      }),
      true,
    );
  });

  it('rejects unknown property under commands', () => {
    expectErrors(
      { project: { ...REQ.project, commands: { build: 'npm run build' } } },
      /additional properties/,
    );
  });

  it('accepts null typecheck (disabled-means-null)', () => {
    assert.equal(
      validate({
        project: { ...REQ.project, commands: { typecheck: null } },
      }),
      true,
    );
  });

  it('rejects empty-string typecheck', () => {
    expectErrors(
      { project: { ...REQ.project, commands: { typecheck: '' } } },
      /typecheck/,
    );
  });

  it('rejects shell-injection in baseBranch', () => {
    expectErrors(
      { project: { ...REQ.project, baseBranch: 'main; rm -rf /' } },
      /baseBranch/,
    );
  });
});

describe('github.* shape', () => {
  it('requires owner + repo on the github block', () => {
    expectErrors({ ...REQ, github: {} }, /must have required property 'owner'/);
  });

  it('accepts a populated github block', () => {
    assert.equal(
      validate({
        ...REQ,
        github: {
          owner: 'dsj1984',
          repo: 'mandrel',
          operatorHandle: '@dsj1984',
          branchProtection: {
            enforce: true,
            requiredChecks: [{ name: 'lint', cmd: ['npm', 'run', 'lint'] }],
          },
          mergeMethods: {
            allow_squash_merge: true,
            allow_rebase_merge: false,
          },
          notifications: {
            mentionOperator: false,
            commentEvents: ['state-transition'],
            webhookEvents: ['epic-started'],
          },
        },
      }),
      true,
    );
  });

  it('rejects operatorHandle without @ prefix', () => {
    expectErrors(
      {
        ...REQ,
        github: { owner: 'o', repo: 'r', operatorHandle: 'noprefix' },
      },
      /operatorHandle/,
    );
  });

  it('rejects unknown branchProtection check property', () => {
    expectErrors(
      {
        ...REQ,
        github: {
          owner: 'o',
          repo: 'r',
          branchProtection: { requiredChecks: [{ name: 'x' }] },
        },
      },
      /must have required property 'cmd'/,
    );
  });
});

describe('planning.* shape', () => {
  it('accepts an empty planning block', () => {
    assert.equal(validate({ ...REQ, planning: {} }), true);
  });

  it('accepts riskHeuristics as an array', () => {
    assert.equal(
      validate({
        ...REQ,
        planning: { riskHeuristics: ['no destructive ops'] },
      }),
      true,
    );
  });

  it('accepts riskHeuristics as an extender object', () => {
    assert.equal(
      validate({
        ...REQ,
        planning: { riskHeuristics: { append: ['custom risk'] } },
      }),
      true,
    );
  });

  it('rejects unknown planning property', () => {
    expectErrors(
      { ...REQ, planning: { taskSizing: { maxAcceptance: 6 } } },
      /additional properties/,
    );
  });

  it('accepts planning.maxTickets >= 1', () => {
    assert.equal(validate({ ...REQ, planning: { maxTickets: 60 } }), true);
  });

  it('rejects planning.maxTickets below 1', () => {
    expectErrors({ ...REQ, planning: { maxTickets: 0 } }, /maxTickets/);
  });

  it('rejects unknown planning.context summaryMode', () => {
    expectErrors(
      {
        ...REQ,
        planning: { context: { summaryMode: 'sideways' } },
      },
      /summaryMode/,
    );
  });
});

describe('delivery.* shape', () => {
  it('accepts an empty delivery block', () => {
    assert.equal(validate({ ...REQ, delivery: {} }), true);
  });

  it('accepts execution.timeoutMs', () => {
    assert.equal(
      validate({ ...REQ, delivery: { execution: { timeoutMs: 600000 } } }),
      true,
    );
  });

  it('rejects execution.timeoutMs below 1', () => {
    expectErrors(
      { ...REQ, delivery: { execution: { timeoutMs: 0 } } },
      /timeoutMs/,
    );
  });

  it('rejects legacy executionMaxBuffer key', () => {
    expectErrors(
      { ...REQ, delivery: { executionMaxBuffer: 10485760 } },
      /additional properties/,
    );
  });

  it('rejects legacy friction block', () => {
    expectErrors(
      { ...REQ, delivery: { friction: { repetitiveCommandCount: 3 } } },
      /additional properties/,
    );
  });

  it('accepts delivery.deliverRunner block', () => {
    assert.equal(
      validate({
        ...REQ,
        delivery: {
          deliverRunner: { concurrencyCap: 3, progressReportIntervalSec: 120 },
        },
      }),
      true,
    );
  });

  it('rejects legacy deliverRunner.enabled', () => {
    expectErrors(
      {
        ...REQ,
        delivery: { deliverRunner: { enabled: true } },
      },
      /additional properties/,
    );
  });

  it('accepts worktreeIsolation', () => {
    assert.equal(
      validate({
        ...REQ,
        delivery: {
          worktreeIsolation: {
            enabled: true,
            root: '.worktrees',
            nodeModulesStrategy: 'per-worktree',
          },
        },
      }),
      true,
    );
  });

  it('rejects legacy windowsPathLengthWarnThreshold', () => {
    expectErrors(
      {
        ...REQ,
        delivery: {
          worktreeIsolation: {
            enabled: true,
            root: '.worktrees',
            windowsPathLengthWarnThreshold: 240,
          },
        },
      },
      /additional properties/,
    );
  });

  it('accepts delivery.signals.{hotspot,rework,retry}', () => {
    assert.equal(
      validate({
        ...REQ,
        delivery: {
          signals: {
            hotspot: { p95Multiplier: 1.25 },
            rework: { editsPerFile: 5 },
            retry: { repeatCount: 3 },
          },
        },
      }),
      true,
    );
  });

  it('rejects dropped signals.churn detector', () => {
    expectErrors(
      {
        ...REQ,
        delivery: { signals: { churn: { repeatCount: 4 } } },
      },
      /additional properties/,
    );
  });

  it('rejects dropped signals.idle detector', () => {
    expectErrors(
      {
        ...REQ,
        delivery: { signals: { idle: { gapSeconds: 120 } } },
      },
      /additional properties/,
    );
  });
});

describe('delivery.quality.* shape', () => {
  it('accepts the relocated quality block', () => {
    assert.equal(
      validate({
        ...REQ,
        delivery: {
          quality: {
            maintainability: { targetDirs: ['src'], tolerance: 0.5 },
            crap: {
              enabled: true,
              targetDirs: ['src'],
              newMethodCeiling: 30,
              coveragePath: 'coverage/coverage-final.json',
              requireCoverage: true,
              tolerance: 0.05,
            },
            codingGuardrails: {
              cyclomaticFlag: 8,
              cyclomaticMustFix: 12,
              miDropMustRefactor: 1.5,
              requireSiblingTest: false,
            },
            autoRefresh: {
              enabled: true,
              miDropCap: 1.5,
              crapJumpCap: 5,
              scope: 'diff',
            },
            baselines: {
              lint: { path: 'baselines/lint.json' },
              crap: { path: 'baselines/crap.json' },
              maintainability: { path: 'baselines/maintainability.json' },
            },
          },
        },
      }),
      true,
    );
  });

  it('rejects the renamed-away miDropRefactor field', () => {
    expectErrors(
      {
        ...REQ,
        delivery: {
          quality: { codingGuardrails: { miDropRefactor: 1.5 } },
        },
      },
      /additional properties/,
    );
  });

  it('rejects dropped halsteadTolerance', () => {
    expectErrors(
      {
        ...REQ,
        delivery: {
          quality: { maintainability: { halsteadTolerance: 0.1 } },
        },
      },
      /additional properties/,
    );
  });

  it('c1Exemption is dropped (resolver warns; schema does not enforce closed shape on crap)', () => {
    // crap subschema keeps `additionalProperties: true` so the resolver can
    // emit a soft warning for unknown keys rather than fail validation
    // (existing AC19 contract preserved through the reshape).
    assert.equal(
      validate({
        ...REQ,
        delivery: {
          quality: { crap: { enabled: false, c1Exemption: 'blanket' } },
        },
      }),
      true,
    );
  });

  it('accepts gateScoping (Story 1 forward-compat read)', () => {
    assert.equal(
      validate({
        ...REQ,
        delivery: {
          quality: {
            gateScoping: { scope: 'diff', diffRef: 'main' },
          },
        },
      }),
      true,
    );
  });

  it('requires coveragePath when crap.enabled+requireCoverage are true', () => {
    expectErrors(
      {
        ...REQ,
        delivery: {
          quality: {
            crap: { enabled: true, requireCoverage: true },
          },
        },
      },
      /coveragePath/,
    );
  });
});
