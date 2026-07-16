// tests/e2e/sync-prune.integration.test.js
/**
 * End-to-end (real-binary) coverage of `mandrel sync`'s copy + prune contract
 * (Story #4123, under Epic #4118 / Story #4046's sync-prune behavior).
 *
 * Unlike `lib/cli/__tests__/sync.test.js`, which drives `runSync` through
 * injected fakes (in-memory fs, fake package resolver), this suite spawns the
 * **real** binary — `node bin/mandrel.js sync` — against a real `mkdtemp` temp
 * consumer directory via {@link module:tests/e2e/helpers/cli-harness}. It is
 * the only test that proves the prune path against actual disk state and a real
 * argv → dispatch → package-resolution → file-copy round trip.
 *
 * Tier: this file's `.integration.test.js` suffix auto-registers it in the
 * per-PR integration tier (`INTEGRATION_INCLUDE` glob in test-tiers.js), so no
 * test-tier wiring edit is required. It is deterministic and hermetic: no
 * network, no shared state, every temp dir torn down in `afterEach`.
 *
 * Asserted contract (the three pillars of sync-prune):
 *   1. Managed payload files are copied into ./.agents/.
 *   2. A stale managed file (no payload counterpart) is DELETED by prune.
 *   3. A `.agents/local/**` addition — and a `*.local.*` override — SURVIVE.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  cleanupAll,
  makeTempConsumer,
  REPO_ROOT,
  runMandrel,
} from './helpers/cli-harness.js';

/**
 * A payload file known to ship in the package `.agents/` tree, used to prove a
 * real copy landed. `instructions.md` is the framework's primary system prompt
 * and is guaranteed to be present.
 */
const KNOWN_PAYLOAD_FILE = 'instructions.md';

/** A nested payload file, to prove the copy recurses into subdirectories. */
const KNOWN_NESTED_PAYLOAD_FILE = path.join('rules', 'security-baseline.md');

describe('mandrel sync — real-binary copy + prune (e2e)', () => {
  /** @type {{ dir: string, agentsDir: string, cleanup: () => void }} */
  let consumer;

  beforeEach(() => {
    consumer = makeTempConsumer();
  });

  afterEach(() => {
    cleanupAll();
  });

  it('copies managed payload files into ./.agents/', () => {
    const { status, stdout, stderr } = runMandrel(consumer.dir, ['sync']);

    assert.equal(
      status,
      0,
      `mandrel sync exited ${String(status)}\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
    assert.match(stdout, /Installed \d+ file\(s\) into \.\/\.agents\//);

    // A top-level and a nested payload file both materialized as real files.
    assert.ok(
      fs.statSync(path.join(consumer.agentsDir, KNOWN_PAYLOAD_FILE)).isFile(),
      `expected ${KNOWN_PAYLOAD_FILE} to be copied into .agents/`,
    );
    assert.ok(
      fs
        .statSync(path.join(consumer.agentsDir, KNOWN_NESTED_PAYLOAD_FILE))
        .isFile(),
      `expected ${KNOWN_NESTED_PAYLOAD_FILE} to be copied into .agents/`,
    );
  });

  it('prunes a stale managed file but preserves .agents/local/** and *.local.* overrides', () => {
    // Arrange: pre-seed the destination .agents/ with three pre-existing files
    // BEFORE the first sync —
    //   (a) a stale managed file with no payload counterpart  → must be PRUNED
    //   (b) a hand-authored file under .agents/local/         → must SURVIVE
    //   (c) a top-level *.local.* override file               → must SURVIVE
    const staleManagedFile = path.join(
      consumer.agentsDir,
      'rules',
      'phantom-stale-rule.md',
    );
    const localAddition = path.join(
      consumer.agentsDir,
      'local',
      'team-notes.md',
    );
    const localOverride = path.join(
      consumer.agentsDir,
      'instructions.local.md',
    );

    fs.mkdirSync(path.dirname(staleManagedFile), { recursive: true });
    fs.writeFileSync(staleManagedFile, '# stale — not in payload\n');
    fs.mkdirSync(path.dirname(localAddition), { recursive: true });
    fs.writeFileSync(localAddition, '# consumer-owned, must survive\n');
    fs.writeFileSync(localOverride, '# local override, must survive\n');

    // Act: run the real binary.
    const { status, stdout, stderr } = runMandrel(consumer.dir, ['sync']);

    // Assert: clean exit and the prune was reported.
    assert.equal(
      status,
      0,
      `mandrel sync exited ${String(status)}\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
    assert.match(stdout, /pruned \d+ stale file\(s\)/);

    // (a) The stale managed file is gone.
    assert.ok(
      !fs.existsSync(staleManagedFile),
      'stale managed file should have been pruned',
    );

    // (b) The .agents/local/** addition survived, byte-for-byte.
    assert.ok(
      fs.existsSync(localAddition),
      '.agents/local/** addition must survive sync',
    );
    assert.equal(
      fs.readFileSync(localAddition, 'utf8'),
      '# consumer-owned, must survive\n',
    );

    // (c) The *.local.* override survived.
    assert.ok(
      fs.existsSync(localOverride),
      'top-level *.local.* override must survive sync',
    );

    // And the real payload still landed alongside the survivors.
    assert.ok(
      fs.existsSync(path.join(consumer.agentsDir, KNOWN_PAYLOAD_FILE)),
      'payload file must still be copied during the prune run',
    );
  });

  it('--dry-run plans the prune without writing or deleting anything', () => {
    // Seed a stale file; the dry run must report it as prunable but leave it
    // on disk (and create no .agents/ materialization).
    const staleManagedFile = path.join(
      consumer.agentsDir,
      'rules',
      'phantom-stale-rule.md',
    );
    fs.mkdirSync(path.dirname(staleManagedFile), { recursive: true });
    fs.writeFileSync(staleManagedFile, '# stale\n');

    const { status, stdout, stderr } = runMandrel(consumer.dir, [
      'sync',
      '--dry-run',
    ]);

    assert.equal(
      status,
      0,
      `mandrel sync --dry-run exited ${String(status)}\nstderr: ${stderr}`,
    );
    assert.match(stdout, /Dry run:/);
    assert.match(stdout, /would prune .*phantom-stale-rule\.md/);

    // Nothing was written: the known payload file was NOT materialized…
    assert.ok(
      !fs.existsSync(path.join(consumer.agentsDir, KNOWN_PAYLOAD_FILE)),
      'dry-run must not copy payload files',
    );
    // …and the stale file was NOT deleted.
    assert.ok(
      fs.existsSync(staleManagedFile),
      'dry-run must not prune the stale file',
    );
  });

  it('writes .agents/.mandrel-version and it survives a second sync (Story #4530)', () => {
    const markerPath = path.join(consumer.agentsDir, '.mandrel-version');
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    );

    const first = runMandrel(consumer.dir, ['sync']);
    assert.equal(first.status, 0, `first sync failed: ${first.stderr}`);
    assert.ok(fs.existsSync(markerPath), 'marker must exist after first sync');
    assert.equal(
      fs.readFileSync(markerPath, 'utf8').trim(),
      pkgJson.version,
      'marker must carry the real package version',
    );

    const second = runMandrel(consumer.dir, ['sync']);
    assert.equal(second.status, 0, `second sync failed: ${second.stderr}`);
    assert.ok(
      fs.existsSync(markerPath),
      'marker must survive a second sync — it must never be pruned',
    );
    assert.doesNotMatch(
      second.stdout,
      /pruned \d+ stale file\(s\)/,
      'the marker must not be reported as a stale prune candidate',
    );
  });

  it('is idempotent — a second sync re-copies cleanly and reports no stale prune', () => {
    const first = runMandrel(consumer.dir, ['sync']);
    assert.equal(first.status, 0, `first sync failed: ${first.stderr}`);

    const second = runMandrel(consumer.dir, ['sync']);
    assert.equal(second.status, 0, `second sync failed: ${second.stderr}`);
    // After a clean first sync the destination already matches the payload, so
    // the second run has nothing stale to prune (no "pruned N stale" suffix).
    assert.doesNotMatch(second.stdout, /pruned \d+ stale file\(s\)/);
    assert.ok(
      fs.existsSync(path.join(consumer.agentsDir, KNOWN_PAYLOAD_FILE)),
      'payload file must remain after a second sync',
    );
  });
});
