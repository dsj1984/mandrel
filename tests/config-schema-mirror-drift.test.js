import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  AGENT_SETTINGS_SCHEMA,
  ORCHESTRATION_SCHEMA,
} from '../.agents/scripts/lib/config-schema.js';

// ---------------------------------------------------------------------------
// Behavioural drift test — directionality contract.
//
// Authoritative direction: AJV → mirror. The runtime AJV schemas in
// config-schema.js + config-settings-schema.js are the SOURCE OF TRUTH; the
// static .agents/schemas/agentrc.schema.json file is an ADVISORY human-readable
// mirror. When the two diverge, the AJV side wins and the mirror MUST be
// updated to match — never the other way around.
//
// What this test catches: AJV → mirror lag. A schema change landed on the AJV
// side without a corresponding update to the static mirror, so the two
// surfaces now disagree on which inputs to accept or reject.
//
// How to fix a failure: update .agents/schemas/agentrc.schema.json to mirror
// the AJV-side change. Do NOT relax the AJV schema to match the mirror.
//
// Why verdict-equivalence rather than structural diff: the AJV side uses
// programmatic shortcuts (compiled patternProperties, helper-built keyword
// sets, etc.) that don't translate to a static JSON file. Comparing structure
// would be brittle. Instead we assert the two surfaces produce the same
// accept/reject verdicts on a curated fixture set covering every block whose
// typing previous Stories added.
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

const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
ajv.addSchema(mirror, 'mirror');

const mirrorValidator = (defName) =>
  ajv.getSchema(`mirror#/$defs/${defName}`) ??
  ajv.compile({ $ref: `mirror#/$defs/${defName}` });

const runtimeAjv = new Ajv({ allErrors: true });
addFormats(runtimeAjv);
const runtimeValidators = {
  agentSettings: runtimeAjv.compile(AGENT_SETTINGS_SCHEMA),
  orchestration: runtimeAjv.compile(ORCHESTRATION_SCHEMA),
};

const assertAgree = (block, value, label) => {
  const runtimeOk = runtimeValidators[block](value);
  const mirrorOk = mirrorValidator(block)(value);
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
    `[${block}] ${label}: runtime=${runtimeOk} mirror=${mirrorOk}.${directionalHint}`,
  );
};

describe('agentrc.schema.json mirror — drift vs runtime AJV schemas', () => {
  it('accepts a fully populated agentSettings block on both sides', () => {
    assertAgree(
      'agentSettings',
      {
        baseBranch: 'main',
        paths: {
          agentRoot: '.agents',
          docsRoot: 'docs',
          tempRoot: 'temp',
          auditOutputDir: 'temp',
          scriptsRoot: '.agents/scripts',
          workflowsRoot: '.agents/workflows',
          personasRoot: '.agents/personas',
          schemasRoot: '.agents/schemas',
          skillsRoot: '.agents/skills',
          templatesRoot: '.agents/templates',
          rulesRoot: '.agents/rules',
        },
        commands: {
          validate: 'npm run lint',
          test: 'npm test',
          typecheck: null,
          build: null,
        },
        limits: {
          maxTickets: 60,
          maxInstructionSteps: 5,
          maxTokenBudget: 200000,
          executionTimeoutMs: 300000,
          executionMaxBuffer: 10485760,
          friction: {
            repetitiveCommandCount: 3,
            consecutiveErrorCount: 3,
            stagnationStepCount: 5,
            maxIntegrationRetries: 2,
          },
        },
        docsContextFiles: ['architecture.md'],
        quality: {
          maintainability: { targetDirs: ['.agents/scripts'] },
          crap: {
            enabled: true,
            targetDirs: ['.agents/scripts'],
            newMethodCeiling: 30,
            coveragePath: 'coverage/coverage-final.json',
            tolerance: 0.001,
            requireCoverage: true,
          },
          prGate: {
            checks: [{ name: 'lint', cmd: ['npm', 'run', 'lint'] }],
          },
        },
        release: {
          docs: ['README.md'],
          versionFile: '.agents/VERSION',
          packageJson: true,
          autoVersionBump: true,
        },
        planning: { riskHeuristics: ['no destructive ops'] },
      },
      'fully populated',
    );
  });

  // Epic #1142 Story #1157: epicClose + orchestration.hitl deleted from
  // both AJV schemas and the static mirror. Legacy v5.39.x configs that
  // still carry these blocks must fail with `additionalProperties` errors
  // on both validators.
  it('rejects legacy epicClose at the agentSettings root on both sides', () => {
    assertAgree(
      'agentSettings',
      {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        epicClose: { runRetro: true },
      },
      'legacy epicClose post-1157',
    );
  });

  it('rejects legacy orchestration.hitl on both sides', () => {
    assertAgree(
      'orchestration',
      {
        provider: 'github',
        github: { owner: 'org', repo: 'repo' },
        hitl: {},
      },
      'legacy orchestration.hitl post-1157',
    );
  });

  it('rejects shell-injection in baseBranch on both sides', () => {
    assertAgree(
      'agentSettings',
      { baseBranch: 'main; rm -rf /' },
      'shell injection in baseBranch',
    );
  });

  it('rejects unknown property on planning on both sides', () => {
    assertAgree(
      'agentSettings',
      { planning: { riskHeuristic: ['x'] } },
      'planning typo',
    );
  });

  // Epic #1142 Story #1157: legacy `riskGates` block at the root rejected.
  it('rejects legacy agentSettings.riskGates on both sides', () => {
    assertAgree(
      'agentSettings',
      {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        riskGates: { heuristics: ['x'] },
      },
      'legacy riskGates post-1157',
    );
  });

  it('rejects unknown property on quality.prGate on both sides', () => {
    assertAgree(
      'agentSettings',
      {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        quality: { prGate: { check: ['x'] } },
      },
      'quality.prGate typo',
    );
  });

  // Epic #1142 Story #1157: prGate.checks promoted to object items
  // (`{ name, cmd[] }`) so the runner can spawn each check directly.
  it('rejects prGate.checks string items on both sides', () => {
    assertAgree(
      'agentSettings',
      {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        quality: { prGate: { checks: ['lint'] } },
      },
      'prGate.checks string item post-1157',
    );
  });

  it('rejects unknown property on limits.friction on both sides', () => {
    assertAgree(
      'agentSettings',
      {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        limits: { friction: { repetativeCommandCount: 3 } },
      },
      'limits.friction typo',
    );
  });

  it('rejects non-integer limits.maxTokenBudget on both sides', () => {
    assertAgree(
      'agentSettings',
      {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        limits: { maxTokenBudget: 'lots' },
      },
      'string limits.maxTokenBudget',
    );
  });

  it('accepts null commands.typecheck on both sides', () => {
    assertAgree(
      'agentSettings',
      { commands: { typecheck: null } },
      'null commands.typecheck',
    );
  });

  it('accepts null commands.build on both sides', () => {
    assertAgree(
      'agentSettings',
      { commands: { build: null } },
      'null commands.build',
    );
  });

  it('rejects empty-string commands.typecheck on both sides', () => {
    assertAgree(
      'agentSettings',
      { commands: { typecheck: '' } },
      'empty commands.typecheck',
    );
  });

  it('rejects empty-string commands.build on both sides', () => {
    assertAgree(
      'agentSettings',
      { commands: { build: '' } },
      'empty commands.build',
    );
  });

  it('rejects unknown property under commands on both sides', () => {
    assertAgree(
      'agentSettings',
      { commands: { lint: 'npm run lint' } },
      'commands typo',
    );
  });

  it('rejects an unknown top-level agentSettings key on both sides (Epic #773 Story 9)', () => {
    assertAgree(
      'agentSettings',
      {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        unknownTopLevel: true,
      },
      'unknown agentSettings top-level',
    );
  });

  it('rejects a legacy `scriptsRoot` flat key at the top level on both sides', () => {
    assertAgree(
      'agentSettings',
      {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        scriptsRoot: '.agents/scripts',
      },
      'flat *Root after Story 9 cutover',
    );
  });

  it('accepts the seven *Root keys nested under paths on both sides', () => {
    assertAgree(
      'agentSettings',
      {
        paths: {
          agentRoot: '.agents',
          docsRoot: 'docs',
          tempRoot: 'temp',
          scriptsRoot: '.agents/scripts',
          workflowsRoot: '.agents/workflows',
          personasRoot: '.agents/personas',
          schemasRoot: '.agents/schemas',
          skillsRoot: '.agents/skills',
          templatesRoot: '.agents/templates',
          rulesRoot: '.agents/rules',
        },
      },
      'paths.*Root accepted',
    );
  });

  it('accepts a full orchestration block on both sides', () => {
    assertAgree(
      'orchestration',
      {
        provider: 'github',
        github: {
          owner: 'dsj1984',
          repo: 'agent-protocols',
          projectNumber: 1,
          operatorHandle: '@dsj1984',
        },
        notifications: {
          mentionOperator: false,
          commentMinLevel: 'medium',
          terminalMinLevel: 'medium',
          webhookEvents: [
            'epic-started',
            'epic-progress',
            'epic-blocked',
            'epic-unblocked',
            'epic-complete',
          ],
        },
        worktreeIsolation: {
          enabled: true,
          root: '.worktrees',
          nodeModulesStrategy: 'per-worktree',
        },
        runners: {
          deliverRunner: {
            enabled: true,
            concurrencyCap: 3,
            progressReportIntervalSec: 30,
          },
          planRunner: { enabled: true, pollIntervalSec: 30 },
        },
      },
      'full orchestration',
    );
  });

  it('rejects flat deliverRunner under orchestration on both sides', () => {
    assertAgree(
      'orchestration',
      {
        provider: 'github',
        github: { owner: 'org', repo: 'repo' },
        deliverRunner: { enabled: true, concurrencyCap: 3 },
      },
      'flat deliverRunner is no longer allowed at the orchestration root',
    );
  });

  // Epic #1142 Story #1157: legacy `epicRunner` / `closeRetry` keys under
  // `runners` are rejected — repos must rename to deliverRunner /
  // storyMergeRetry in `.agentrc.json`.
  it('rejects legacy runners.epicRunner key on both sides', () => {
    assertAgree(
      'orchestration',
      {
        provider: 'github',
        github: { owner: 'org', repo: 'repo' },
        runners: { epicRunner: { enabled: true, concurrencyCap: 3 } },
      },
      'legacy runners.epicRunner post-1157',
    );
  });

  it('rejects legacy runners.closeRetry key on both sides', () => {
    assertAgree(
      'orchestration',
      {
        provider: 'github',
        github: { owner: 'org', repo: 'repo' },
        runners: { closeRetry: { maxAttempts: 3 } },
      },
      'legacy runners.closeRetry post-1157',
    );
  });

  it('rejects unknown property under orchestration.runners on both sides', () => {
    assertAgree(
      'orchestration',
      {
        provider: 'github',
        github: { owner: 'org', repo: 'repo' },
        runners: { unknownRunner: {} },
      },
      'unknown runners child',
    );
  });

  it("rejects provider:'github' with no github block on both sides", () => {
    assertAgree(
      'orchestration',
      { provider: 'github' },
      'missing github block',
    );
  });

  it('rejects missing provider on both sides', () => {
    assertAgree(
      'orchestration',
      { github: { owner: 'org', repo: 'repo' } },
      'missing provider',
    );
  });

  it('rejects unknown top-level orchestration property on both sides', () => {
    assertAgree(
      'orchestration',
      {
        provider: 'github',
        github: { owner: 'org', repo: 'repo' },
        unknownField: true,
      },
      'unknown top-level',
    );
  });

  it('mirror references a draft 2020-12 $schema', () => {
    assert.equal(
      mirror.$schema,
      'https://json-schema.org/draft/2020-12/schema',
    );
  });

  it('mirror exposes agentSettings and orchestration under $defs', () => {
    for (const def of ['agentSettings', 'orchestration']) {
      assert.ok(mirror.$defs[def], `mirror is missing $defs.${def}`);
    }
  });
});
