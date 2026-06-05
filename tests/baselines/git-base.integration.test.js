// tests/baselines/git-base.integration.test.js
//
// Real-git acceptance leg for `readBaseFromGit`.
//
// This file is tagged `test:integration` (via the `*.integration.test.js`
// glob in INTEGRATION_INCLUDE) so the fixture-setup cost does not tax the
// quick-feedback loop. The unit-level mock tests live in git-base.test.js.
//
// The fixture is provided by tests/fixtures/git-fixture.js — one shared
// helper optimizable in one place (`git init -q -b main`, inline `-c`
// config flags, `commit.gpgsign=false`).

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import {
  __cacheSize,
  __resetForTests,
  readBaseFromGit,
} from '../../.agents/scripts/lib/baselines/git-base.js';
import { makeGitRepo } from '../fixtures/git-fixture.js';

describe('readBaseFromGit — real git repo (integration)', () => {
  afterEach(() => {
    __resetForTests();
  });

  it('reads from a real temp git repo (acceptance: exits 0 on fixture)', () => {
    const dir = makeGitRepo();
    try {
      __resetForTests(); // restore real spawnSync
      const got = readBaseFromGit('HEAD', 'baseline.json', { cwd: dir });
      assert.ok(got !== null, 'HEAD:baseline.json should exist');
      assert.match(got, /"floor":\s*40/);
      // Second call exercises the real-spawn → cache transition.
      const sizeBefore = __cacheSize();
      const got2 = readBaseFromGit('HEAD', 'baseline.json', { cwd: dir });
      assert.equal(got2, got);
      assert.equal(
        __cacheSize(),
        sizeBefore,
        'second read must not grow cache',
      );

      // Missing file at HEAD → null.
      const missing = readBaseFromGit('HEAD', 'no-such-file.json', {
        cwd: dir,
      });
      assert.equal(missing, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
