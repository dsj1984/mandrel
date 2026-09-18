import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import check, {
  scanFile,
  walkSources,
} from '../../../.agents/scripts/lib/checks/story-init-not-backgrounded.js';

/**
 * Story #4780 — `scanFile` scored CRAP 72 and `walkSources` 21.5 with no test
 * file at all: the blocker check that stops `single-story-init.js` from being
 * backgrounded had none of its own detection rules verified.
 *
 * The filesystem is injected as a plain stub through the optional final
 * `fsImpl` parameter (`docs/contributing/test-seams.md` rules 1, 4 and 5). No
 * module mocking, and the seam lives on the functions — never on a
 * module-level variable.
 */

const ROOT = path.resolve(path.sep, 'repo', '.agents');
const at = (...parts) => path.join(ROOT, ...parts);

/**
 * In-memory `node:fs` stub over a `{ '<abs path>': '<content>' }` map.
 * Directories are inferred from the keys.
 *
 * @param {Record<string, string>} files
 * @param {{ unreadable?: string[] }} [opts]
 */
function makeFsStub(files, { unreadable = [] } = {}) {
  const dirs = new Set();
  for (const file of Object.keys(files)) {
    let dir = path.dirname(file);
    while (dir && dir !== path.dirname(dir)) {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }
  return {
    readdirSync(dir) {
      if (!dirs.has(dir)) throw new Error(`ENOENT: ${dir}`);
      const names = new Map();
      for (const file of Object.keys(files)) {
        if (path.dirname(file) === dir) {
          names.set(path.basename(file), false);
          continue;
        }
        if (!file.startsWith(`${dir}${path.sep}`)) continue;
        names.set(file.slice(dir.length + 1).split(path.sep)[0], true);
      }
      return [...names].map(([name, isDir]) => ({
        name,
        isDirectory: () => isDir,
        isFile: () => !isDir,
      }));
    },
    readFileSync(file) {
      if (unreadable.includes(file)) throw new Error(`EACCES: ${file}`);
      if (!(file in files)) throw new Error(`ENOENT: ${file}`);
      return files[file];
    },
  };
}

describe('walkSources', () => {
  it('collects .js and .md sources recursively', () => {
    const fsImpl = makeFsStub({
      [at('workflows', 'deliver.md')]: '',
      [at('scripts', 'a.js')]: '',
      [at('scripts', 'nested', 'b.mjs')]: '',
      [at('scripts', 'nested', 'c.cjs')]: '',
    });
    assert.deepEqual(
      walkSources(ROOT, fsImpl).sort(),
      [
        at('scripts', 'a.js'),
        at('scripts', 'nested', 'b.mjs'),
        at('scripts', 'nested', 'c.cjs'),
        at('workflows', 'deliver.md'),
      ].sort(),
    );
  });

  it('ignores files whose extension is not a source extension', () => {
    const fsImpl = makeFsStub({
      [at('data.json')]: '',
      [at('notes.txt')]: '',
      [at('real.js')]: '',
    });
    assert.deepEqual(walkSources(ROOT, fsImpl), [at('real.js')]);
  });

  it('skips node_modules, .worktrees, and .git* directories', () => {
    const fsImpl = makeFsStub({
      [at('node_modules', 'dep.js')]: '',
      [at('.worktrees', 'story-1', 'x.js')]: '',
      [at('.github', 'w.md')]: '',
      [at('kept.js')]: '',
    });
    assert.deepEqual(walkSources(ROOT, fsImpl), [at('kept.js')]);
  });

  it('returns an empty array when the root cannot be read', () => {
    assert.deepEqual(walkSources(at('missing'), makeFsStub({})), []);
  });
});

describe('scanFile', () => {
  const withWindow = (token) =>
    ['node .agents/scripts/single-story-init.js --story 1', token].join('\n');

  it('flags run_in_background: true near a story-init.js reference', () => {
    const offences = scanFile(
      at('workflows', 'x.md'),
      withWindow('Bash(run_in_background: true)'),
    );
    assert.equal(offences.length, 1);
    assert.equal(offences[0].line, 1);
    assert.match(offences[0].kind, /run_in_background/);
  });

  it('flags detached: true near a story-init.js reference', () => {
    const offences = scanFile(
      at('x.js'),
      withWindow('spawn(cmd, { detached: true })'),
    );
    assert.equal(offences.length, 1);
    assert.match(offences[0].kind, /detached/);
  });

  it('flags POSIX `&` backgrounding on the invocation line itself', () => {
    const offences = scanFile(
      at('x.md'),
      'node .agents/scripts/single-story-init.js --story 1 &',
    );
    assert.equal(offences.length, 1);
  });

  it('reports at most one offence per line even when two tokens match', () => {
    const offences = scanFile(
      at('x.md'),
      [
        'node single-story-init.js --story 1',
        'run_in_background: true',
        'detached: true',
      ].join('\n'),
    );
    assert.equal(offences.length, 1);
  });

  it('does not flag a story-init reference with no backgrounding token nearby', () => {
    assert.deepEqual(
      scanFile(at('x.md'), 'node single-story-init.js --story 1\nthen wait.'),
      [],
    );
  });

  it('does not flag a backgrounding token more than the window away', () => {
    const lines = ['node single-story-init.js --story 1'];
    for (let i = 0; i < 25; i += 1) lines.push(`filler ${i}`);
    lines.push('run_in_background: true');
    assert.deepEqual(scanFile(at('x.md'), lines.join('\n')), []);
  });

  it('reports one offence per referencing line', () => {
    const src = [
      'node single-story-init.js --story 1',
      'run_in_background: true',
      'node single-story-init.js --story 2',
    ].join('\n');
    assert.deepEqual(
      scanFile(at('x.md'), src).map((o) => o.line),
      [1, 3],
    );
  });

  for (const exempt of [
    'single-story-init.js',
    'story-init-not-backgrounded.js',
    'story-init-not-backgrounded.test.js',
    'parallel-tooling.md',
  ]) {
    it(`never flags ${exempt} (self-reference / documentation carve-out)`, () => {
      assert.deepEqual(
        scanFile(at(exempt), withWindow('run_in_background: true')),
        [],
      );
    });
  }
});

describe('check.detect', () => {
  it('returns null when the tree is clean', () => {
    const fsImpl = makeFsStub({
      [at('workflows', 'ok.md')]: 'node single-story-init.js --story 1\n',
    });
    assert.equal(check.detect({ scanRoot: ROOT }, fsImpl), null);
  });

  it('returns a blocker finding naming file, line, and token', () => {
    const fsImpl = makeFsStub({
      [at('workflows', 'bad.md')]:
        'node single-story-init.js --story 1\nrun_in_background: true\n',
    });
    const finding = check.detect({ scanRoot: ROOT }, fsImpl);
    assert.equal(finding.id, 'story-init-not-backgrounded');
    assert.equal(finding.severity, 'blocker');
    assert.equal(finding.autoCorrectable, false);
    assert.equal(finding.scope, 'story-close');
    assert.match(finding.summary, /1 orchestration call site/);
    assert.match(finding.detail, /workflows\/bad\.md:1/);
    assert.match(finding.fixCommand, /timeout: 600000/);
  });

  it('honours an explicit scope in the state', () => {
    const fsImpl = makeFsStub({
      [at('bad.md')]:
        'node single-story-init.js --story 1\nrun_in_background: true\n',
    });
    assert.equal(
      check.detect({ scanRoot: ROOT, scope: 'retro' }, fsImpl).scope,
      'retro',
    );
  });

  it('skips files that never mention story-init.js without scanning them', () => {
    const fsImpl = makeFsStub({
      [at('unrelated.md')]: 'run_in_background: true\n',
    });
    assert.equal(check.detect({ scanRoot: ROOT }, fsImpl), null);
  });

  it('skips an unreadable file rather than failing the whole check', () => {
    const fsImpl = makeFsStub(
      {
        [at('unreadable.md')]:
          'node single-story-init.js --story 1\nrun_in_background: true\n',
      },
      { unreadable: [at('unreadable.md')] },
    );
    assert.equal(check.detect({ scanRoot: ROOT }, fsImpl), null);
  });

  it('derives the scan root from state.cwd when no scanRoot is given', () => {
    const cwd = path.resolve(path.sep, 'repo');
    const fsImpl = makeFsStub({
      [at('bad.md')]:
        'node single-story-init.js --story 1\nrun_in_background: true\n',
    });
    assert.equal(check.detect({ cwd }, fsImpl).summary.startsWith('1 '), true);
  });

  it('declares the refuse-and-print contract the workflow relies on', () => {
    assert.equal(check.autoCorrect, 'refuse-and-print');
    assert.deepEqual(check.scope, ['story-close', 'retro']);
  });
});
