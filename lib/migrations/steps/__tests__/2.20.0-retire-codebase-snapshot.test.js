// lib/migrations/steps/__tests__/2.20.0-retire-codebase-snapshot.test.js
/**
 * Unit tests for the Story #4811 migration step — strips the retired
 * `planning.codebaseSnapshot` block from a consumer's `.agentrc.json` and
 * `.agentrc.local.json`. All tests drive `detect`/`apply` against an in-memory
 * fake fs (testing-standards § Unit) — no real filesystem I/O.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { getAgentrcValidator } from '../../../../.agents/scripts/lib/config-settings-schema.js';
import { retireCodebaseSnapshot } from '../2.20.0-retire-codebase-snapshot.js';

const PROJECT_ROOT = '/consumer';
const AGENTRC_PATH = path.join(PROJECT_ROOT, '.agentrc.json');
const AGENTRC_LOCAL_PATH = path.join(PROJECT_ROOT, '.agentrc.local.json');

const SNAPSHOT_BLOCK = Object.freeze({
  tier: 'skinny',
  include: ['src/**'],
  recentCommitWindow: 30,
});

/**
 * @param {{ base?: object | null, local?: object | null }} initial - `null`
 *   (or an omitted key) means that file is absent from disk.
 * @returns {{ ctx: object, read: (filePath: string) => object | null }}
 */
function makeCtx({ base = null, local = null } = {}) {
  const files = new Map();
  if (base !== null) files.set(AGENTRC_PATH, JSON.stringify(base, null, 2));
  if (local !== null) {
    files.set(AGENTRC_LOCAL_PATH, JSON.stringify(local, null, 2));
  }

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
      files.set(filePath, contents);
    },
  };

  return {
    ctx: { projectRoot: PROJECT_ROOT, fs },
    read: (filePath) =>
      files.has(filePath) ? JSON.parse(files.get(filePath)) : null,
  };
}

describe('retireCodebaseSnapshot — detect', () => {
  it('detects a config carrying planning.codebaseSnapshot', () => {
    const { ctx } = makeCtx({
      base: { planning: { codebaseSnapshot: SNAPSHOT_BLOCK } },
    });
    assert.equal(retireCodebaseSnapshot.detect(ctx), true);
  });

  it('detects the key in .agentrc.local.json alone', () => {
    const { ctx } = makeCtx({
      base: { planning: { riskHeuristics: ['payment flow'] } },
      local: { planning: { codebaseSnapshot: SNAPSHOT_BLOCK } },
    });
    assert.equal(retireCodebaseSnapshot.detect(ctx), true);
  });

  it('does not detect a clean planning block', () => {
    const { ctx } = makeCtx({
      base: { planning: { riskHeuristics: ['payment flow'] } },
    });
    assert.equal(retireCodebaseSnapshot.detect(ctx), false);
  });

  it('does not detect when neither config file is present', () => {
    const { ctx } = makeCtx();
    assert.equal(retireCodebaseSnapshot.detect(ctx), false);
  });
});

describe('retireCodebaseSnapshot — apply', () => {
  it('strips the retired key and preserves sibling planning keys', () => {
    const { ctx, read } = makeCtx({
      base: {
        planning: {
          codebaseSnapshot: SNAPSHOT_BLOCK,
          riskHeuristics: ['payment flow'],
          complexityGate: { enabled: true },
        },
      },
    });

    retireCodebaseSnapshot.apply(ctx);

    const written = read(AGENTRC_PATH);
    assert.equal('codebaseSnapshot' in written.planning, false);
    assert.deepEqual(written.planning.riskHeuristics, ['payment flow']);
    assert.deepEqual(written.planning.complexityGate, { enabled: true });
  });

  it('removes an emptied planning block, leaving other top-level keys', () => {
    const { ctx, read } = makeCtx({
      base: {
        project: { paths: { agentRoot: '.agents' } },
        planning: { codebaseSnapshot: SNAPSHOT_BLOCK },
      },
    });

    retireCodebaseSnapshot.apply(ctx);

    const written = read(AGENTRC_PATH);
    assert.equal('planning' in written, false);
    assert.deepEqual(written.project, { paths: { agentRoot: '.agents' } });
  });

  it('strips the key from both config files in one pass', () => {
    const { ctx, read } = makeCtx({
      base: {
        planning: { codebaseSnapshot: SNAPSHOT_BLOCK, failOnLargeFanOut: true },
      },
      local: { planning: { codebaseSnapshot: { tier: 'medium' } } },
    });

    retireCodebaseSnapshot.apply(ctx);

    assert.equal('codebaseSnapshot' in read(AGENTRC_PATH).planning, false);
    assert.equal(read(AGENTRC_PATH).planning.failOnLargeFanOut, true);
    assert.equal('planning' in read(AGENTRC_LOCAL_PATH), false);
  });

  it('leaves a config that never carried the key untouched', () => {
    const clean = { planning: { riskHeuristics: ['schema migration'] } };
    const { ctx, read } = makeCtx({ base: clean });

    retireCodebaseSnapshot.apply(ctx);

    assert.deepEqual(read(AGENTRC_PATH), clean);
  });

  it('is a no-op when no config file is present', () => {
    const { ctx } = makeCtx();
    assert.doesNotThrow(() => retireCodebaseSnapshot.apply(ctx));
  });

  it('satisfies the idempotency contract: detect is false after apply', () => {
    const { ctx } = makeCtx({
      base: { planning: { codebaseSnapshot: SNAPSHOT_BLOCK } },
      local: { planning: { codebaseSnapshot: { tier: 'medium' } } },
    });

    assert.equal(retireCodebaseSnapshot.detect(ctx), true);
    retireCodebaseSnapshot.apply(ctx);
    assert.equal(retireCodebaseSnapshot.detect(ctx), false);

    // A second apply must not throw or change anything further.
    assert.doesNotThrow(() => retireCodebaseSnapshot.apply(ctx));
    assert.equal(retireCodebaseSnapshot.detect(ctx), false);
  });
});

describe('retireCodebaseSnapshot — schema round-trip', () => {
  it('takes a config from schema-rejected to schema-valid', () => {
    // The upgrade contract this step exists for: `planning` carries
    // `additionalProperties: false`, so a consumer config still setting
    // `codebaseSnapshot` is a hard validation failure — not a warning — until
    // the migration strips it.
    const validate = getAgentrcValidator();
    const stale = {
      project: {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      },
      planning: {
        codebaseSnapshot: SNAPSHOT_BLOCK,
        navigation: { routeGlobs: ['pages/**'] },
      },
    };

    assert.equal(validate(stale), false, 'stale config must fail validation');

    const { ctx, read } = makeCtx({ base: stale });
    retireCodebaseSnapshot.apply(ctx);
    const migrated = read(AGENTRC_PATH);

    assert.equal(validate(migrated), true, 'migrated config must validate');
    assert.deepEqual(migrated.planning, {
      navigation: { routeGlobs: ['pages/**'] },
    });
  });
});
