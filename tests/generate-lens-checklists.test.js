import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildExpected,
  planChecklists,
  runGenerateLensChecklists,
} from '../.agents/scripts/generate-lens-checklists.js';

/**
 * Story #4780 — the generator's CLI shell scored CRAP 90: neither the
 * `--check` drift gate (wired into `npm run docs:check`) nor the write/prune
 * pass had a single test, so a drift gate that stopped detecting drift would
 * have looked green.
 *
 * The filesystem, the lens taxonomy, and both directories are injected
 * through the optional final `deps` parameter (`docs/contributing/test-seams.md`
 * rules 1 and 5) — a plain stub object, never a module mock, so the real
 * `.agents/audit-checklists` tree is untouched.
 */

const ROOT = path.resolve(path.sep, 'repo');
const WORKFLOWS = path.join(ROOT, '.agents', 'workflows');
const CHECKLISTS = path.join(ROOT, '.agents', 'audit-checklists');

/**
 * @param {Record<string, string>} files absolute path → content
 */
function makeFsStub(files) {
  const writes = {};
  const removed = [];
  const mkdirs = [];
  return {
    writes,
    removed,
    mkdirs,
    existsSync: (p) =>
      p in files ||
      Object.keys(files).some((f) => f.startsWith(`${p}${path.sep}`)),
    readFileSync: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    readdirSync: (dir) =>
      Object.keys(files)
        .filter((f) => path.dirname(f) === dir)
        .map((f) => path.basename(f)),
    mkdirSync: (dir) => mkdirs.push(dir),
    writeFileSync: (p, content) => {
      writes[p] = content;
      files[p] = content;
    },
    rmSync: (p) => {
      removed.push(p);
      delete files[p];
    },
  };
}

const deps = (files, lenses) => ({
  fsImpl: makeFsStub(files),
  lenses,
  workflowsDir: WORKFLOWS,
  checklistsDir: CHECKLISTS,
  projectRoot: ROOT,
  logger: { info: () => {} },
});

const workflowBody = (lens) =>
  [
    '---',
    `description: The ${lens} lens.`,
    '---',
    '',
    `# /audit-${lens}`,
    '',
    '## Dimensions',
    '',
    `- Something the ${lens} lens checks.`,
    '',
  ].join('\n');

describe('planChecklists', () => {
  it('records a lens with no workflow as missing rather than skipping it', () => {
    const { expected, missing } = planChecklists(
      ['present', 'absent'],
      (lens) => lens === 'present',
      () => workflowBody('present'),
    );
    assert.deepEqual([...expected.keys()], ['present.md']);
    assert.deepEqual(missing, ['absent']);
  });

  it('returns an empty plan for an empty taxonomy', () => {
    const { expected, missing } = planChecklists(
      [],
      () => true,
      () => '',
    );
    assert.equal(expected.size, 0);
    assert.deepEqual(missing, []);
  });
});

describe('buildExpected', () => {
  it('reports on-disk files that map to no current lens as strays', () => {
    const files = {
      [path.join(WORKFLOWS, 'audit-alpha.md')]: workflowBody('alpha'),
      [path.join(CHECKLISTS, 'alpha.md')]: 'stale',
      [path.join(CHECKLISTS, 'retired.md')]: 'stray',
      [path.join(CHECKLISTS, 'notes.txt')]: 'ignored — not markdown',
    };
    const d = deps(files, ['alpha']);
    const { expected, missing, strays } = buildExpected(d);
    assert.deepEqual([...expected.keys()], ['alpha.md']);
    assert.deepEqual(missing, []);
    assert.deepEqual(strays, ['retired.md']);
  });

  it('reports no strays when the checklist directory does not exist yet', () => {
    const d = deps(
      { [path.join(WORKFLOWS, 'audit-alpha.md')]: workflowBody('alpha') },
      ['alpha'],
    );
    assert.deepEqual(buildExpected(d).strays, []);
  });
});

describe('runGenerateLensChecklists --check', () => {
  it('passes when every checklist matches and no stray exists', async () => {
    const files = {
      [path.join(WORKFLOWS, 'audit-alpha.md')]: workflowBody('alpha'),
    };
    const d = deps(files, ['alpha']);
    // Seed the on-disk file with exactly what the generator would write.
    const generated = buildExpected(d).expected.get('alpha.md');
    files[path.join(CHECKLISTS, 'alpha.md')] = generated;

    const result = await runGenerateLensChecklists(['--check'], d);
    assert.deepEqual(result, { wrote: 0, pruned: 0, checked: true });
    assert.deepEqual(d.fsImpl.writes, {});
  });

  it('throws naming the out-of-date checklist', async () => {
    const files = {
      [path.join(WORKFLOWS, 'audit-alpha.md')]: workflowBody('alpha'),
      [path.join(CHECKLISTS, 'alpha.md')]: 'drifted content',
    };
    await assert.rejects(
      () => runGenerateLensChecklists(['--check'], deps(files, ['alpha'])),
      (err) => {
        assert.match(err.message, /Lens checklists are out of sync/);
        assert.match(
          err.message,
          /out of date: \.agents\/audit-checklists\/alpha\.md/,
        );
        assert.match(
          err.message,
          /Run `node \.agents\/scripts\/generate-lens-checklists\.js`/,
        );
        return true;
      },
    );
  });

  it('throws naming a checklist that is missing entirely', async () => {
    const files = {
      [path.join(WORKFLOWS, 'audit-alpha.md')]: workflowBody('alpha'),
    };
    await assert.rejects(
      () => runGenerateLensChecklists(['--check'], deps(files, ['alpha'])),
      /out of date: \.agents\/audit-checklists\/alpha\.md/,
    );
  });

  it('throws naming a stray that maps to no lens', async () => {
    const files = {
      [path.join(WORKFLOWS, 'audit-alpha.md')]: workflowBody('alpha'),
      [path.join(CHECKLISTS, 'retired.md')]: 'stray',
    };
    const d = deps(files, ['alpha']);
    files[path.join(CHECKLISTS, 'alpha.md')] =
      buildExpected(d).expected.get('alpha.md');
    await assert.rejects(
      () => runGenerateLensChecklists(['--check'], d),
      /stray \(no lens\): \.agents\/audit-checklists\/retired\.md/,
    );
  });

  it('reports a lens with no workflow instead of silently skipping it', async () => {
    const infos = [];
    const files = {
      [path.join(WORKFLOWS, 'audit-alpha.md')]: workflowBody('alpha'),
    };
    const d = {
      ...deps(files, ['alpha', 'ghost']),
      logger: { info: (m) => infos.push(m) },
    };
    files[path.join(CHECKLISTS, 'alpha.md')] =
      buildExpected(d).expected.get('alpha.md');
    await runGenerateLensChecklists(['--check'], d);
    assert.match(
      infos[0],
      /no audit-<lens>\.md for: ghost — no checklist emitted/,
    );
  });
});

describe('runGenerateLensChecklists (write mode)', () => {
  it('writes every missing checklist and creates the directory', async () => {
    const files = {
      [path.join(WORKFLOWS, 'audit-alpha.md')]: workflowBody('alpha'),
      [path.join(WORKFLOWS, 'audit-beta.md')]: workflowBody('beta'),
    };
    const d = deps(files, ['alpha', 'beta']);
    const result = await runGenerateLensChecklists([], d);
    assert.deepEqual(result, { wrote: 2, pruned: 0 });
    assert.deepEqual(d.fsImpl.mkdirs, [CHECKLISTS]);
    assert.deepEqual(Object.keys(d.fsImpl.writes).sort(), [
      path.join(CHECKLISTS, 'alpha.md'),
      path.join(CHECKLISTS, 'beta.md'),
    ]);
  });

  it('is idempotent: an up-to-date checklist is not rewritten', async () => {
    const files = {
      [path.join(WORKFLOWS, 'audit-alpha.md')]: workflowBody('alpha'),
    };
    const first = deps(files, ['alpha']);
    await runGenerateLensChecklists([], first);
    const second = deps(files, ['alpha']);
    const result = await runGenerateLensChecklists([], second);
    assert.deepEqual(result, { wrote: 0, pruned: 0 });
    assert.deepEqual(second.fsImpl.writes, {});
  });

  it('prunes strays and reports each one', async () => {
    const infos = [];
    const files = {
      [path.join(WORKFLOWS, 'audit-alpha.md')]: workflowBody('alpha'),
      [path.join(CHECKLISTS, 'retired.md')]: 'stray',
    };
    const d = {
      ...deps(files, ['alpha']),
      logger: { info: (m) => infos.push(m) },
    };
    const result = await runGenerateLensChecklists([], d);
    assert.equal(result.pruned, 1);
    assert.deepEqual(d.fsImpl.removed, [path.join(CHECKLISTS, 'retired.md')]);
    assert.ok(
      infos.some((m) =>
        /pruned stray \.agents\/audit-checklists\/retired\.md/.test(m),
      ),
    );
    assert.ok(
      infos.some((m) => /wrote 1 of 1 checklist\(s\) \(1 pruned\)/.test(m)),
    );
  });
});
