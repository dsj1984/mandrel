import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  COMMENT_EVENT_NAMES,
  getAgentrcValidator,
  WEBHOOK_EVENT_NAMES,
} from '../.agents/scripts/lib/config-settings-schema.js';

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

  it('accepts commands.{test,typecheck,formatCheck,formatWrite}', () => {
    assert.equal(
      validate({
        project: {
          ...REQ.project,
          commands: {
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

  // Story #5004 retired `lint-baseline.js`, the only consumer of this key.
  // `COMMANDS_SCHEMA` is `additionalProperties: false`, so a consumer config
  // that still carries it is REJECTED, not silently ignored — the operator
  // gets a validation error naming the key rather than a command that quietly
  // never runs.
  it('rejects the retired commands.lintBaseline key', () => {
    expectErrors(
      {
        project: { ...REQ.project, commands: { lintBaseline: 'npm run lint' } },
      },
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
            webhookEvents: ['story-merged', 'merge.unlanded'],
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

  it('accepts planning.memoryPool.indexByteCeiling (Story #5285)', () => {
    // The one surviving arm's knob. The precompiled validator is what every runtime
    // path actually calls, so accepting it here is the assertion that the
    // key survived the mirror + `validator:gen` regeneration — a schema edit
    // that skips either leaves the key rejected at runtime while
    // `generate-config-docs.js --check` still passes.
    assert.equal(
      validate({
        ...REQ,
        planning: { memoryPool: { indexByteCeiling: 20000 } },
      }),
      true,
    );
    expectErrors(
      { ...REQ, planning: { memoryPool: { indexByteCeiling: 0 } } },
      /must be >= 1/,
    );
  });

  it('rejects the ten planning.* keys Story #5312 retired', () => {
    // The 2.57.0 migration strips each of these on upgrade; the schema block
    // is strict, so a config still carrying one fails loudly.
    for (const planning of [
      { complexityGate: { enabled: true } },
      { riskHeuristics: ['no destructive ops'] },
      { riskHeuristics: { append: ['custom risk'] } },
      { failOnSharedEditors: true },
      { requireExplicitCrossStoryDeps: true },
      { failOnRegistryConflicts: true },
      { failOnLargeFanOut: true },
      { largeFanOutThreshold: 12 },
      { crossCuttingRegistries: ['**/listeners/index.js'] },
      { memoryPool: { staleAfterDays: 45 } },
      { memoryPool: { growthDelta: 10 } },
    ]) {
      expectErrors({ ...REQ, planning }, /additional propert/i);
    }
  });

  it('rejects an unknown memoryPool key (typo guard)', () => {
    // `additionalProperties: false` on the block, so a near-miss spelling of
    // a threshold fails loudly instead of sitting inert on the default.
    expectErrors(
      { ...REQ, planning: { memoryPool: { growthDeltaEntries: 25 } } },
      /must NOT have additional properties/,
    );
  });

  it('rejects unknown planning property', () => {
    expectErrors(
      { ...REQ, planning: { unknownProp: true } },
      /additional properties/,
    );
  });

  it('rejects planning.modelCapacity — collapsed to a framework constant', () => {
    // Session-capacity thresholds live only as DEFAULT_MODEL_CAPACITY.
    // `additionalProperties: false` on the planning block rejects the
    // removed key (same pattern as planning.maxTickets / Story #4163).
    expectErrors(
      {
        ...REQ,
        planning: {
          modelCapacity: {
            softSessionTokens: 20000,
            hardSessionTokens: 60000,
          },
        },
      },
      /additional propert/i,
    );
  });

  it('rejects the retired planning.taskSizing key (v2 Stage 2)', () => {
    // File/AC ceilings were replaced by DEFAULT_MODEL_CAPACITY; additionalProperties
    // false on the planning block rejects the retired key.
    expectErrors(
      {
        ...REQ,
        planning: {
          taskSizing: { softFiles: 15, hardFiles: 30 },
        },
      },
      /additional propert/i,
    );
  });

  it('rejects planning.maxTickets — collapsed to a framework constant (Story #4163)', () => {
    // `maxTickets` is no longer an operator-configurable knob; it lives only
    // as LIMITS_DEFAULTS.maxTickets. `additionalProperties: false` on the
    // planning block now rejects the removed key.
    expectErrors(
      { ...REQ, planning: { maxTickets: 60 } },
      /additional propert/i,
    );
  });

  it('rejects the retired planning.context block (Story #4541)', () => {
    // `planning.context.{maxBytes, summaryMode}` fed an `applyBudget` pass
    // that lost its last caller in the v2 cutover — the key resolved but
    // capped nothing. It is gone; `additionalProperties: false` on the
    // planning block now rejects it, so a resurrected key fails loudly
    // instead of silently doing nothing. The live bound on planner-context
    // size is PLAN_CONTEXT_ENVELOPE_BYTE_CEILING (a framework constant).
    expectErrors(
      { ...REQ, planning: { context: { maxBytes: 50000 } } },
      /additional propert/i,
    );
    expectErrors(
      { ...REQ, planning: { context: { summaryMode: 'auto' } } },
      /additional propert/i,
    );
  });

  it('rejects the retired planning.codebaseSnapshot block (Story #4811)', () => {
    // The pre-computed structural view is gone: its default include globs
    // missed the standard monorepo layout, and its knobs only re-filtered the
    // same matched set. Spec authoring is grounded by the author's own
    // targeted retrieval plus the Phase 8 file-assumption gate — neither
    // configurable. `additionalProperties: false` on the planning block
    // rejects the retired key (the 2.20.0-retire-codebase-snapshot migration
    // strips it on consumer upgrade).
    expectErrors(
      {
        ...REQ,
        planning: { codebaseSnapshot: { tier: 'skinny' } },
      },
      /additional propert/i,
    );
    expectErrors(
      {
        ...REQ,
        planning: { codebaseSnapshot: { include: ['src/**'] } },
      },
      /additional propert/i,
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
          deliverRunner: { concurrencyCap: 3 },
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

  it('accepts delivery.signals.{rework,retry}', () => {
    assert.equal(
      validate({
        ...REQ,
        delivery: {
          signals: {
            rework: { editsPerFile: 5 },
            retry: { repeatCount: 3 },
          },
        },
      }),
      true,
    );
  });

  it('rejects retired signals.hotspot detector', () => {
    expectErrors(
      {
        ...REQ,
        delivery: { signals: { hotspot: { p95Multiplier: 1.25 } } },
      },
      /additional properties/,
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
      floors: { '*': { max: 30, p95: 20, methodsAbove20: 50 } },
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
              requireSiblingTest: false,
            },
            autoRefresh: {
              enabled: true,
              crapJumpCap: 5,
              scope: 'diff',
            },
          },
        },
      }),
      true,
    );
  });

  it('rejects the retired miDropMustRefactor / miDropCap keys (Story #4531)', () => {
    expectErrors(
      {
        ...REQ,
        delivery: {
          quality: {
            codingGuardrails: { miDropMustRefactor: 1.5 },
          },
        },
      },
      /codingGuardrails/,
    );
    expectErrors(
      {
        ...REQ,
        delivery: {
          quality: {
            autoRefresh: { miDropCap: 1.5 },
          },
        },
      },
      /autoRefresh/,
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

  // Story #4981 (AC-6) — the new opt-in key validates through the FULL
  // AGENTRC_SCHEMA chain (config-settings-schema-delivery.js's DELIVERY_SCHEMA
  // → config-settings-schema-quality.js's QUALITY_SCHEMA → config/gates/
  // index.js's GATES_SCHEMA → config/gates/crap.schema.js's CRAP_GATE), so a
  // pass here proves the key is registered on both runtime AJV surfaces the
  // Story names, not just the leaf schema file.
  describe('gates.crap.incrementalCoverage (Story #4981)', () => {
    it('accepts the opt-in shape', () => {
      assert.equal(
        validate({
          ...REQ,
          delivery: {
            quality: {
              gates: {
                crap: {
                  incrementalCoverage: { enabled: true, baseRef: 'main' },
                },
              },
            },
          },
        }),
        true,
      );
    });

    // Story #5173 — the split pair, and the deprecated alias alongside it.
    it('accepts the split switches, together and apart', () => {
      for (const incrementalCoverage of [
        { skipWhenUnchanged: true },
        { baselineJoin: false },
        {
          skipWhenUnchanged: false,
          baselineJoin: true,
          baseRef: 'origin/main',
        },
        { enabled: true, baselineJoin: false },
      ]) {
        assert.equal(
          validate({
            ...REQ,
            delivery: {
              quality: { gates: { crap: { incrementalCoverage } } },
            },
          }),
          true,
          `expected ${JSON.stringify(incrementalCoverage)} to validate`,
        );
      }
    });

    it('rejects a non-boolean split switch', () => {
      expectErrors(
        {
          ...REQ,
          delivery: {
            quality: {
              gates: { crap: { incrementalCoverage: { baselineJoin: 'yes' } } },
            },
          },
        },
        /must be boolean/,
      );
    });

    it('accepts enabled alone (baseRef optional)', () => {
      assert.equal(
        validate({
          ...REQ,
          delivery: {
            quality: {
              gates: { crap: { incrementalCoverage: { enabled: false } } },
            },
          },
        }),
        true,
      );
    });

    it("rejects a typo'd key under incrementalCoverage (closed shape)", () => {
      expectErrors(
        {
          ...REQ,
          delivery: {
            quality: {
              gates: {
                crap: { incrementalCoverage: { enalbed: true } },
              },
            },
          },
        },
        /additional properties/,
      );
    });

    it('rejects a non-string baseRef', () => {
      expectErrors(
        {
          ...REQ,
          delivery: {
            quality: {
              gates: { crap: { incrementalCoverage: { baseRef: 42 } } },
            },
          },
        },
        /must be string/,
      );
    });
  });
});

// Story #5173 — `delivery.execution.fullSuiteLock` MUST live on the runtime
// AJV delivery schema. A key declared only in the generated JSON-Schema mirror
// never reaches config resolution, so it would be inert: the operator would
// set it, AJV would reject the file, and the switch would never resolve.
describe('AGENTRC_SCHEMA — delivery.execution.fullSuiteLock (Story #5173)', () => {
  it('accepts the boolean escape hatch', () => {
    for (const fullSuiteLock of [true, false]) {
      assert.equal(
        validate({ ...REQ, delivery: { execution: { fullSuiteLock } } }),
        true,
      );
    }
  });

  it('rejects a non-boolean value', () => {
    expectErrors(
      { ...REQ, delivery: { execution: { fullSuiteLock: 'off' } } },
      /must be boolean/,
    );
  });
});

describe('AGENTRC_SCHEMA — delivery.codeReview.providers (Story #2871)', () => {
  it('accepts providers: [{ name: "native" }]', () => {
    assert.equal(
      validate({
        ...REQ,
        delivery: { codeReview: { providers: [{ name: 'native' }] } },
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

  it('accepts providers: [{ name: "codex" }] (Story #2830 — codex ReviewProvider adapter)', () => {
    assert.equal(
      validate({
        ...REQ,
        delivery: { codeReview: { providers: [{ name: 'codex' }] } },
      }),
      true,
    );
  });

  it('rejects legacy provider field (hard cutover)', () => {
    expectErrors(
      { ...REQ, delivery: { codeReview: { provider: 'native' } } },
      /additional properties/,
    );
  });

  it('rejects providers entry with unknown name', () => {
    expectErrors(
      { ...REQ, delivery: { codeReview: { providers: [{ name: 'gemini' }] } } },
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
            providers: [{ name: 'native' }],
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

// ---------------------------------------------------------------------------
// Notification event vocabularies
// ---------------------------------------------------------------------------

describe('notification event vocabularies', () => {
  it('lets `story-closing` be allowlisted for comment delivery, not just webhooks', () => {
    // The event is Story-scoped and `level: "story"` (see
    // `lib/single-story/story-merged-notify.js`), so the ticket comment
    // channel is a meaningful destination for it. It was previously
    // webhook-only, which made the allowlist unexpressible.
    assert.ok(COMMENT_EVENT_NAMES.includes('story-closing'));
    assert.equal(
      validate({
        ...REQ,
        github: {
          owner: 'o',
          repo: 'r',
          operatorHandle: '@op',
          notifications: { commentEvents: ['story-merged', 'story-closing'] },
        },
      }),
      true,
    );
  });

  it('keeps the comment vocabulary a strict subset of the webhook vocabulary', () => {
    for (const name of COMMENT_EVENT_NAMES) {
      assert.ok(
        WEBHOOK_EVENT_NAMES.includes(name),
        `comment event "${name}" must also be a webhook event`,
      );
    }
    assert.ok(COMMENT_EVENT_NAMES.length < WEBHOOK_EVENT_NAMES.length);
  });

  it('keeps run-scoped beats out of the comment vocabulary', () => {
    // Narrower on the ticket-scope axis, deliberately: these are not about
    // one Story issue, so a comment has nowhere meaningful to land.
    for (const name of ['merge.unlanded', 'merge.flip-failed']) {
      assert.ok(WEBHOOK_EVENT_NAMES.includes(name), `${name} is allowlistable`);
      assert.ok(
        !COMMENT_EVENT_NAMES.includes(name),
        `run-scoped event "${name}" must stay out of the comment vocabulary`,
      );
    }
  });

  it('rejects a commentEvents entry outside the vocabulary', () => {
    expectErrors(
      {
        ...REQ,
        github: {
          owner: 'o',
          repo: 'r',
          operatorHandle: '@op',
          notifications: { commentEvents: ['merge.unlanded'] },
        },
      },
      /must be equal to one of the allowed values/,
    );
  });

  it('rejects the retired loop.tick on BOTH notification channels', () => {
    // Story #5024 retired `loop.tick` with the lifecycle bus that was its
    // only producer. Removing it from the enum is what makes a resurrection
    // fail loudly at config-validation time instead of silently never firing
    // — the same contract that retired `story.heartbeat` (A22). It shipped in
    // NOTIFICATIONS_DEFAULTS, so every consumer was subscribed by default to
    // an event no code path could deliver.
    assert.ok(!WEBHOOK_EVENT_NAMES.includes('loop.tick'));
    assert.ok(!COMMENT_EVENT_NAMES.includes('loop.tick'));
    for (const channel of ['webhookEvents', 'commentEvents']) {
      expectErrors(
        {
          ...REQ,
          github: {
            owner: 'o',
            repo: 'r',
            operatorHandle: '@op',
            notifications: { [channel]: ['loop.tick'] },
          },
        },
        /must be equal to one of the allowed values/,
      );
    }
  });
});

// A key that exists only in the published mirror is DOA: `config-resolver.js`
// validates `.agentrc.json` against this runtime AJV schema, and every block
// is `additionalProperties: false` — so a consumer who actually sets the key
// gets their whole config rejected. The mirror-drift guard checks key
// presence; these check that a POPULATED block is accepted, which is what a
// consumer experiences.
describe('close-validation gate economy — populated blocks are accepted', () => {
  it('accepts project.commands.lint as a scoped command string', () => {
    assert.equal(
      validate({
        project: {
          ...REQ.project,
          commands: { lint: 'npx biome ci --changed' },
        },
      }),
      true,
    );
  });

  // The injection guard means a multi-linter "scoped pair" cannot be spelled
  // inline — the consumer wraps it in one npm script and names that. Pinned
  // so the schema description and the accepted shape cannot drift apart.
  it('a multi-linter pair must be wrapped in one npm script, not chained', () => {
    expectErrors(
      {
        project: {
          ...REQ.project,
          commands: { lint: 'biome ci --changed && turbo run lint --affected' },
        },
      },
      /must NOT be valid|must be null/,
    );
    assert.equal(
      validate({
        project: { ...REQ.project, commands: { lint: 'npm run lint:scoped' } },
      }),
      true,
    );
  });

  it('accepts project.commands.lint as null (use the framework default)', () => {
    assert.equal(
      validate({ project: { ...REQ.project, commands: { lint: null } } }),
      true,
    );
  });

  it('rejects an empty lint command, so a typo cannot blank the gate', () => {
    expectErrors(
      { project: { ...REQ.project, commands: { lint: '' } } },
      /must NOT have fewer than 1 characters|must be null/,
    );
  });

  it('rejects a shell-injecting lint command', () => {
    expectErrors(
      { project: { ...REQ.project, commands: { lint: 'lint; rm -rf /' } } },
      /must NOT be valid|must be null/,
    );
  });

  it('accepts delivery.execution.requireCreditedCapture', () => {
    for (const requireCreditedCapture of [true, false]) {
      assert.equal(
        validate({
          ...REQ,
          delivery: { execution: { requireCreditedCapture } },
        }),
        true,
      );
    }
  });

  it('rejects a non-boolean requireCreditedCapture', () => {
    expectErrors(
      { ...REQ, delivery: { execution: { requireCreditedCapture: 'yes' } } },
      /must be boolean/,
    );
  });
});

describe('qa.environments.*.signInSeam.skill — id pattern (Story #5285)', () => {
  /** A one-environment `qa` block whose `local` seam names `skill`. */
  const withSkill = (skill) => ({
    ...REQ,
    qa: {
      featureRoot: 'tests/features',
      fixturesManifest: 'tests/fixtures/personas.json',
      environments: {
        local: { baseUrl: 'http://localhost:3000', signInSeam: { skill } },
      },
    },
  });

  it('accepts a well-formed tier-relative id', () => {
    assert.equal(validate(withSkill('stack/qa/acme-sso')), true);
    assert.equal(validate(withSkill('core/scope-triage')), true);
  });

  it('rejects a traversal and an uppercase segment', () => {
    // The id is joined onto a skills root to reach a SKILL.md, so a value
    // that could escape a root is refused at config validation rather than
    // normalized at the path join.
    assert.equal(validate(withSkill('../../secrets')), false);
    assert.equal(validate(withSkill('Core/Foo')), false);
  });

  it('rejects a single-segment id, which names no tier', () => {
    assert.equal(validate(withSkill('consumer-sign-in')), false);
  });
});
