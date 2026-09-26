/**
 * single-story-confirm-merge.js argv boundary (Story #5446): `main()` hands
 * `process.argv` to `runConfirmMergeCli`, which parses it once and passes
 * values to `runConfirmMerge`. These cases drive the argv-rejection paths
 * in-process — every one ends before a config, provider or `gh` is touched.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { TEST_TEMP_ROOT_ENV } from '../.agents/scripts/lib/config/temp-paths.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';
import { runConfirmMergeCli } from '../.agents/scripts/single-story-confirm-merge.js';

const STORY_ID = 424243;

const argv = (...flags) => ['node', 'single-story-confirm-merge.js', ...flags];

/** The envelope the CLI persisted under the scratch temp root. */
function persistedEnvelope(root) {
  const name = `story-deliver-terminal-${STORY_ID}.json`;
  const entry = readdirSync(root, { recursive: true })
    .map(String)
    .find((e) => e.endsWith(name));
  assert.ok(entry, `no persisted terminal envelope under ${root}`);
  return JSON.parse(readFileSync(path.join(root, entry), 'utf8'));
}

describe('runConfirmMergeCli — argv boundary', () => {
  let previousTempRoot;
  let scratch;
  beforeEach(() => {
    // The friction emit and envelope persist land in a scratch root, not the
    // repo's real ledger.
    previousTempRoot = process.env[TEST_TEMP_ROOT_ENV];
    scratch = makeTempDir('confirm-merge-argv-');
    process.env[TEST_TEMP_ROOT_ENV] = scratch;
  });
  afterEach(() => {
    if (previousTempRoot === undefined) delete process.env[TEST_TEMP_ROOT_ENV];
    else process.env[TEST_TEMP_ROOT_ENV] = previousTempRoot;
  });

  it('rejects an unknown flag as a failed init envelope, before any phase', async () => {
    const code = await runConfirmMergeCli(
      argv('--story', String(STORY_ID), '--bogus-flag'),
    );
    assert.equal(code, 1);
    const envelope = persistedEnvelope(scratch);
    assert.equal(envelope.status, 'failed');
    assert.equal(envelope.phase, 'init');
    assert.equal(envelope.storyId, STORY_ID);
    assert.match(envelope.failure.reason, /unknown flag --bogus-flag/);
  });

  it('rejects a retired flag as a failed init envelope naming it', async () => {
    const code = await runConfirmMergeCli(
      argv('--story', String(STORY_ID), '--dry-run'),
    );
    assert.equal(code, 1);
    const envelope = persistedEnvelope(scratch);
    assert.equal(envelope.phase, 'init');
    assert.match(envelope.failure.reason, /--dry-run was retired/);
  });

  it('with no --story there is no envelope to report: the usage error propagates', async () => {
    await assert.rejects(
      runConfirmMergeCli(argv('--wait', '--max-wait-seconds', '5')),
      /Usage: node single-story-confirm-merge\.js --story <STORY_ID>/,
    );
  });
});
