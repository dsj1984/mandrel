import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
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
            crap: {
              enabled: true,
              targetDirs: ['src'],
              newMethodCeiling: 30,
              coveragePath: 'coverage/coverage-final.json',
              tolerance: 0.05,
              requireCoverage: true,
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
          quality: { maintainability: { halsteadTolerance: 0.1 } },
        },
      },
      'dropped halsteadTolerance',
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
