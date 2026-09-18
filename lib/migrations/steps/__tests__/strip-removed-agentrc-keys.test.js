// lib/migrations/steps/__tests__/strip-removed-agentrc-keys.test.js
/**
 * Unit tests for the Story #5382 migration step — strips every `.agentrc` key
 * the config-surface cut removed and reports what replaced each one. All tests
 * drive `detect`/`apply` against an in-memory fake fs; the stripped fixture is
 * then checked against the live runtime validator so the step and the schema
 * cannot drift apart.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { getAgentrcValidator } from '../../../../.agents/scripts/lib/config-settings-schema.js';
import { stripRemovedAgentrcKeys } from '../strip-removed-agentrc-keys.js';

const PROJECT_ROOT = '/consumer';
const AGENTRC_PATH = path.join(PROJECT_ROOT, '.agentrc.json');
const AGENTRC_LOCAL_PATH = path.join(PROJECT_ROOT, '.agentrc.local.json');

/**
 * @param {{ base?: object|null, local?: object|null }} initial
 * @returns {{ ctx: object, read: (p: string) => object, writes: () => number, lines: string[] }}
 */
function makeCtx({ base = null, local = null } = {}) {
  const files = new Map();
  const lines = [];
  let writes = 0;
  if (base !== null) files.set(AGENTRC_PATH, JSON.stringify(base));
  if (local !== null) files.set(AGENTRC_LOCAL_PATH, JSON.stringify(local));
  const fs = {
    readFileSync(filePath) {
      if (!files.has(filePath)) {
        const err = new Error(`ENOENT: ${filePath}`);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(filePath);
    },
    writeFileSync(filePath, contents) {
      writes += 1;
      files.set(filePath, contents);
    },
  };
  return {
    ctx: { projectRoot: PROJECT_ROOT, fs, log: (line) => lines.push(line) },
    read: (filePath) => JSON.parse(files.get(filePath)),
    writes: () => writes,
    lines,
  };
}

const PROJECT = {
  paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
};
const GITHUB = { owner: 'o', repo: 'r', operatorHandle: '@me' };

/** A valid config that also carries a representative set of removed keys. */
function fixture() {
  return {
    project: PROJECT,
    github: { ...GITHUB, defaultTimeoutMs: 60000 },
    planning: { memoryPool: { indexByteCeiling: 20000 } },
    delivery: {
      execution: { timeoutMs: 600000, fullSuiteLock: false },
      ci: { autoMerge: 'strict', watch: { pollIntervalMs: 5000 } },
      mergeWatch: { intervalSeconds: 30, maxWaitSeconds: 900 },
      review: { lensDiffFloor: 40 },
      auditToStories: { severityFloor: 'high', autoComment: true },
      quality: {
        gateScoping: { scope: 'diff', diffRef: 'main' },
        baselineEpsilon: { crap: 0.5, lint: 0 },
        gates: {
          lint: { enabled: true, baselinePath: 'baselines/lint.json' },
          lighthouse: { enabled: false },
          mutation: { strykerConfigPath: null, floors: { '*': { score: 50 } } },
          crap: { refreshTag: 'baseline-refresh:', floors: {} },
        },
      },
    },
  };
}

describe('stripRemovedAgentrcKeys — detect', () => {
  it('detects a removed key in the committed base', () => {
    const { ctx } = makeCtx({ base: fixture() });
    assert.equal(stripRemovedAgentrcKeys.detect(ctx), true);
  });

  it('detects a removed key in the gitignored local overlay', () => {
    const { ctx } = makeCtx({
      base: { project: { paths: {} } },
      local: { delivery: { review: { lensDiffFloor: 10 } } },
    });
    assert.equal(stripRemovedAgentrcKeys.detect(ctx), true);
  });

  it('does not detect a config carrying only surviving keys', () => {
    const { ctx } = makeCtx({
      base: {
        project: { paths: {} },
        github: { operatorHandle: '@me' },
        delivery: {
          deliverRunner: { concurrencyCap: 5 },
          routing: { roleScopedAgents: false, closeAndLand: false },
          ci: { autoMerge: 'trust-ci', blockOnAdvisoryFailure: false },
        },
      },
      local: { delivery: { deliverRunner: { concurrencyCap: 3 } } },
    });
    assert.equal(stripRemovedAgentrcKeys.detect(ctx), false);
  });

  it('does not detect an absent config', () => {
    assert.equal(stripRemovedAgentrcKeys.detect(makeCtx().ctx), false);
  });
});

describe('stripRemovedAgentrcKeys — apply', () => {
  it('deletes exactly the removed keys and leaves a config the schema accepts', () => {
    const { ctx, read } = makeCtx({ base: fixture() });
    stripRemovedAgentrcKeys.apply(ctx);
    const config = read(AGENTRC_PATH);
    assert.deepEqual(config, {
      project: PROJECT,
      github: GITHUB,
      delivery: {
        execution: { fullSuiteLock: false },
        ci: { autoMerge: 'strict' },
        mergeWatch: { maxWaitSeconds: 900 },
        quality: {
          gates: {
            mutation: { floors: { '*': { score: 50 } } },
            crap: { floors: {} },
          },
        },
      },
    });
    const validate = getAgentrcValidator();
    assert.equal(validate(config), true, JSON.stringify(validate.errors));
  });

  it('reports every removed key with the constant that replaced it', () => {
    const { ctx, lines } = makeCtx({ base: fixture() });
    stripRemovedAgentrcKeys.apply(ctx);
    const report = lines.join('\n');
    assert.match(
      report,
      /removed \.agentrc\.json delivery\.execution\.timeoutMs; now LIMITS_DEFAULTS\.executionTimeoutMs = 600000/,
    );
    assert.match(
      report,
      /github\.defaultTimeoutMs; now GH_DEFAULT_TIMEOUT_MS = 60000/,
    );
    assert.match(report, /mutation\.strykerConfigPath; no reader/);
    assert.equal(lines.length, 16, 'one line per removed key in the fixture');
  });

  it('flags a value that differed from its constant as a behaviour change', () => {
    const { ctx, lines } = makeCtx({ base: fixture() });
    stripRemovedAgentrcKeys.apply(ctx);
    const changes = lines.filter((line) => line.includes('behaviour change'));
    assert.deepEqual(
      changes.map((line) => line.split(';')[0].trim()),
      [
        'behaviour change: .agentrc.json set delivery.quality.gates.lint = {"enabled":true,"baselinePath":"baselines/lint.json"}',
        'behaviour change: .agentrc.json set delivery.ci.watch.pollIntervalMs = 5000',
        'behaviour change: .agentrc.json set planning.memoryPool.indexByteCeiling = 20000',
      ],
      'a disabled lighthouse gate and every default-valued key are plain removals',
    );
  });

  it('sweeps the local overlay and prunes its emptied blocks', () => {
    const { ctx, read } = makeCtx({
      base: { project: { paths: {} } },
      local: {
        github: { operatorHandle: '@me' },
        delivery: { review: { lensDiffFloor: 10 } },
      },
    });
    stripRemovedAgentrcKeys.apply(ctx);
    assert.deepEqual(read(AGENTRC_LOCAL_PATH), {
      github: { operatorHandle: '@me' },
    });
  });

  it('is idempotent — a second run detects nothing and writes nothing', () => {
    const { ctx, writes, lines } = makeCtx({ base: fixture() });
    stripRemovedAgentrcKeys.apply(ctx);
    const afterFirst = { writes: writes(), lines: lines.length };
    assert.equal(stripRemovedAgentrcKeys.detect(ctx), false);
    stripRemovedAgentrcKeys.apply(ctx);
    assert.deepEqual({ writes: writes(), lines: lines.length }, afterFirst);
  });

  it('carries the 2.61.0 version and names the Story', () => {
    assert.equal(stripRemovedAgentrcKeys.version, '2.61.0');
    assert.match(stripRemovedAgentrcKeys.description, /#5382/);
  });
});
