/**
 * Story #3388 — `.agentrc.local.json` override layer in config-resolver.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { Volume } from 'memfs';
import {
  PROJECT_ROOT,
  resolveConfig,
} from '../../.agents/scripts/lib/config-resolver.js';
import { setupFsMock } from './fs-mock.js';

const REQ = Object.freeze({
  project: Object.freeze({
    paths: Object.freeze({
      agentRoot: '.agents',
      docsRoot: 'docs',
      tempRoot: 'temp',
    }),
  }),
});

const FIXTURE_ROOT = path.resolve(
  PROJECT_ROOT,
  '.worktrees/story-3388-local-fixture',
);

describe('config-resolver — .agentrc.local.json overlay (Story #3388)', () => {
  let vol;

  beforeEach((t) => {
    vol = new Volume();
    setupFsMock(t, vol);
    resolveConfig({ bustCache: true });
  });

  function writeConfigs({ agentrc, local }) {
    vol.mkdirSync(FIXTURE_ROOT, { recursive: true });
    if (agentrc !== undefined) {
      vol.writeFileSync(
        path.join(FIXTURE_ROOT, '.agentrc.json'),
        JSON.stringify(agentrc),
      );
    }
    if (local !== undefined) {
      vol.writeFileSync(
        path.join(FIXTURE_ROOT, '.agentrc.local.json'),
        JSON.stringify(local),
      );
    }
  }

  it('is a no-op when .agentrc.local.json is absent', () => {
    writeConfigs({
      agentrc: {
        project: { ...REQ.project, baseBranch: 'develop' },
        delivery: { deliverRunner: { concurrencyCap: 3 } },
      },
    });

    const config = resolveConfig({ bustCache: true, cwd: FIXTURE_ROOT });
    assert.equal(config.project.baseBranch, 'develop');
    assert.equal(config.delivery.deliverRunner.concurrencyCap, 3);
    assert.equal(config.source, path.join(FIXTURE_ROOT, '.agentrc.json'));
  });

  it('deep-merges a nested local override without clobbering siblings', () => {
    writeConfigs({
      agentrc: {
        project: { ...REQ.project, baseBranch: 'develop' },
        delivery: {
          deliverRunner: { concurrencyCap: 3 },
          docsFreshness: { paths: ['README.md'] },
        },
      },
      local: {
        delivery: { deliverRunner: { concurrencyCap: 5 } },
      },
    });

    const config = resolveConfig({ bustCache: true, cwd: FIXTURE_ROOT });
    assert.equal(config.delivery.deliverRunner.concurrencyCap, 5);
    // `delivery.docsFreshness` is a sibling of the overridden
    // `delivery.deliverRunner` block — the deep merge must not clobber it.
    assert.deepEqual(config.delivery.docsFreshness.paths, ['README.md']);
    assert.match(
      config.source,
      /\.agentrc\.local\.json.*overrides.*\.agentrc\.json/,
    );
  });
});
