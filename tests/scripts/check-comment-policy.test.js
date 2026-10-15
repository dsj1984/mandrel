// tests/scripts/check-comment-policy.test.js
//
// The comment policy ratchets: the literal-aware scanner, the provenance lint,
// the ratio ceiling, and the comment-only assertion against a git ref.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import {
  COMMENT_RATIO_CEILING,
  commentBytes,
  findProvenance,
  isScannedSource,
  normalizedCode,
  typeTags,
} from '../../scripts/lib/comment-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(
  __dirname,
  '..',
  '..',
  'scripts',
  'check-comment-policy.js',
);

/** Run git in `cwd`, failing the test on a non-zero exit. */
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/**
 * A committed fixture repository holding `files` (path → source), on `branch`
 * — `main` by default, so the base branch resolves to the fixture's own HEAD.
 */
function fixtureRepo(files, branch = 'main') {
  const root = makeTempDir('comment-policy-');
  git(root, 'init', '-q', '-b', branch);
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFiles(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--no-verify', '-m', 'base');
  return root;
}

/** Write `files` (path → source) under `root`. */
function writeFiles(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
}

/** Commit `files` on a new `feature` branch cut from the fixture's HEAD. */
function onBranch(root, files) {
  git(root, 'checkout', '-q', '-b', 'feature');
  writeFiles(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--no-verify', '-m', 'change');
}

/** The scanned surface's comment ratio in `root`'s working tree. */
function ratioOf(root) {
  let comment = 0;
  let total = 0;
  const dir = path.join(root, '.agents/scripts');
  for (const name of fs.readdirSync(dir)) {
    const counts = commentBytes(fs.readFileSync(path.join(dir, name), 'utf8'));
    comment += counts.comment;
    total += counts.total;
  }
  return comment / total;
}

/** A source whose comment share is `percent`% of its bytes, give or take 1.2 points. */
function atShare(percent) {
  return `${'// abcdefgh\n'.repeat(percent)}${'const v = 1234;\n'.repeat(75 - percent)}`;
}

const HEAVY = `${'// prose\n'.repeat(2000)}export const a = 1;\n`;
const LIGHT = 'export const x = 1;\n'.repeat(200);

/** Run the CLI against `root`. */
function runCli(root, ...args) {
  return spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
  });
}

describe('scanner', () => {
  it('does not treat comment openers inside string, template or regex literals as comments', () => {
    const src = [
      "const url = 'https://example.com/a'; // real",
      `const t = \`x \${a ? \`/* no */\` : "//no"} y\`;`,
      'const re = /\\/\\*[^/]*\\//g;',
      'const d = a / b / c; /* real block */',
    ].join('\n');
    assert.equal(
      commentBytes(src).comment,
      '// real'.length + '/* real block */'.length,
    );
  });

  it('counts comment bytes against total bytes', () => {
    assert.deepEqual(commentBytes('a; // xy'), { total: 8, comment: 5 });
  });

  it('scans JavaScript sources but not tests or generated files', () => {
    assert.equal(isScannedSource('.agents/scripts/lib/a.js'), true);
    assert.equal(isScannedSource('.agents/scripts/lib/__tests__/a.js'), false);
    assert.equal(isScannedSource('.agents/scripts/a.test.js'), false);
    assert.equal(isScannedSource('.agents/scripts/lib/generated/v.js'), false);
    assert.equal(isScannedSource('.agents/scripts/README.md'), false);
  });
});

describe('normalizedCode', () => {
  it('ignores comment edits and formatter reflow', () => {
    const before =
      'call(\n  a, // first\n  b,\n);\n/** Doc. */\nexport const x = 1;\n';
    const after = 'call(a, b);\nexport const x = 1;\n';
    assert.equal(normalizedCode(before), normalizedCode(after));
  });

  it('sees a change to code or to a string literal', () => {
    assert.notEqual(normalizedCode('f(a);'), normalizedCode('f(b);'));
    assert.notEqual(normalizedCode("f('a b');"), normalizedCode("f('a  b');"));
    assert.notEqual(normalizedCode('return x'), normalizedCode('returnx'));
  });

  it('treats deleting a tool directive as a code change', () => {
    for (const directive of [
      '// biome-ignore lint/x: why',
      '/* node:coverage ignore next */',
      '// cli-opt-out: bespoke guard',
    ]) {
      assert.notEqual(
        normalizedCode(`${directive}\nf();`),
        normalizedCode('f();'),
      );
    }
    assert.equal(normalizedCode('// prose\nf();'), normalizedCode('f();'));
  });
});

describe('findProvenance', () => {
  it('flags ticket, PR, Epic, ADR and bare issue citations in comments only', () => {
    const src = [
      '// Story #4866 filters provenance',
      '/* see PR #12 and Epic #3 */',
      '// ADR 20260917-5340',
      '// fixed in #5012',
      "const s = 'Story #1 in a string is fine';",
      '// a CSS colour #fff and a count of 3 are fine',
    ].join('\n');
    assert.deepEqual(
      findProvenance(src).map((h) => [h.line, h.match]),
      [
        [1, 'Story #4866'],
        [2, 'PR #12'],
        [3, 'ADR 20260917'],
        [4, '#5012'],
      ],
    );
  });
});

describe('typeTags', () => {
  it('keys @param and @typedef by name and the rest by tag', () => {
    const src =
      '/**\n * @param {string} a\n * @param {number} [b]\n * @returns {void}\n * @throws {Error}\n */';
    assert.deepEqual(typeTags(src), [
      '@param [b',
      '@param a',
      '@returns',
      '@throws',
    ]);
  });
});

describe('check-comment-policy CLI', () => {
  it('fails the provenance lint on a fixture that cites a Story', () => {
    const root = fixtureRepo({
      '.agents/scripts/a.js': 'export const a = 1;\n',
      'lib/b.js': '// Story #42 added this\nexport const b = 2;\n',
    });
    const r = runCli(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /lib\/b\.js:1 {2}Story #42/);
  });

  it('falls back to the absolute ceiling when no base ref resolves', () => {
    const over = fixtureRepo({ '.agents/scripts/a.js': HEAVY }, 'trunk');
    const r = runCli(over);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /no base ref resolved — applying the absolute ceiling/,
    );
    assert.match(r.stderr, /over the ceiling/);
    assert.ok(COMMENT_RATIO_CEILING < 0.9);

    const under = fixtureRepo({ '.agents/scripts/a.js': LIGHT }, 'trunk');
    const ok = runCli(under);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /ratio: .* — ok/);
  });

  it('passes at the base itself, warning when the global ratio is over', () => {
    const root = fixtureRepo({ '.agents/scripts/a.js': HEAVY });
    const r = runCli(root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /this change vs [0-9a-f]{9}: comment 0 of 0 bytes/);
    assert.match(r.stderr, /warn — the global ratio is over the ceiling/);
  });

  it('passes a change under the ceiling even when the base is over it', () => {
    const root = fixtureRepo({ '.agents/scripts/a.js': HEAVY });
    onBranch(root, { '.agents/scripts/b.js': LIGHT });
    const r = runCli(root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stdout,
      /this change vs [0-9a-f]{9}: comment 0 of \d+ bytes \(0\.0%\)/,
    );
  });

  it('passes a change under the ceiling whose base sits just under it', () => {
    const root = fixtureRepo({ '.agents/scripts/a.js': atShare(29) });
    assert.ok(ratioOf(root) <= COMMENT_RATIO_CEILING);
    onBranch(root, { '.agents/scripts/b.js': atShare(29) });
    const r = runCli(root);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(ratioOf(root) <= COMMENT_RATIO_CEILING);
  });

  it('fails a comment-heavy change once the global ratio is over, naming the bytes to trim', () => {
    const root = fixtureRepo({ '.agents/scripts/a.js': atShare(29) });
    onBranch(root, { '.agents/scripts/b.js': HEAVY });
    const r = runCli(root);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /this change is above it\. Trim at least \d+ comment bytes from this change's own diff/,
    );
  });

  it('never fails a change that only deletes code', () => {
    const root = fixtureRepo({
      '.agents/scripts/a.js': atShare(34),
      '.agents/scripts/b.js': LIGHT,
    });
    assert.ok(ratioOf(root) <= COMMENT_RATIO_CEILING);
    git(root, 'checkout', '-q', '-b', 'feature');
    git(root, 'rm', '-q', '.agents/scripts/b.js');
    git(root, 'commit', '-q', '--no-verify', '-m', 'drop b');
    assert.ok(ratioOf(root) > COMMENT_RATIO_CEILING);
    const r = runCli(root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /warn — the global ratio is over the ceiling/);
  });

  it('judges the change against --base when one is given', () => {
    const root = fixtureRepo({ '.agents/scripts/a.js': atShare(29) });
    onBranch(root, { '.agents/scripts/b.js': HEAVY });
    assert.equal(runCli(root).status, 1);
    const r = runCli(root, '--base', 'HEAD');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /comment 0 of 0 bytes/);
  });

  it('passes the code-unchanged assertion on a comment-only edit', () => {
    const root = fixtureRepo({
      '.agents/scripts/a.js':
        '/**\n * Long history.\n * @param {string} x\n */\nexport function f(x) {\n  return x; // why\n}\n',
    });
    writeFiles(root, {
      '.agents/scripts/a.js':
        '/** @param {string} x */\nexport function f(x) {\n  return x;\n}\n',
    });
    const r = runCli(root, '--assert-code-unchanged', 'HEAD');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 changed file\(s\)/);
  });

  it('fails the assertion on a code change or a lost JSDoc tag', () => {
    const root = fixtureRepo({
      '.agents/scripts/a.js':
        '/** @param {string} x */\nexport function f(x) {\n  return x;\n}\n',
      '.agents/scripts/b.js':
        '/** @returns {number} */\nexport const g = () => 1;\n',
    });
    writeFiles(root, {
      '.agents/scripts/a.js':
        '/** @param {string} x */\nexport function f(x) {\n  return x + 1;\n}\n',
      '.agents/scripts/b.js': 'export const g = () => 1;\n',
    });
    const r = runCli(root, '--assert-code-unchanged', 'HEAD');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /a\.js: code changed outside comments/);
    assert.match(r.stderr, /b\.js: lost JSDoc tag\(s\) @returns/);
  });
});
