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

describe('delivery.quality.* shape — uniform gates (Story #1737)', () => {
  const POPULATED_GATES = {
    lint: {
      enabled: true,
      baselinePath: 'baselines/lint.json',
      tolerance: { kind: 'absolute', value: 0 },
      floors: { '*': { errors: 0 } },
    },
    coverage: {
      enabled: true,
      baselinePath: 'baselines/coverage.json',
      tolerance: { kind: 'absolute', value: 0 },
      floors: { '*': { lines: 90, branches: 85, functions: 90 } },
      coveragePath: 'coverage/coverage-final.json',
    },
    crap: {
      enabled: true,
      baselinePath: 'baselines/crap.json',
      tolerance: { kind: 'absolute', value: 0.05 },
      floors: { '*': { crap: 20 } },
      targetDirs: ['src'],
      newMethodCeiling: 30,
      requireCoverage: true,
    },
    maintainability: {
      enabled: true,
      baselinePath: 'baselines/maintainability.json',
      tolerance: { kind: 'absolute', value: 0.5 },
      floors: { '*': { maintainability: 70 } },
      targetDirs: ['src'],
    },
    mutation: {
      enabled: true,
      baselinePath: 'baselines/mutation.json',
      tolerance: { kind: 'percent', value: 5 },
      floors: { '*': { score: 60 } },
    },
    lighthouse: {
      enabled: true,
      baselinePath: 'baselines/lighthouse.json',
      tolerance: { kind: 'percent', value: 5 },
      floors: { '*': { performance: 80 } },
      routes: [],
    },
    'bundle-size': {
      enabled: true,
      baselinePath: 'baselines/bundle-size.json',
      tolerance: { kind: 'percent', value: 5 },
      floors: { '*': { kb: 250 } },
      bundles: [],
    },
  };

  it('accepts the populated gates block with all seven tiers', () => {
    assert.equal(
      validate({
        ...REQ,
        delivery: {
          quality: {
            gateScoping: { scope: 'diff', diffRef: 'main' },
            gates: POPULATED_GATES,
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
          },
        },
      }),
      true,
    );
  });

  it('rejects scalar tolerance values across every gate', () => {
    expectErrors(
      {
        ...REQ,
        delivery: {
          quality: {
            gates: {
              crap: { tolerance: 0.05 },
            },
          },
        },
      },
      /tolerance/,
    );
  });

  it('accepts a percent tolerance', () => {
    assert.equal(
      validate({
        ...REQ,
        delivery: {
          quality: {
            gates: {
              mutation: { tolerance: { kind: 'percent', value: 2.5 } },
            },
          },
        },
      }),
      true,
    );
  });

  it('rejects an unknown tolerance kind', () => {
    expectErrors(
      {
        ...REQ,
        delivery: {
          quality: {
            gates: { crap: { tolerance: { kind: 'relative', value: 1 } } },
          },
        },
      },
      /kind/,
    );
  });

  // Story #2032 / Task #2041: `*` is no longer required on `floors`. Operators
  // may omit it entirely, in which case the framework default (e.g. MI ≥ 70
  // for the maintainability gate) is injected by the resolver (Story #2125).
  it('accepts a floors block without the catch-all `*` key', () => {
    const doc = {
      ...REQ,
      delivery: {
        quality: {
          gates: {
            maintainability: {
              floors: {
                'team-a': { maintainability: 65 },
              },
            },
          },
        },
      },
    };
    assert.equal(validate(doc), true);
  });

  // Story #2125: the `paths` escape-valve key was removed along with the
  // dead per-row enforcement machinery. A floors block carrying `paths`
  // is now rejected as schema-invalid.
  it('rejects a floors.paths bag (removed in Story #2125)', () => {
    expectErrors(
      {
        ...REQ,
        delivery: {
          quality: {
            gates: {
              coverage: {
                baselinePath: 'baselines/coverage.json',
                floors: {
                  paths: {
                    'src/example.js': { lines: 80, follow_up: '#1234' },
                  },
                },
              },
            },
          },
        },
      },
      // `paths` is no longer a recognised key under floors; AJV reports
      // additionalProperties/required violation depending on the
      // implementation path.
      /paths|additional/,
    );
  });

  it('rejects flat scalar floors (legacy qualityFloors shape)', () => {
    expectErrors(
      {
        ...REQ,
        delivery: {
          quality: {
            qualityFloors: {
              coverage: { lines: 90 },
              maintainability: 70,
              crap: 20,
            },
          },
        },
      },
      /additional properties/,
    );
  });

  it('rejects coveragePath on the CRAP gate (moved to coverage)', () => {
    expectErrors(
      {
        ...REQ,
        delivery: {
          quality: {
            gates: {
              crap: { coveragePath: 'coverage/coverage-final.json' },
            },
          },
        },
      },
      /additional properties/,
    );
  });

  it('accepts coveragePath on the coverage gate', () => {
    assert.equal(
      validate({
        ...REQ,
        delivery: {
          quality: {
            gates: {
              coverage: { coveragePath: 'coverage/coverage-final.json' },
            },
          },
        },
      }),
      true,
    );
  });

  it('rejects the legacy top-level maintainability key', () => {
    expectErrors(
      {
        ...REQ,
        delivery: {
          quality: { maintainability: { targetDirs: ['src'] } },
        },
      },
      /additional properties/,
    );
  });

  it('rejects the legacy top-level crap key', () => {
    expectErrors(
      {
        ...REQ,
        delivery: {
          quality: { crap: { enabled: true } },
        },
      },
      /additional properties/,
    );
  });

  it('rejects the legacy top-level baselines key', () => {
    expectErrors(
      {
        ...REQ,
        delivery: {
          quality: { baselines: { lint: { path: 'baselines/lint.json' } } },
        },
      },
      /additional properties/,
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
          quality: { gates: { maintainability: { halsteadTolerance: 0.1 } } },
        },
      },
      /additional properties/,
    );
  });

  it('rejects c1Exemption on the CRAP gate (closed shape)', () => {
    expectErrors(
      {
        ...REQ,
        delivery: {
          quality: { gates: { crap: { c1Exemption: 'blanket' } } },
        },
      },
      /additional properties/,
    );
  });

  it('accepts gateScoping at the quality-block root', () => {
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
});

describe('AGENTRC_SCHEMA — delivery.codeReview.provider (Story #2825)', () => {
  it('accepts provider: "native"', () => {
    assert.equal(
      validate({
        ...REQ,
        delivery: { codeReview: { provider: 'native' } },
      }),
      true,
    );
  });

  it('accepts codeReview omitted entirely (default kicks in elsewhere)', () => {
    assert.equal(validate({ ...REQ, delivery: {} }), true);
  });

  it('accepts an empty providerConfig object', () => {
    assert.equal(
      validate({
        ...REQ,
        delivery: { codeReview: { providerConfig: {} } },
      }),
      true,
    );
  });

  it('accepts a populated providerConfig (open shape)', () => {
    assert.equal(
      validate({
        ...REQ,
        delivery: {
          codeReview: {
            providerConfig: { anyAdapterKey: 'value', nested: { a: 1 } },
          },
        },
      }),
      true,
    );
  });

  it('rejects provider: "codex" (added in a later Story under Epic #2815)', () => {
    expectErrors(
      { ...REQ, delivery: { codeReview: { provider: 'codex' } } },
      /must be equal to one of the allowed values|enum/,
    );
  });

  it('rejects an unknown provider string', () => {
    expectErrors(
      { ...REQ, delivery: { codeReview: { provider: 'bogus' } } },
      /must be equal to one of the allowed values|enum/,
    );
  });

  it('rejects providerConfig of the wrong type (must be object)', () => {
    expectErrors(
      { ...REQ, delivery: { codeReview: { providerConfig: 'no' } } },
      /must be object/,
    );
  });

  it('rejects unknown sibling keys on codeReview (typo guard)', () => {
    expectErrors(
      {
        ...REQ,
        delivery: { codeReview: { provder: 'native' } },
      },
      /additional properties/,
    );
  });

  it('preserves maxFixAttempts and maxFixScopeFiles validation', () => {
    assert.equal(
      validate({
        ...REQ,
        delivery: {
          codeReview: {
            provider: 'native',
            providerConfig: {},
            maxFixAttempts: 3,
            maxFixScopeFiles: 5,
          },
        },
      }),
      true,
    );
  });
});
