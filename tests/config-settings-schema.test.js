import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getSettingsValidator } from '../.agents/scripts/lib/config-settings-schema.js';

const validate = getSettingsValidator();

/** Schema-required roots — Epic #730 Story 4 made `agentRoot` / `docsRoot` /
 * `tempRoot` mandatory; Story 7 lifted them under `paths{}`. Spread into
 * accept-test inputs that aren't exercising the required-key behaviour
 * itself. */
const REQ = Object.freeze({
  paths: Object.freeze({
    agentRoot: '.agents',
    docsRoot: 'docs',
    tempRoot: 'temp',
  }),
});

const expectErrors = (settings, ...needles) => {
  const ok = validate(settings);
  assert.equal(ok, false, 'expected schema validation to fail');
  const joined = (validate.errors || [])
    .map((e) => `${e.instancePath} ${e.message}`)
    .join(' | ');
  for (const needle of needles) {
    assert.match(joined, needle, `missing expected error: ${needle}`);
  }
};

describe('AGENT_SETTINGS_SCHEMA — explicit number/object entries', () => {
  it('accepts integer maxTokenBudget / executionTimeoutMs / executionMaxBuffer under limits', () => {
    assert.equal(
      validate({
        ...REQ,
        limits: {
          maxTokenBudget: 200000,
          executionTimeoutMs: 300000,
          executionMaxBuffer: 10485760,
        },
      }),
      true,
    );
  });

  it('rejects non-integer limits.maxTokenBudget', () => {
    expectErrors(
      { ...REQ, limits: { maxTokenBudget: 'lots' } },
      /maxTokenBudget/,
    );
  });

  it('rejects limits.executionTimeoutMs below 1', () => {
    expectErrors(
      { ...REQ, limits: { executionTimeoutMs: 0 } },
      /executionTimeoutMs/,
    );
  });

  it('rejects limits.executionMaxBuffer below 1', () => {
    expectErrors(
      { ...REQ, limits: { executionMaxBuffer: 0 } },
      /executionMaxBuffer/,
    );
  });

  it('accepts planning with riskHeuristics array', () => {
    assert.equal(
      validate({
        ...REQ,
        planning: { riskHeuristics: ['no destructive ops'] },
      }),
      true,
    );
  });

  it('rejects unknown property on planning', () => {
    expectErrors(
      { planning: { riskHeuristic: ['x'] } },
      /must NOT have additional properties/,
    );
  });

  it('rejects non-string riskHeuristics entries', () => {
    expectErrors({ planning: { riskHeuristics: [42] } }, /riskHeuristics\/0/);
  });

  it('accepts quality.prGate with object-shaped checks array', () => {
    assert.equal(
      validate({
        ...REQ,
        quality: {
          prGate: {
            checks: [
              { name: 'lint', cmd: ['npm', 'run', 'lint'] },
              { name: 'test', cmd: ['npm', 'test'] },
            ],
          },
        },
      }),
      true,
    );
  });

  it('rejects unknown property on quality.prGate', () => {
    expectErrors(
      { ...REQ, quality: { prGate: { check: ['lint'] } } },
      /must NOT have additional properties/,
    );
  });

  it('accepts a full limits.friction block', () => {
    assert.equal(
      validate({
        ...REQ,
        limits: {
          friction: {
            repetitiveCommandCount: 3,
            consecutiveErrorCount: 3,
            stagnationStepCount: 5,
            maxIntegrationRetries: 2,
          },
        },
      }),
      true,
    );
  });

  it('rejects unknown property on limits.friction (typo guard)', () => {
    expectErrors(
      { ...REQ, limits: { friction: { repetativeCommandCount: 3 } } },
      /must NOT have additional properties/,
    );
  });

  it('rejects non-integer limits.friction entries', () => {
    expectErrors(
      { ...REQ, limits: { friction: { repetitiveCommandCount: 'three' } } },
      /repetitiveCommandCount/,
    );
  });

  it('rejects limits.friction value below 1', () => {
    expectErrors(
      { ...REQ, limits: { friction: { stagnationStepCount: 0 } } },
      /stagnationStepCount/,
    );
  });
});

describe('AGENT_SETTINGS_SCHEMA — required path roots (Story 4 → Story 7)', () => {
  it('rejects an empty agentSettings block, naming the missing paths group', () => {
    expectErrors({}, /must have required property 'paths'/);
  });

  it('rejects paths missing only agentRoot, naming the missing key', () => {
    expectErrors(
      { paths: { docsRoot: 'docs', tempRoot: 'temp' } },
      /must have required property 'agentRoot'/,
    );
  });

  it('rejects paths missing only docsRoot, naming the missing key', () => {
    expectErrors(
      { paths: { agentRoot: '.agents', tempRoot: 'temp' } },
      /must have required property 'docsRoot'/,
    );
  });

  it('rejects paths missing only tempRoot, naming the missing key', () => {
    expectErrors(
      { paths: { agentRoot: '.agents', docsRoot: 'docs' } },
      /must have required property 'tempRoot'/,
    );
  });

  it('accepts a block that declares all three roots under paths', () => {
    assert.equal(validate({ ...REQ }), true);
  });

  it('rejects unknown property under paths (typo guard)', () => {
    expectErrors(
      { paths: { ...REQ.paths, agntRoot: '.agents' } },
      /must NOT have additional properties/,
    );
  });
});

describe('AGENT_SETTINGS_SCHEMA — top-level additionalProperties:false (Epic #773 Story 9)', () => {
  it('rejects an unknown top-level agentSettings key (typo guard)', () => {
    expectErrors(
      { ...REQ, basBranch: 'main' },
      /must NOT have additional properties/,
    );
  });

  it('rejects each legacy `*Root` flat key at the top level', () => {
    for (const key of [
      'scriptsRoot',
      'workflowsRoot',
      'personasRoot',
      'schemasRoot',
      'skillsRoot',
      'templatesRoot',
      'rulesRoot',
    ]) {
      expectErrors(
        { ...REQ, [key]: '.agents/x' },
        /must NOT have additional properties/,
      );
    }
  });

  it('accepts the same `*Root` keys when nested under `paths`', () => {
    assert.equal(
      validate({
        paths: {
          ...REQ.paths,
          scriptsRoot: '.agents/scripts',
          workflowsRoot: '.agents/workflows',
          personasRoot: '.agents/personas',
          schemasRoot: '.agents/schemas',
          skillsRoot: '.agents/skills',
          templatesRoot: '.agents/templates',
          rulesRoot: '.agents/rules',
        },
      }),
      true,
    );
  });

  it('accepts a top-level baseBranch (the only remaining flat string field)', () => {
    assert.equal(validate({ ...REQ, baseBranch: 'main' }), true);
  });

  it('rejects shell-injection in baseBranch', () => {
    expectErrors({ ...REQ, baseBranch: 'main; rm -rf /' }, /baseBranch/);
  });
});

describe('AGENT_SETTINGS_SCHEMA — quality.crap conditional coveragePath', () => {
  it('accepts crap with enabled=false and no coveragePath', () => {
    assert.equal(
      validate({
        ...REQ,
        quality: { crap: { enabled: false } },
      }),
      true,
    );
  });

  it('accepts crap with requireCoverage=false and no coveragePath', () => {
    assert.equal(
      validate({
        ...REQ,
        quality: {
          crap: { enabled: true, requireCoverage: false },
        },
      }),
      true,
    );
  });

  it('rejects crap when enabled+requireCoverage are true but coveragePath is absent', () => {
    expectErrors(
      {
        ...REQ,
        quality: {
          crap: { enabled: true, requireCoverage: true },
        },
      },
      /must have required property 'coveragePath'/,
    );
  });

  it('accepts crap when enabled+requireCoverage are true and coveragePath is present', () => {
    assert.equal(
      validate({
        ...REQ,
        quality: {
          crap: {
            enabled: true,
            requireCoverage: true,
            coveragePath: 'coverage/coverage-final.json',
          },
        },
      }),
      true,
    );
  });
});
