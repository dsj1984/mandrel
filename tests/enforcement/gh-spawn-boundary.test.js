/**
 * gh-spawn-boundary.test.js — every `gh` child Mandrel spawns goes through
 * `.agents/scripts/lib/gh-exec.js` (Story #5740).
 *
 * The gh boundary owns the gh environment: `exec()` and `runGh()` call
 * `ensureGhEnv()`, which points `GH_CONFIG_DIR` at `github.cliConfigDir`
 * before the first spawn. A module that spawns `gh` itself skips that and
 * silently talks to the default credential store — the doctor/bootstrap gap
 * #5693 left. This ratchet has no allowlist: a `'gh'` spawn target anywhere
 * in the shipped tree outside `gh-exec.js` fails it. Route the call through
 * `runGh(args, opts, runner)` (any `(file, args, opts)` runner fits) or
 * `exec()`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Shipped source roots. */
const SCAN_ROOTS = ['.agents/scripts', 'bin', 'lib'];

const SKIP_DIRS = new Set([
  '.git',
  '.worktrees',
  '__tests__',
  'coverage',
  'fixtures',
  'node_modules',
  'temp',
]);

/** The boundary itself — the one module allowed to name `gh` as a target. */
const BOUNDARY = '.agents/scripts/lib/gh-exec.js';

/**
 * `gh` as a spawn target: the first argument of any call — `spawnSync('gh',`,
 * `runner(\n  'gh',` — or a shell command string handed to an exec-family
 * call (`execSync('gh auth token')`).
 */
const GH_SPAWN_PATTERNS = [
  /\(\s*['"`]gh['"`]\s*,/,
  /\b(?:exec|spawn)\w*\(\s*['"`]gh\s/,
];

/**
 * Comments carry prose like "`spawnSync('gh', …)`"; only code counts. A
 * `//` preceded by `:` (a URL inside a string) is not a comment.
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/**
 * @param {string} source
 * @returns {boolean}
 */
function spawnsGhDirectly(source) {
  const code = stripComments(source);
  return GH_SPAWN_PATTERNS.some((re) => re.test(code));
}

/** @returns {string[]} repo-relative POSIX paths of shipped `.js` sources. */
function listSourceFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        entry.isFile() &&
        entry.name.endsWith('.js') &&
        !entry.name.endsWith('.test.js')
      ) {
        found.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  for (const scanRoot of SCAN_ROOTS) {
    const abs = path.join(root, scanRoot);
    if (fs.existsSync(abs)) walk(abs);
  }
  return found.sort();
}

describe('spawnsGhDirectly (the ratchet itself)', () => {
  it('flags a direct spawnSync of gh', () => {
    assert.equal(
      spawnsGhDirectly("const r = spawnSync('gh', ['auth', 'status']);"),
      true,
    );
  });

  it('flags a multi-line injected-runner call and an execSync command string', () => {
    assert.equal(spawnsGhDirectly("runner(\n  'gh',\n  args,\n);"), true);
    assert.equal(spawnsGhDirectly("execSync('gh auth token', opts);"), true);
  });

  it('passes a call routed through runGh, and prose in comments', () => {
    assert.equal(spawnsGhDirectly("runGh(['--version'], {}, runner);"), false);
    assert.equal(
      spawnsGhDirectly(
        "// was: spawnSync('gh', args)\n/** `execSync('gh auth token')` */\n",
      ),
      false,
    );
  });
});

describe('gh spawns across the shipped tree', () => {
  const files = listSourceFiles(REPO_ROOT);
  const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

  it('scans a non-trivial set of source files', () => {
    assert.ok(files.length > 100, `saw only ${files.length} files`);
  });

  it('the boundary module is the one that spawns gh', () => {
    assert.ok(spawnsGhDirectly(read(BOUNDARY)));
  });

  it('no module outside gh-exec.js spawns gh directly', () => {
    const offenders = files.filter(
      (file) => file !== BOUNDARY && spawnsGhDirectly(read(file)),
    );
    assert.deepEqual(
      offenders,
      [],
      `Direct gh spawn(s) outside ${BOUNDARY}:\n  ${offenders.join('\n  ')}\n` +
        '→ route them through runGh(args, opts, runner) or exec() from gh-exec.js,\n' +
        '  which applies github.cliConfigDir (GH_CONFIG_DIR) before the spawn.',
    );
  });
});
