/**
 * tests/lib/memory-freshness-probes.test.js — Story #4414 / Epic #4406
 *
 * Three-valued probes (exists | missing | unknown) and the reversible stale
 * path for `scanMemoryFreshness`. All filesystem and gh-CLI access is routed
 * through injected seams so no real network or disk mutation occurs outside
 * the test's tmp directory.
 *
 * Contract under test:
 *  - A transient `gh` failure (rate-limit / auth / network) resolves to
 *    `unknown` and mutates nothing — it neither newly-stales a fresh entry nor
 *    un-stales a previously-stale one.
 *  - A confirmed 404 ("not found") resolves to `missing` and marks the entry
 *    stale.
 *  - A confirmed-closed issue preserves the existing closed-reference
 *    staleness semantics.
 *  - A stale entry whose references are all re-confirmed alive is un-staled via
 *    the atomic rewrite path (stale / staleReason / staleDetectedAt stripped).
 *  - Two consecutive scans over an unchanged memory dir are idempotent
 *    (byte-identical frontmatter).
 */

import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { scanMemoryFreshness } from '../../.agents/scripts/lib/feedback-loop/memory-freshness.js';

const OWNER = 'dsj1984';
const REPO = 'mandrel';

function makeTmpDir(label) {
  return mkdtempSync(path.join(os.tmpdir(), `memfresh-probes-${label}-`));
}

/**
 * Build a spawn stub that dispatches by argv. `route(args)` returns
 * `{ stdout?, stderr?, code? }` (defaults to `{ code: 0 }`). All gh calls are
 * simulated — nothing touches the real network.
 */
function makeSpawn(route) {
  return (_cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      const r = route(args) ?? { code: 0 };
      if (r.stdout) child.stdout.emit('data', Buffer.from(r.stdout));
      if (r.stderr) child.stderr.emit('data', Buffer.from(r.stderr));
      child.emit('close', r.code ?? 0);
    });
    return child;
  };
}

const isLabelProbe = (args) => args[0] === 'api' && /\/labels\//.test(args[1]);
const isIssueProbe = (args) => args[0] === 'issue' && args[1] === 'view';

describe('memory-freshness three-valued probes and reversible stale path', () => {
  let memoryDir;
  let projectRoot;

  beforeEach(async () => {
    memoryDir = makeTmpDir('mem');
    projectRoot = makeTmpDir('proj');
    await fs.writeFile(path.join(projectRoot, 'live-file.md'), '# live\n');
  });

  afterEach(async () => {
    await fs.rm(memoryDir, { recursive: true, force: true });
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  describe('AC1 — three-valued gh outcomes', () => {
    it('a transient (rate-limit) label failure yields no frontmatter mutation', async () => {
      const file = path.join(memoryDir, 'transient-label.md');
      const body =
        '---\ntitle: transient-label\n---\nUses label agent::executing here.\n';
      await fs.writeFile(file, body);

      const spawnImpl = makeSpawn((args) => {
        if (isLabelProbe(args)) {
          return {
            stderr: 'gh: API rate limit exceeded for user (HTTP 403)',
            code: 1,
          };
        }
        return { code: 0 };
      });

      const result = await scanMemoryFreshness({
        memoryDir,
        ghPath: 'gh',
        spawnImpl,
        owner: OWNER,
        repo: REPO,
        projectRoot,
      });

      assert.equal(
        result.staleEntries.find((e) => e.file === 'transient-label.md'),
        undefined,
        'a transient probe must not mark the entry stale',
      );
      const after = await fs.readFile(file, 'utf8');
      assert.equal(
        after,
        body,
        'frontmatter must be byte-identical — no mutation',
      );
    });

    it('a transient auth/network issue failure yields no frontmatter mutation', async () => {
      const file = path.join(memoryDir, 'transient-issue.md');
      const body = '---\ntitle: transient-issue\n---\nSee #4242 for context.\n';
      await fs.writeFile(file, body);

      for (const stderr of [
        'gh: authentication required — run gh auth login',
        'error connecting to api.github.com: dial tcp: lookup api.github.com: no such host',
        'error: request timed out (ETIMEDOUT)',
      ]) {
        await fs.writeFile(file, body);
        const spawnImpl = makeSpawn((args) =>
          isIssueProbe(args) ? { stderr, code: 1 } : { code: 0 },
        );
        const result = await scanMemoryFreshness({
          memoryDir,
          ghPath: 'gh',
          spawnImpl,
          owner: OWNER,
          repo: REPO,
          projectRoot,
        });
        assert.equal(
          result.staleEntries.length,
          0,
          `transient issue failure (${stderr}) must not mark stale`,
        );
        const after = await fs.readFile(file, 'utf8');
        assert.equal(
          after,
          body,
          `no mutation for transient failure: ${stderr}`,
        );
      }
    });

    it('a confirmed 404 label failure marks the entry stale (missing)', async () => {
      const file = path.join(memoryDir, 'missing-label.md');
      await fs.writeFile(
        file,
        '---\ntitle: missing-label\n---\nUses label gone::forever here.\n',
      );

      const spawnImpl = makeSpawn((args) =>
        isLabelProbe(args)
          ? { stderr: 'gh: Not Found (HTTP 404)', code: 1 }
          : { code: 0 },
      );

      const result = await scanMemoryFreshness({
        memoryDir,
        ghPath: 'gh',
        spawnImpl,
        owner: OWNER,
        repo: REPO,
        projectRoot,
      });

      const stale = result.staleEntries.find(
        (e) => e.file === 'missing-label.md',
      );
      assert.ok(stale, 'a confirmed 404 label must mark the entry stale');
      assert.match(stale.reason, /gone::forever/);
      const after = await fs.readFile(file, 'utf8');
      assert.match(after, /stale:\s*true/);
      assert.match(after, /staleReason:/);
      assert.match(after, /staleDetectedAt:/);
    });

    it('a confirmed 404 issue failure marks the entry stale (missing)', async () => {
      const file = path.join(memoryDir, 'missing-issue.md');
      await fs.writeFile(
        file,
        '---\ntitle: missing-issue\n---\nReferences #999999 which was purged.\n',
      );

      const spawnImpl = makeSpawn((args) =>
        isIssueProbe(args)
          ? {
              stderr:
                'GraphQL: Could not resolve to an Issue with the number of 999999. (repository.issue)',
              code: 1,
            }
          : { code: 0 },
      );

      const result = await scanMemoryFreshness({
        memoryDir,
        ghPath: 'gh',
        spawnImpl,
        owner: OWNER,
        repo: REPO,
        projectRoot,
      });

      const stale = result.staleEntries.find(
        (e) => e.file === 'missing-issue.md',
      );
      assert.ok(stale, 'a confirmed 404 issue must mark the entry stale');
      assert.match(stale.reason, /#999999/);
    });

    it('a confirmed-closed issue preserves closed-reference staleness semantics', async () => {
      const file = path.join(memoryDir, 'closed-issue.md');
      await fs.writeFile(
        file,
        '---\ntitle: closed-issue\n---\nSee #4242 for prior context.\n',
      );

      const spawnImpl = makeSpawn((args) =>
        isIssueProbe(args)
          ? { stdout: '{"state":"CLOSED"}', code: 0 }
          : { code: 0 },
      );

      const result = await scanMemoryFreshness({
        memoryDir,
        ghPath: 'gh',
        spawnImpl,
        owner: OWNER,
        repo: REPO,
        projectRoot,
      });

      const stale = result.staleEntries.find(
        (e) => e.file === 'closed-issue.md',
      );
      assert.ok(stale, 'a closed issue must still mark the entry stale');
      assert.match(stale.reason, /#4242 is closed/);

      // A re-scan while the issue is STILL closed must keep it stale (dead),
      // never un-stale it — preserving the closed-reference semantics.
      const bytesAfterFirst = await fs.readFile(file, 'utf8');
      const second = await scanMemoryFreshness({
        memoryDir,
        ghPath: 'gh',
        spawnImpl,
        owner: OWNER,
        repo: REPO,
        projectRoot,
      });
      assert.equal(
        second.unstaledEntries.length,
        0,
        'a still-closed issue must not be un-staled',
      );
      assert.equal(
        await fs.readFile(file, 'utf8'),
        bytesAfterFirst,
        'still-closed entry must stay byte-identical (remains stale)',
      );
    });
  });

  describe('AC2 — reversible stale path (un-stale on recovery)', () => {
    it('un-stales an entry whose referenced file now exists', async () => {
      // Prior run staled this entry against a then-missing file.
      const file = path.join(memoryDir, 'recovered.md');
      const body = [
        '---',
        'title: recovered',
        'stale: true',
        'staleReason: "file reference no longer exists: recovered-file.md"',
        'staleDetectedAt: 2026-05-01T00:00:00.000Z',
        '---',
        'Originally referenced recovered-file.md.',
        '',
      ].join('\n');
      await fs.writeFile(file, body);
      // The reference has since come back.
      await fs.writeFile(
        path.join(projectRoot, 'recovered-file.md'),
        '# back\n',
      );

      const result = await scanMemoryFreshness({
        memoryDir,
        ghPath: '',
        projectRoot,
      });

      const unstaled = result.unstaledEntries.find(
        (e) => e.file === 'recovered.md',
      );
      assert.ok(unstaled, 'recovered entry must be reported un-staled');

      const after = await fs.readFile(file, 'utf8');
      assert.doesNotMatch(after, /stale:/, 'stale key must be stripped');
      assert.doesNotMatch(
        after,
        /staleReason:/,
        'staleReason must be stripped',
      );
      assert.doesNotMatch(
        after,
        /staleDetectedAt:/,
        'staleDetectedAt must be stripped',
      );
      assert.match(after, /title: recovered/, 'other keys preserved');
      assert.match(
        after,
        /Originally referenced recovered-file\.md\./,
        'body preserved verbatim',
      );
    });

    it('does NOT un-stale when a probe is transient-unknown (evidence-gated)', async () => {
      const file = path.join(memoryDir, 'unknown-recovery.md');
      const body = [
        '---',
        'title: unknown-recovery',
        'stale: true',
        'staleReason: "label gone::forever no longer exists"',
        'staleDetectedAt: 2026-05-01T00:00:00.000Z',
        '---',
        'Referenced label maybe::back here.',
        '',
      ].join('\n');
      await fs.writeFile(file, body);

      // The label probe fails transiently — recovery cannot be confirmed.
      const spawnImpl = makeSpawn((args) =>
        isLabelProbe(args)
          ? { stderr: 'gh: API rate limit exceeded (HTTP 403)', code: 1 }
          : { code: 0 },
      );

      const result = await scanMemoryFreshness({
        memoryDir,
        ghPath: 'gh',
        spawnImpl,
        owner: OWNER,
        repo: REPO,
        projectRoot,
      });

      assert.equal(
        result.unstaledEntries.length,
        0,
        'a transient probe must not un-stale (recovery unconfirmed)',
      );
      assert.equal(
        await fs.readFile(file, 'utf8'),
        body,
        'entry must stay byte-identical while recovery is unconfirmed',
      );
    });
  });

  describe('AC3 — idempotency over an unchanged memory dir', () => {
    it('produces byte-identical frontmatter across two consecutive scans', async () => {
      // A mix: one entry that will be newly-staled, one that stays fresh,
      // one already-stale-and-still-dead, one that will be un-staled.
      const deadFile = path.join(memoryDir, 'dead.md');
      await fs.writeFile(
        deadFile,
        '---\ntitle: dead\n---\nPoints at gone-target.js which is gone.\n',
      );
      const freshFile = path.join(memoryDir, 'fresh.md');
      await fs.writeFile(
        freshFile,
        '---\ntitle: fresh\n---\nOnly references live-file.md.\n',
      );
      const stuckFile = path.join(memoryDir, 'stuck.md');
      await fs.writeFile(
        stuckFile,
        [
          '---',
          'title: stuck',
          'stale: true',
          'staleReason: "file reference no longer exists: still-gone.js"',
          'staleDetectedAt: 2026-05-01T00:00:00.000Z',
          '---',
          'Points at still-gone.js.',
          '',
        ].join('\n'),
      );

      // First pass: stales `dead.md`, leaves the rest as-is.
      await scanMemoryFreshness({ memoryDir, ghPath: '', projectRoot });
      const snapshot = {
        dead: await fs.readFile(deadFile, 'utf8'),
        fresh: await fs.readFile(freshFile, 'utf8'),
        stuck: await fs.readFile(stuckFile, 'utf8'),
      };

      // Second pass over the unchanged dir must not mutate any file.
      const second = await scanMemoryFreshness({
        memoryDir,
        ghPath: '',
        projectRoot,
      });
      assert.equal(
        second.staleEntries.length,
        0,
        'second pass must not newly-stale any entry',
      );
      assert.equal(
        second.unstaledEntries.length,
        0,
        'second pass must not un-stale any entry',
      );
      assert.equal(await fs.readFile(deadFile, 'utf8'), snapshot.dead);
      assert.equal(await fs.readFile(freshFile, 'utf8'), snapshot.fresh);
      assert.equal(await fs.readFile(stuckFile, 'utf8'), snapshot.stuck);
    });
  });

  describe('AC4 — bounded gh spawns (timeout → unknown, never missing)', () => {
    // A spawn stub whose child NEVER emits `close` (a hung `gh`). It records
    // `kill()` calls so the test can assert the watchdog SIGKILL'd it. No
    // stdio data is emitted and no handles are held, so the child leaves the
    // event loop idle — the condition under which an unref'd watchdog timer
    // would silently never fire. This test therefore only passes when the
    // watchdog timer is REF'd. It is authored to run in ISOLATION
    // (`node --test tests/lib/memory-freshness-probes.test.js`) so that
    // idle-loop condition is reproduced; it must not hang.
    function makeHangingSpawn() {
      const killed = [];
      const fn = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = (signal) => {
          killed.push(signal);
          return true;
        };
        // Deliberately never emit `close` / `error` / data.
        return child;
      };
      fn.killed = killed;
      return fn;
    }

    it('a hung label probe is killed and resolves unknown (no stale mutation)', async () => {
      const file = path.join(memoryDir, 'hung-label.md');
      const body =
        '---\ntitle: hung-label\n---\nUses label agent::executing here.\n';
      await fs.writeFile(file, body);

      const spawnImpl = makeHangingSpawn();
      const result = await scanMemoryFreshness({
        memoryDir,
        ghPath: 'gh',
        spawnImpl,
        owner: OWNER,
        repo: REPO,
        projectRoot,
        probeTimeoutMs: 25,
      });

      assert.equal(
        result.staleEntries.length,
        0,
        'a timed-out probe resolves unknown and must not mark the entry stale',
      );
      assert.deepEqual(
        spawnImpl.killed,
        ['SIGKILL'],
        'the watchdog must SIGKILL the hung child',
      );
      assert.equal(
        await fs.readFile(file, 'utf8'),
        body,
        'frontmatter must be byte-identical — a hung probe mutates nothing',
      );
    });

    it('a hung issue probe is killed and resolves unknown (no stale mutation)', async () => {
      const file = path.join(memoryDir, 'hung-issue.md');
      const body = '---\ntitle: hung-issue\n---\nSee #4242 for context.\n';
      await fs.writeFile(file, body);

      const spawnImpl = makeHangingSpawn();
      const result = await scanMemoryFreshness({
        memoryDir,
        ghPath: 'gh',
        spawnImpl,
        owner: OWNER,
        repo: REPO,
        projectRoot,
        probeTimeoutMs: 25,
      });

      assert.equal(
        result.staleEntries.length,
        0,
        'a timed-out issue probe resolves unknown and must not mark stale',
      );
      assert.deepEqual(spawnImpl.killed, ['SIGKILL']);
      assert.equal(await fs.readFile(file, 'utf8'), body);
    });
  });
});
