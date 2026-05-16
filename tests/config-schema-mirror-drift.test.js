import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  BASELINE_SCHEMA_FILES,
  BASELINE_SCHEMAS_DIR,
  buildBaselineSchemaAjv,
} from '../.agents/scripts/lib/config-schema-shared.js';
import { AGENTRC_SCHEMA } from '../.agents/scripts/lib/config-settings-schema.js';

// ---------------------------------------------------------------------------
// Behavioural drift test — directionality contract.
//
// Authoritative direction: AJV → mirror. The runtime AJV schema in
// config-settings-schema.js is the SOURCE OF TRUTH; the static
// .agents/schemas/agentrc.schema.json file is an ADVISORY human-readable
// mirror. When the two diverge, the AJV side wins and the mirror MUST be
// updated to match — never the other way around.
//
// Post-reshape (Epic #1720 Story #1739) the doc-level schema validates
// the four top-level blocks {project, github, planning, delivery}.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIRROR_PATH = path.resolve(
  __dirname,
  '..',
  '.agents',
  'schemas',
  'agentrc.schema.json',
);

const mirror = JSON.parse(readFileSync(MIRROR_PATH, 'utf8'));

const ajv2020 = new Ajv2020({ allErrors: true });
addFormats(ajv2020);
const mirrorValidator = ajv2020.compile(mirror);

const runtimeAjv = new Ajv({ allErrors: true });
addFormats(runtimeAjv);
const runtimeValidator = runtimeAjv.compile(AGENTRC_SCHEMA);

const REQ = Object.freeze({
  project: Object.freeze({
    paths: Object.freeze({
      agentRoot: '.agents',
      docsRoot: 'docs',
      tempRoot: 'temp',
    }),
  }),
});

const assertAgree = (value, label) => {
  const runtimeOk = runtimeValidator(value);
  const mirrorOk = mirrorValidator(value);
  let directionalHint = '';
  if (runtimeOk && !mirrorOk) {
    directionalHint =
      ' Static JSON Schema mirror rejects an input the runtime AJV schema accepts.' +
      ' The AJV schema is authoritative; update .agents/schemas/agentrc.schema.json to match.';
  } else if (!runtimeOk && mirrorOk) {
    directionalHint =
      ' Static JSON Schema mirror accepts an input the runtime AJV schema rejects.' +
      ' The AJV schema is authoritative; tighten .agents/schemas/agentrc.schema.json to match.';
  }
  assert.equal(
    mirrorOk,
    runtimeOk,
    `${label}: runtime=${runtimeOk} mirror=${mirrorOk}.${directionalHint}`,
  );
};

describe('agentrc.schema.json mirror — drift vs runtime AJV schema', () => {
  it('mirror exposes the four top-level blocks under $defs', () => {
    for (const def of ['project', 'github', 'planning', 'delivery']) {
      assert.ok(mirror.$defs[def], `mirror is missing $defs.${def}`);
    }
  });

  it('mirror references a draft 2020-12 $schema', () => {
    assert.equal(
      mirror.$schema,
      'https://json-schema.org/draft/2020-12/schema',
    );
  });

  it('accepts a minimal valid doc on both sides', () => {
    assertAgree({ ...REQ }, 'minimal valid doc');
  });

  it('accepts a populated doc on both sides', () => {
    assertAgree(
      {
        project: {
          baseBranch: 'main',
          paths: REQ.project.paths,
          docsContextFiles: ['architecture.md'],
          commands: {
            test: 'npm test',
            typecheck: null,
            lintBaseline: 'npm run lint',
            formatCheck: 'npx biome format .',
            formatWrite: 'npx biome format --write .',
          },
        },
        github: {
          owner: 'dsj1984',
          repo: 'mandrel',
          operatorHandle: '@dsj1984',
          branchProtection: {
            enforce: true,
            requiredChecks: [{ name: 'lint', cmd: ['npm', 'run', 'lint'] }],
          },
          mergeMethods: { allow_squash_merge: true },
          notifications: {
            mentionOperator: false,
            commentEvents: ['state-transition'],
            webhookEvents: ['epic-started'],
          },
        },
        planning: {
          maxTickets: 60,
          riskHeuristics: ['no destructive ops'],
          context: { maxBytes: 50000, summaryMode: 'auto' },
        },
        delivery: {
          execution: { timeoutMs: 600000 },
          maxTokenBudget: 200000,
          docsFreshness: { paths: ['README.md'] },
          deliverRunner: { concurrencyCap: 3, progressReportIntervalSec: 120 },
          worktreeIsolation: {
            enabled: true,
            root: '.worktrees',
            nodeModulesStrategy: 'per-worktree',
          },
          signals: {
            hotspot: { p95Multiplier: 1.25 },
            rework: { editsPerFile: 5 },
            retry: { repeatCount: 3 },
          },
          quality: {
            gateScoping: { scope: 'diff', diffRef: 'main' },
            gates: {
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
            },
            codingGuardrails: {
              cyclomaticFlag: 8,
              cyclomaticMustFix: 12,
              miDropMustRefactor: 1.5,
              requireSiblingTest: false,
            },
          },
        },
      },
      'fully populated doc',
    );
  });

  it('accepts per-component globs under gates.<kind>.components (Story #1892)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: {
          quality: {
            gates: {
              coverage: {
                baselinePath: 'baselines/coverage.json',
                floors: { '*': { lines: 80 } },
                components: {
                  app: ['src/app/**'],
                  worker: ['src/worker/**'],
                },
              },
            },
          },
        },
      },
      'per-component globs',
    );
  });

  it('accepts new rollup-keyed floors (Story #1892)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: {
          quality: {
            gates: {
              crap: {
                baselinePath: 'baselines/crap.json',
                floors: { '*': { p95: 5, perMethod: 30 } },
              },
              maintainability: {
                baselinePath: 'baselines/maintainability.json',
                floors: { '*': { min: 50, p50: 80 } },
              },
              mutation: {
                baselinePath: 'baselines/mutation.json',
                floors: { '*': { score: 70 } },
              },
              lint: {
                baselinePath: 'baselines/lint.json',
                floors: { '*': { errorCount: 0, warningCount: 0 } },
              },
            },
          },
        },
      },
      'rollup-keyed floors',
    );
  });

  it('rejects legacy agentSettings on both sides', () => {
    assertAgree(
      { agentSettings: { paths: REQ.project.paths } },
      'legacy agentSettings',
    );
  });

  it('rejects legacy orchestration on both sides', () => {
    assertAgree(
      { ...REQ, orchestration: { provider: 'github' } },
      'legacy orchestration',
    );
  });

  it('rejects unknown top-level keys on both sides', () => {
    assertAgree({ ...REQ, mystery: true }, 'unknown top-level key');
  });

  it('rejects shell-injection in project.baseBranch on both sides', () => {
    assertAgree(
      { project: { ...REQ.project, baseBranch: 'main; rm -rf /' } },
      'shell injection in baseBranch',
    );
  });

  it('rejects unknown property under project.commands on both sides', () => {
    assertAgree(
      {
        project: { ...REQ.project, commands: { build: 'npm run build' } },
      },
      'commands typo (build dropped)',
    );
  });

  it('rejects renamed-away miDropRefactor on both sides', () => {
    assertAgree(
      {
        ...REQ,
        delivery: {
          quality: { codingGuardrails: { miDropRefactor: 1.5 } },
        },
      },
      'renamed codingGuardrails field',
    );
  });

  it('rejects dropped halsteadTolerance on both sides', () => {
    assertAgree(
      {
        ...REQ,
        delivery: {
          quality: { gates: { maintainability: { halsteadTolerance: 0.1 } } },
        },
      },
      'dropped halsteadTolerance',
    );
  });

  it('rejects scalar tolerance on both sides (object shape only)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: { quality: { gates: { crap: { tolerance: 0.05 } } } },
      },
      'scalar tolerance migrated to { kind, value }',
    );
  });

  it('rejects floors without the catch-all key on both sides', () => {
    assertAgree(
      {
        ...REQ,
        delivery: {
          quality: {
            gates: { coverage: { floors: { 'packages/web': { lines: 90 } } } },
          },
        },
      },
      "floors require '*' catch-all",
    );
  });

  it('accepts a floors.paths bag with mandatory follow_up (Story #2029)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: {
          quality: {
            gates: {
              coverage: {
                baselinePath: 'baselines/coverage.json',
                floors: {
                  '*': { lines: 90, branches: 85, functions: 90 },
                  paths: {
                    'src/example.js': { lines: 80, follow_up: '#1234' },
                  },
                },
              },
            },
          },
        },
      },
      'floors.paths with follow_up issue ref',
    );
  });

  it('accepts a floors.paths follow_up as an HTTPS URL (Story #2029)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: {
          quality: {
            gates: {
              crap: {
                baselinePath: 'baselines/crap.json',
                floors: {
                  '*': { crap: 20 },
                  paths: {
                    'src/example.js': {
                      crap: 30,
                      follow_up: 'https://example.com/track/1',
                    },
                  },
                },
              },
            },
          },
        },
      },
      'floors.paths with follow_up URL',
    );
  });

  it('rejects a floors.paths entry missing follow_up (Story #2029)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: {
          quality: {
            gates: {
              maintainability: {
                baselinePath: 'baselines/maintainability.json',
                floors: {
                  '*': { maintainability: 70 },
                  paths: {
                    'src/example.js': { maintainability: 50 },
                  },
                },
              },
            },
          },
        },
      },
      'floors.paths entry without follow_up must reject',
    );
  });

  it('rejects a floors.paths entry with malformed follow_up (Story #2029)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: {
          quality: {
            gates: {
              coverage: {
                baselinePath: 'baselines/coverage.json',
                floors: {
                  '*': { lines: 90 },
                  paths: {
                    'src/example.js': { lines: 80, follow_up: 'oops' },
                  },
                },
              },
            },
          },
        },
      },
      'floors.paths follow_up pattern enforcement',
    );
  });

  it('rejects coveragePath on the CRAP gate (moved to coverage)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: {
          quality: {
            gates: { crap: { coveragePath: 'coverage/coverage-final.json' } },
          },
        },
      },
      'coveragePath ownership moved to coverage gate',
    );
  });

  it('rejects dropped signals.churn on both sides', () => {
    assertAgree(
      {
        ...REQ,
        delivery: { signals: { churn: { repeatCount: 4 } } },
      },
      'dropped signals.churn',
    );
  });

  it('rejects legacy deliverRunner.enabled on both sides', () => {
    assertAgree(
      {
        ...REQ,
        delivery: { deliverRunner: { enabled: true } },
      },
      'dropped deliverRunner.enabled',
    );
  });

  it('rejects worktreeIsolation without root when enabled is true on both sides', () => {
    assertAgree(
      {
        ...REQ,
        delivery: { worktreeIsolation: { enabled: true } },
      },
      'conditional root required when enabled=true',
    );
  });
});

// ---------------------------------------------------------------------------
// Baseline schema registry drift test (Story #1888).
//
// The shared registry in config-schema-shared.js lists every baseline schema
// that AJV consumers should be able to compile. The on-disk directory under
// .agents/schemas/baselines/ is the second source of truth. Whenever a new
// per-kind schema lands on disk without an entry in BASELINE_KIND_SCHEMA_FILES,
// the registry stops covering it — these tests catch that drift loudly.
// ---------------------------------------------------------------------------

describe('baseline schema registry — drift vs .agents/schemas/baselines/', () => {
  it('every registered schema id loads through buildBaselineSchemaAjv without throwing', () => {
    const ajv = buildBaselineSchemaAjv();
    for (const filename of BASELINE_SCHEMA_FILES) {
      const schemaObj = ajv.getSchema(filename);
      assert.ok(
        schemaObj,
        `${filename} is not reachable from the shared AJV registry`,
      );
    }
  });

  it('registry list matches the on-disk *.schema.json contents', () => {
    const onDisk = readdirSync(BASELINE_SCHEMAS_DIR)
      .filter((name) => name.endsWith('.schema.json'))
      .sort();
    const registered = [...BASELINE_SCHEMA_FILES].sort();
    assert.deepEqual(
      onDisk,
      registered,
      'Baseline schema directory drifted from BASELINE_SCHEMA_FILES. ' +
        'When a new schema lands under .agents/schemas/baselines/, add it ' +
        'to BASELINE_KIND_SCHEMA_FILES in config-schema-shared.js.',
    );
  });
});
