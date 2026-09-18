import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { retireLintBaselineCommand } from '../../../lib/migrations/steps/2.32.0-retire-lint-baseline-command.js';

/**
 * The step strips the retired `project.commands.lintBaseline` key on upgrade.
 *
 * The case worth pinning is the **overlay**: `.agentrc.local.json` is
 * deep-merged over the base *before* the AJV gate runs, and `project.commands`
 * is `additionalProperties: false` — so a key surviving there fails validation
 * exactly as one in the base would. A step that swept only the base would
 * report "nothing to migrate" and leave that consumer hard-broken with no
 * self-service remedy, while the commit's own `BREAKING CHANGE:` footer
 * promises `npx mandrel update` deletes it for them.
 *
 * Every stub is a plain object passed through the step's optional `ctx.fs`
 * seam (`docs/contributing/test-seams.md` rules 1 and 5) — no module mocking.
 */

const ROOT = path.join(path.sep, 'repo');

/**
 * Build an in-memory `node:fs` stub over a `{ '<filename>': <config> }` map,
 * keyed by basename under a fixed project root.
 *
 * @param {Record<string, object>} files
 */
function makeFsStub(files) {
  const disk = new Map(
    Object.entries(files).map(([name, config]) => [
      path.join(ROOT, name),
      `${JSON.stringify(config, null, 2)}\n`,
    ]),
  );
  return {
    disk,
    readFileSync(file) {
      if (!disk.has(file)) throw new Error(`ENOENT: ${file}`);
      return disk.get(file);
    },
    writeFileSync(file, body) {
      disk.set(file, body);
    },
    read(name) {
      return JSON.parse(disk.get(path.join(ROOT, name)));
    },
  };
}

/** @param {Record<string, object>} files */
function ctxFor(files) {
  const fs = makeFsStub(files);
  return { ctx: { projectRoot: ROOT, fs }, fs };
}

const WITH_KEY = {
  project: {
    commands: { typecheck: 'tsc --noEmit', lintBaseline: 'eslint -f json' },
  },
};
const WITHOUT_KEY = { project: { commands: { typecheck: 'tsc --noEmit' } } };

describe('2.32.0 retire lintBaseline — base config', () => {
  it('detects and strips the key, leaving its siblings alone', () => {
    const { ctx, fs } = ctxFor({ '.agentrc.json': WITH_KEY });
    assert.equal(retireLintBaselineCommand.detect(ctx), true);

    retireLintBaselineCommand.apply(ctx);

    assert.deepEqual(fs.read('.agentrc.json'), WITHOUT_KEY);
    assert.equal(retireLintBaselineCommand.detect(ctx), false);
  });

  it('is a no-op for a consumer that never set the key', () => {
    const { ctx, fs } = ctxFor({ '.agentrc.json': WITHOUT_KEY });
    assert.equal(retireLintBaselineCommand.detect(ctx), false);

    retireLintBaselineCommand.apply(ctx);

    // Not merely equal — untouched. Rewriting a config the consumer owns to
    // change nothing would show up as a spurious diff on their next commit.
    assert.equal(
      fs.disk.get(path.join(ROOT, '.agentrc.json')).includes('lintBaseline'),
      false,
    );
    assert.deepEqual(fs.read('.agentrc.json'), WITHOUT_KEY);
  });

  it('survives an absent or unparsable config without throwing', () => {
    const { ctx } = ctxFor({});
    assert.equal(retireLintBaselineCommand.detect(ctx), false);
    assert.doesNotThrow(() => retireLintBaselineCommand.apply(ctx));
  });
});

describe('2.32.0 retire lintBaseline — local overlay', () => {
  it('detects the key when only the overlay carries it', () => {
    const { ctx } = ctxFor({
      '.agentrc.json': WITHOUT_KEY,
      '.agentrc.local.json': WITH_KEY,
    });
    // The whole point: the resolver validates the MERGED config, so an overlay
    // key is as fatal as a base one and the step must see it.
    assert.equal(retireLintBaselineCommand.detect(ctx), true);
  });

  it('strips the key from the overlay', () => {
    const { ctx, fs } = ctxFor({
      '.agentrc.json': WITHOUT_KEY,
      '.agentrc.local.json': WITH_KEY,
    });

    retireLintBaselineCommand.apply(ctx);

    assert.deepEqual(fs.read('.agentrc.local.json'), WITHOUT_KEY);
    assert.equal(retireLintBaselineCommand.detect(ctx), false);
  });

  it('strips the key from both surfaces in one pass', () => {
    const { ctx, fs } = ctxFor({
      '.agentrc.json': WITH_KEY,
      '.agentrc.local.json': WITH_KEY,
    });

    retireLintBaselineCommand.apply(ctx);

    assert.deepEqual(fs.read('.agentrc.json'), WITHOUT_KEY);
    assert.deepEqual(fs.read('.agentrc.local.json'), WITHOUT_KEY);
    assert.equal(retireLintBaselineCommand.detect(ctx), false);
  });

  it('leaves an untouched base config alone when only the overlay is dirty', () => {
    const { ctx, fs } = ctxFor({
      '.agentrc.json': WITHOUT_KEY,
      '.agentrc.local.json': WITH_KEY,
    });
    const baseBefore = fs.disk.get(path.join(ROOT, '.agentrc.json'));

    retireLintBaselineCommand.apply(ctx);

    assert.equal(fs.disk.get(path.join(ROOT, '.agentrc.json')), baseBefore);
  });

  it('is idempotent — a second apply changes nothing', () => {
    const { ctx, fs } = ctxFor({
      '.agentrc.json': WITH_KEY,
      '.agentrc.local.json': WITH_KEY,
    });

    retireLintBaselineCommand.apply(ctx);
    const after = new Map(fs.disk);
    retireLintBaselineCommand.apply(ctx);

    assert.deepEqual([...fs.disk.entries()], [...after.entries()]);
  });
});
