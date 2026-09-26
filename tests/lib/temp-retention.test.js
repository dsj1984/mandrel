/**
 * temp-retention.test.js — the allowlisted temp auto-purge (Story #4794).
 *
 * Every case runs against a real temp tree under an **absolute** `tempRoot`
 * in `os.tmpdir()`. Absolute roots bypass `anchorTempRoot`'s scratch redirect
 * verbatim, so these tests exercise the same resolution production does while
 * staying nowhere near the repo's real `temp/`.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import {
  collectTempEntries,
  formatBytes,
  KEEP_BASENAMES,
  PURGE_CLASS_NAMES,
  purgeStoryTempArtifacts,
  resolveTempRetention,
  sweepTempRetention,
  TEMP_RETENTION_DEFAULTS,
} from '../../.agents/scripts/lib/temp-retention.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const DAY = 24 * 60 * 60 * 1000;
const roots = [];

/** A fresh absolute temp root, torn down after the suite. */
function makeRoot() {
  const root = makeTempDir('temp-retention-');
  roots.push(root);
  return root;
}

/** Write a file (creating parents), optionally aged by `ageMs`. */
function writeAged(target, body = 'x', ageMs = 0) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(target, when, when);
  }
  return target;
}

/** Make a directory, optionally aged by `ageMs`. */
function mkdirAged(target, ageMs = 0) {
  mkdirSync(target, { recursive: true });
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(target, when, when);
  }
  return target;
}

/** The standalone story dir for `sid` under `root`. */
const storyDir = (root, sid) =>
  path.join(root, 'standalone', 'stories', `story-${sid}`);

/** A silent logger so the suite's output stays clean. */
const quiet = { info: () => {} };

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('resolveTempRetention — the one knob, defaulting to on', () => {
  it('defaults every field when the block is absent entirely', () => {
    const policy = resolveTempRetention(undefined);
    assert.equal(policy.enabled, true);
    assert.equal(policy.staleDays, TEMP_RETENTION_DEFAULTS.staleDays);
    for (const name of PURGE_CLASS_NAMES) {
      assert.equal(policy.classes[name], true, `${name} defaults on`);
    }
  });

  it('honours an explicit disable and a per-class opt-out', () => {
    const policy = resolveTempRetention({
      delivery: {
        tempRetention: { enabled: false, classes: { auditResults: false } },
      },
    });
    assert.equal(policy.enabled, false);
    assert.equal(policy.classes.auditResults, false);
    // Unmentioned classes still default on — a partial block is a patch,
    // not a replacement.
    assert.equal(policy.classes.orchestrationLogs, true);
  });
});

describe('classification — allowlist, never a blocklist', () => {
  it('claims the declared classes and nothing else', async () => {
    const root = makeRoot();
    writeAged(path.join(root, 'orchestration', 'close-gates-4794.log'));
    writeAged(path.join(storyDir(root, 4794), 'validation-evidence.json'));
    writeAged(path.join(root, 'audits', 'audit-story-4794-audit-perf.md'));
    mkdirAged(path.join(root, 'plan-some-slug'));
    writeAged(path.join(root, 'scratch', 'story-4794', 'notes.md'));

    const { entries } = await collectTempEntries({ tempRoot: root });
    const byClass = new Map(entries.map((e) => [e.className, e]));

    assert.deepEqual(
      [...byClass.keys()].sort(),
      [...PURGE_CLASS_NAMES].sort(),
      'every declared class is represented',
    );
    assert.equal(byClass.get('orchestrationLogs').storyId, 4794);
    assert.equal(byClass.get('validationEvidence').storyId, 4794);
    assert.equal(byClass.get('auditResults').storyId, 4794);
    assert.equal(
      byClass.get('planDirs').storyId,
      null,
      'a plan dir predates the Stories it creates, so it is never Story-keyed',
    );
    assert.equal(byClass.get('scratch').storyId, 4794);
  });

  it('reports an unclaimed top-level entry as unrecognized, with its size', async () => {
    const root = makeRoot();
    writeAged(
      path.join(root, 'scratch-experiment', 'notes.md'),
      'y'.repeat(64),
    );
    writeAged(path.join(root, 'orchestration', 'close-gates-1.log'));

    const { entries, unrecognized } = await collectTempEntries({
      tempRoot: root,
    });

    const scratch = path.join(root, 'scratch-experiment');
    assert.ok(
      !entries.some((e) => e.path.startsWith(scratch)),
      'no class claims an operator scratch dir',
    );
    const reported = unrecognized.find((u) => u.path === scratch);
    assert.ok(reported, 'the scratch dir is reported to the operator');
    assert.equal(reported.bytes, 64, 'reported with a real recursive size');
  });

  it('never reports the framework-reserved trees as unrecognized', async () => {
    const root = makeRoot();
    writeAged(path.join(root, 'qa', 'session-a.ndjson'));
    writeAged(path.join(root, 'cache', 'project-meta.json'));
    writeAged(path.join(root, 'boot-sweep.lock'));

    const { unrecognized } = await collectTempEntries({ tempRoot: root });
    assert.deepEqual(unrecognized, [], 'qa/, cache/ and locks are neither');
  });

  it('recovers the Story id from both orchestration log shapes', async () => {
    const root = makeRoot();
    writeAged(path.join(root, 'orchestration', 'close-gates-4794.log'));
    writeAged(path.join(root, 'orchestration', 'sync-result-story-4794.log'));
    writeAged(path.join(root, 'orchestration', 'unkeyed.log'));

    const { entries } = await collectTempEntries({ tempRoot: root });
    const ids = new Map(entries.map((e) => [path.basename(e.path), e.storyId]));
    assert.equal(ids.get('close-gates-4794.log'), 4794);
    assert.equal(ids.get('sync-result-story-4794.log'), 4794);
    assert.equal(ids.get('unkeyed.log'), null);
  });
});

describe('purgeStoryTempArtifacts — the post-land path', () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
  });

  it('purges the merged Story and reports the bytes it reclaimed', async () => {
    const gates = writeAged(
      path.join(root, 'orchestration', 'close-gates-4794.log'),
      'g'.repeat(100),
    );
    const evidence = writeAged(
      path.join(storyDir(root, 4794), 'validation-evidence.json'),
      'e'.repeat(50),
    );

    const result = await purgeStoryTempArtifacts({
      storyId: 4794,
      tempRoot: root,
      logger: quiet,
    });

    assert.equal(existsSync(gates), false);
    assert.equal(existsSync(evidence), false);
    assert.equal(result.bytesReclaimed, 150);
    assert.deepEqual(
      result.purged.map((p) => p.path).sort(),
      [gates, evidence].sort(),
    );
    assert.deepEqual(result.errors, []);
  });

  it('KEEPS signals.ndjson for the very Story whose evidence it purges', async () => {
    const signals = writeAged(
      path.join(storyDir(root, 4794), 'signals.ndjson'),
      '{"kind":"signal"}\n',
    );
    const evidence = writeAged(
      path.join(storyDir(root, 4794), 'validation-evidence.json'),
    );

    const result = await purgeStoryTempArtifacts({
      storyId: 4794,
      tempRoot: root,
      logger: quiet,
    });

    assert.equal(existsSync(evidence), false, 'the sibling evidence went');
    assert.equal(existsSync(signals), true, 'the signal stream stayed');
    assert.ok(
      result.kept.includes(signals),
      'and the envelope says so rather than staying silent',
    );
    assert.deepEqual(KEEP_BASENAMES, ['signals.ndjson']);
  });

  it('leaves an unrecognized file inside a Story dir alone', async () => {
    const mystery = writeAged(
      path.join(storyDir(root, 4794), 'notes-by-hand.md'),
    );
    await purgeStoryTempArtifacts({
      storyId: 4794,
      tempRoot: root,
      logger: quiet,
    });
    assert.equal(
      existsSync(mystery),
      true,
      'a basename the module was never taught about is kept, not guessed at',
    );
  });

  it('never touches a sibling Story that did not merge', async () => {
    const mine = writeAged(
      path.join(root, 'orchestration', 'close-gates-4794.log'),
    );
    const sibling = writeAged(
      path.join(root, 'orchestration', 'close-gates-4795.log'),
    );

    await purgeStoryTempArtifacts({
      storyId: 4794,
      tempRoot: root,
      logger: quiet,
    });

    assert.equal(existsSync(mine), false);
    assert.equal(existsSync(sibling), true);
  });

  it('never applies the age floor — an ancient sibling artifact survives', async () => {
    const ancient = writeAged(
      path.join(root, 'orchestration', 'close-gates-4000.log'),
      'x',
      365 * DAY,
    );
    await purgeStoryTempArtifacts({
      storyId: 4794,
      tempRoot: root,
      logger: quiet,
    });
    assert.equal(
      existsSync(ancient),
      true,
      'the post-land path is Story-keyed only, so it cannot reap in-flight work',
    );
  });

  it('is a reported no-op when the policy is disabled', async () => {
    const gates = writeAged(
      path.join(root, 'orchestration', 'close-gates-4794.log'),
    );
    const result = await purgeStoryTempArtifacts({
      storyId: 4794,
      config: { delivery: { tempRetention: { enabled: false } } },
      tempRoot: root,
      logger: quiet,
    });

    assert.equal(result.enabled, false);
    assert.equal(result.skipped, 'disabled');
    assert.deepEqual(result.purged, []);
    assert.equal(existsSync(gates), true, 'zero files deleted');
  });

  it('honours a per-class opt-out', async () => {
    const gates = writeAged(
      path.join(root, 'orchestration', 'close-gates-4794.log'),
    );
    const evidence = writeAged(
      path.join(storyDir(root, 4794), 'validation-evidence.json'),
    );

    await purgeStoryTempArtifacts({
      storyId: 4794,
      config: {
        delivery: { tempRetention: { classes: { orchestrationLogs: false } } },
      },
      tempRoot: root,
      logger: quiet,
    });

    assert.equal(existsSync(gates), true, 'the opted-out class survived');
    assert.equal(existsSync(evidence), false, 'the rest still purged');
  });

  it('resolves rather than throws when the temp root does not exist', async () => {
    const result = await purgeStoryTempArtifacts({
      storyId: 4794,
      tempRoot: path.join(root, 'nope', 'not-here'),
      logger: quiet,
    });
    assert.deepEqual(result.purged, []);
    assert.deepEqual(result.errors, []);
  });

  it('collects a delete failure into errors instead of throwing', async () => {
    writeAged(path.join(root, 'orchestration', 'close-gates-4794.log'));
    const result = await purgeStoryTempArtifacts({
      storyId: 4794,
      tempRoot: root,
      logger: quiet,
      fsp: {
        readdir: (await import('node:fs/promises')).readdir,
        stat: (await import('node:fs/promises')).stat,
        rm: async () => {
          throw new Error('EPERM: denied');
        },
      },
    });
    assert.deepEqual(result.purged, []);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /EPERM: denied/);
  });
});

describe('sweepTempRetention — the boot catch-up path', () => {
  it('purges past the age floor and keeps everything inside it', async () => {
    const root = makeRoot();
    const ancient = writeAged(
      path.join(root, 'audits', 'audit-dependencies-results.md'),
      'a',
      30 * DAY,
    );
    const recent = writeAged(
      path.join(root, 'audits', 'audit-performance-results.md'),
      'b',
      1 * DAY,
    );

    const result = await sweepTempRetention({ tempRoot: root, logger: quiet });

    assert.equal(existsSync(ancient), false);
    assert.equal(existsSync(recent), true);
    assert.deepEqual(
      result.purged.map((p) => p.path),
      [ancient],
    );
  });

  it('purges a confirmed-merged Story inside the age floor', async () => {
    const root = makeRoot();
    const fresh = writeAged(
      path.join(root, 'orchestration', 'close-gates-4794.log'),
    );
    const otherFresh = writeAged(
      path.join(root, 'orchestration', 'close-gates-4795.log'),
    );

    await sweepTempRetention({
      tempRoot: root,
      mergedStoryIds: [4794],
      logger: quiet,
    });

    assert.equal(existsSync(fresh), false, 'confirmed merged → purged now');
    assert.equal(existsSync(otherFresh), true, 'unconfirmed → waits');
  });

  it('holds the fixed 7-day floor whatever a leftover staleDays says (Story #5382)', async () => {
    const root = makeRoot();
    const target = writeAged(
      path.join(root, 'audits', 'audit-seo-results.md'),
      'a',
      3 * DAY,
    );
    await sweepTempRetention({
      config: { delivery: { tempRetention: { staleDays: 2 } } },
      tempRoot: root,
      logger: quiet,
    });
    assert.equal(existsSync(target), true, '3 days old is inside the floor');
  });

  it('restricts to the named classes and honours excludePaths', async () => {
    const root = makeRoot();
    const stalePlan = mkdirAged(path.join(root, 'plan-abandoned'), 30 * DAY);
    const currentPlan = mkdirAged(path.join(root, 'plan-current'), 30 * DAY);
    const staleLog = writeAged(
      path.join(root, 'orchestration', 'close-gates-1.log'),
      'x',
      30 * DAY,
    );

    const result = await sweepTempRetention({
      tempRoot: root,
      only: ['planDirs'],
      excludePaths: [currentPlan],
      logger: quiet,
    });

    assert.deepEqual(
      result.purged.map((p) => p.path),
      [stalePlan],
    );
    assert.equal(existsSync(currentPlan), true, 'the excluded dir survives');
    assert.equal(existsSync(staleLog), true, 'an unnamed class is untouched');
  });

  it('never age-purges an operator scratch dir, however old', async () => {
    const root = makeRoot();
    const scratch = path.join(root, 'no-escalate-fix');
    writeAged(path.join(scratch, 'v1', 'big.bin'), 'z'.repeat(10), 400 * DAY);
    mkdirAged(scratch, 400 * DAY);

    const result = await sweepTempRetention({ tempRoot: root, logger: quiet });

    assert.equal(existsSync(scratch), true);
    assert.deepEqual(result.purged, []);
    assert.ok(
      result.unrecognized.some((u) => u.path === scratch),
      'it is surfaced for the operator rather than reaped',
    );
  });
});

describe('the scratch class — agent-authored temp files are reapable (#5459)', () => {
  it('a Story landing purges its scratch/story-<id>/ through the post-land path', async () => {
    const root = makeRoot();
    const mine = path.join(root, 'scratch', 'story-5459');
    writeAged(path.join(mine, 'probe.js'), 'p'.repeat(20));
    writeAged(path.join(mine, 'deep', 'out.log'), 'o'.repeat(10));
    const sibling = writeAged(
      path.join(root, 'scratch', 'story-5460', 'probe.js'),
    );
    const loose = writeAged(path.join(root, 'scratch', 'adhoc.txt'));

    const result = await purgeStoryTempArtifacts({
      storyId: 5459,
      tempRoot: root,
      logger: quiet,
    });

    assert.equal(existsSync(mine), false, 'the landed Story scratch went');
    assert.equal(existsSync(sibling), true, 'an unlanded sibling stays');
    assert.equal(existsSync(loose), true, 'post-land never age-floors');
    assert.equal(result.bytesReclaimed, 30);
  });

  it('the boot sweep age-floors every other scratch entry', async () => {
    const root = makeRoot();
    const stale = mkdirAged(path.join(root, 'scratch', 'old-probe'), 0);
    writeAged(path.join(stale, 'x.txt'), 'x', 30 * DAY);
    mkdirAged(stale, 30 * DAY);
    const staleFile = writeAged(
      path.join(root, 'scratch', 'old.txt'),
      'x',
      30 * DAY,
    );
    const fresh = writeAged(path.join(root, 'scratch', 'new.txt'), 'x', DAY);

    const result = await sweepTempRetention({ tempRoot: root, logger: quiet });

    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(staleFile), false);
    assert.equal(existsSync(fresh), true, 'inside the floor survives');
    assert.ok(
      !result.unrecognized.some((u) => u.path.includes('scratch')),
      'scratch/ is class-owned, never reported as unrecognized',
    );
  });

  it('spares a signals.ndjson nested anywhere inside a purged scratch dir', async () => {
    const root = makeRoot();
    const dir = path.join(root, 'scratch', 'story-5459');
    const signals = writeAged(path.join(dir, 'a', 'b', 'signals.ndjson'));
    const junk = writeAged(path.join(dir, 'a', 'junk.txt'));

    const result = await purgeStoryTempArtifacts({
      storyId: 5459,
      tempRoot: root,
      logger: quiet,
    });

    assert.equal(existsSync(junk), false);
    assert.equal(existsSync(signals), true);
    assert.ok(result.kept.includes(signals));
  });

  it('honours the scratch class opt-out', async () => {
    const root = makeRoot();
    const mine = writeAged(path.join(root, 'scratch', 'story-5459', 'p.js'));
    await purgeStoryTempArtifacts({
      storyId: 5459,
      config: { delivery: { tempRetention: { classes: { scratch: false } } } },
      tempRoot: root,
      logger: quiet,
    });
    assert.equal(existsSync(mine), true);
  });

  it('a dry run reports what would go and deletes nothing', async () => {
    const root = makeRoot();
    const mine = writeAged(path.join(root, 'scratch', 'story-5459', 'p.js'));
    const result = await sweepTempRetention({
      tempRoot: root,
      mergedStoryIds: [5459],
      dryRun: true,
      logger: quiet,
    });
    assert.equal(existsSync(mine), true);
    assert.deepEqual(
      result.purged.map((p) => p.path),
      [path.join(root, 'scratch', 'story-5459')],
    );
  });
});

describe('unrecognized entries — reported for /clean-temp', () => {
  it('reports each unrecognized entry with its own mtime', async () => {
    const root = makeRoot();
    const old = writeAged(path.join(root, 'old.txt'), 'x', 30 * DAY);
    const { unrecognized } = await collectTempEntries({ tempRoot: root });
    const row = unrecognized.find((u) => u.path === old);
    assert.ok(Date.now() - row.mtimeMs >= 29 * DAY);
  });

  it('never reports a top-level signals.ndjson as unrecognized', async () => {
    const root = makeRoot();
    writeAged(path.join(root, 'signals.ndjson'));
    const { unrecognized } = await collectTempEntries({ tempRoot: root });
    assert.deepEqual(unrecognized, []);
  });
});

describe('formatBytes', () => {
  it('renders each magnitude the summary line can hit', () => {
    assert.equal(formatBytes(512), '512B');
    assert.equal(formatBytes(2048), '2.0KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0MB');
    assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.0GB');
  });
});

describe('the persisted terminal envelope is reapable (#4816)', () => {
  it('claims story-deliver-terminal-<id>.json for the orchestrationLogs class', async () => {
    // Before this, the scanner took `*.log` only — so the envelope the close
    // now persists would have been the one file in `orchestration/` the purge
    // could never reap, accumulating one per delivered Story forever.
    const root = makeRoot();
    writeAged(
      path.join(root, 'orchestration', 'story-deliver-terminal-4816.json'),
    );

    const { entries, unrecognized } = await collectTempEntries({
      tempRoot: root,
    });
    const entry = entries.find((e) =>
      e.path.endsWith('story-deliver-terminal-4816.json'),
    );
    assert.ok(entry, 'the envelope is classified, not left unrecognized');
    assert.equal(entry.className, 'orchestrationLogs');
    assert.equal(entry.storyId, 4816, 'the Story scope is parsed off the name');
    assert.equal(unrecognized.length, 0);
  });

  it('keys the envelope and its gate log to the same Story', async () => {
    // They are two artifacts of one close, so a Story-scoped purge must take
    // both or neither.
    const root = makeRoot();
    writeAged(path.join(root, 'orchestration', 'close-gates-4816.log'));
    writeAged(
      path.join(root, 'orchestration', 'story-deliver-terminal-4816.json'),
    );

    const { entries } = await collectTempEntries({ tempRoot: root });
    const scoped = entries.filter((e) => e.className === 'orchestrationLogs');
    assert.equal(scoped.length, 2);
    assert.deepEqual([...new Set(scoped.map((e) => e.storyId))], [4816]);
  });

  it('still ignores a file type the class does not own', async () => {
    const root = makeRoot();
    writeAged(path.join(root, 'orchestration', 'notes-4816.txt'));

    const { entries } = await collectTempEntries({ tempRoot: root });
    assert.equal(
      entries.filter((e) => e.className === 'orchestrationLogs').length,
      0,
    );
  });
});
