#!/usr/bin/env node

/**
 * Test-portability guard (Story #5284).
 *
 * Windows-only breaks reached `main` three times in one week through two
 * source shapes a static reader can see, because the `windows-smoke` job is
 * advisory: it is not a required check, so auto-merge lands a PR whose only
 * red is that leg. Making the leg required is an operator ruleset decision;
 * catching the shapes at authoring time is not, and that is what this guard
 * does.
 *
 * Three shapes, all invisible on POSIX and all fatal on Windows:
 *
 *   1. **A `RegExp` built from an interpolated path.** `new RegExp(`source:
 *      ${src}`)` is accidentally literal on POSIX — a temp path carries no
 *      regex metacharacters. On Windows every separator is a backslash, so
 *      `C:\Users\…` compiles to a pattern matching `C:Users…` and the
 *      assertion can never match (PR #5276 fixed three of these).
 *
 *   2. **A dynamic `import()` of a plain filesystem path.** An absolute
 *      Windows path is not a valid ESM specifier: the drive letter reads as
 *      a URL scheme. The portable form is `pathToFileURL(p).href`, which is
 *      why the suite's own dynamic imports launder through it.
 *
 *   3. **A file URL's `.pathname` read as a filesystem path.** `new
 *      URL(import.meta.url).pathname` yields `/D:/a/repo` on Windows, and the
 *      leading slash survives `path.resolve` as a second drive letter, so the
 *      test dies on `D:\D:\a\repo\package.json`. `fileURLToPath` is the one
 *      spelling that round-trips on both platforms. This shape reached `main`
 *      the same day this guard did, through a test the guard did not yet read.
 *
 * ## What is deliberately NOT flagged
 *
 * Interpolating into a `RegExp` is not itself the defect — the suite does it
 * constantly with heading text, flag names and label ids, and flagging those
 * would make the guard noise. Only an interpolation whose *expression text*
 * names a filesystem path counts (see {@link PATH_EXPRESSION}).
 *
 * The import rule is the same shape, and for the same reason. It fires on a
 * path expression reaching `import()` unlaundered — not on "anything that is
 * not a relative specifier". The suite's dynamic imports are overwhelmingly
 * `import(SUT_URL)` and `` import(`${SUT_URL}?t=${tag}`) ``, where the URL was
 * laundered once at module scope and the interpolation is a cache-busting
 * query; those carry no path expression and are silent here, while
 * `import(path.join(LIB, 'x.js'))` is exactly what reds.
 *
 * An interpolation that escapes itself for a regex — `.replace(/\\/g, …)`,
 * `escapeRegExp(…)` — is laundered and not reported either.
 *
 * A line (or the line above it) carrying `portability-allow` opts out.
 *
 * Scope is `tests/**` plus `.agents/scripts/ ** /__tests__/**` by default.
 * Unlike `check-test-temp-hygiene.js`'s raw-tmpdir lint this is not scoped to
 * caller-passed globs: it runs over this repository's own tree in CI and
 * ships in the payload for a consumer to wire up the same way.
 *
 * Exit codes: 1 when any finding is reported, 0 otherwise.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAsCli } from './lib/cli-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Directories that are never test source, skipped wholesale during the walk. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.worktrees',
  '.git',
  'temp',
  'coverage',
]);

/** Repo-relative directory prefixes scanned for test sources. */
const SCAN_ROOTS = ['tests', '.agents/scripts'];

/** Opt-out marker, honoured on the finding's line or the line above it. */
const LINT_ESCAPE = 'portability-allow';

/**
 * Expression text that names a filesystem path.
 *
 * Two families, kept separate because they fail differently. The call family
 * is unambiguous — nothing but a path comes out of `path.join()`. The name
 * family is a heuristic over identifiers, so it is anchored to the *final*
 * segment of a member expression and deliberately excludes `…Path`: the
 * suite uses that suffix for non-filesystem discriminators too (an
 * `evidencePath` of `'per-run'`), and a guard that reds on those would be
 * turned off rather than obeyed. `…Dir` / `…Root` / `src` / `dest` carry no
 * such second meaning here.
 */
const PATH_EXPRESSION =
  /(?:\b(?:path\.(?:join|resolve|dirname|relative|normalize)|os\.tmpdir|process\.cwd|fileURLToPath|makeTempDir|mkdtemp(?:Sync)?)\s*\(|\b__(?:dirname|filename)\b|(?:^|[^\w$.])(?:src|dst|dest|dir|cwd|tmpdir|workCwd|repoRoot)\b|[\w$]+(?:Dir|Root|Cwd|Tmpdir)\b)/;

/**
 * An argument already laundered into a URL, in any of the three shapes the
 * suite uses.
 */
const URL_LAUNDERED =
  /\bpathToFileURL\s*\(|\bnew\s+URL\s*\(|\bimport\.meta\.url\b/;

/**
 * An interpolation that escapes itself before reaching the pattern. The
 * separator problem is solved once the backslashes are doubled, so escaping a
 * path in is a correct use, not the defect.
 */
const REGEX_ESCAPED =
  /\.replace(?:All)?\s*\(|\bescapeReg(?:Exp|ex)\b|\bregexEscape\b/;

/**
 * A **file** URL's `.pathname` read as though it were a filesystem path.
 *
 * Scoped to URLs built from a file source (`import.meta.url`, `pathToFileURL`,
 * a `file://` literal) because `.pathname` on an http URL is a correct read
 * with no filesystem meaning. On Windows the property yields `/D:/a/repo`,
 * whose leading slash survives `path.resolve` as a second drive letter —
 * `D:\D:\a\repo` — so the failure is an ENOENT naming an impossible path
 * rather than anything that points at the real defect.
 */
const FILE_URL_PATHNAME =
  /\bnew\s+URL\s*\([^()]*(?:import\.meta\.url|pathToFileURL|file:\/\/)[^()]*\)\s*\.pathname/g;

/**
 * Blank out comments while preserving every byte offset and newline, so a
 * finding's line number survives and the scan cannot be satisfied — or
 * tripped — by prose.
 *
 * String and template literals are left intact on purpose: the suite builds
 * child-process source inside template literals, and the `await import(...)`
 * in one of those is real code that runs on Windows like any other.
 *
 * Regex literals are not tracked. A `//` inside one would be read as a
 * comment start; the shapes this guard matches do not occur inside regex
 * literals, so the trade is a simpler scanner for no measured loss.
 *
 * @param {string} src
 * @returns {string} `src` with comment bodies replaced by spaces
 */
function blankComments(src) {
  const out = src.split('');
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipStringLiteral(src, i);
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * Index just past the string literal opening at `start`.
 *
 * @param {string} src
 * @param {number} start index of the opening quote
 * @returns {number}
 */
function skipStringLiteral(src, start) {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (quote !== '`' && ch === '\n') return i;
    i += 1;
  }
  return i;
}

/**
 * Blank the contents of quoted string literals in `text`, leaving template
 * literals alone.
 *
 * A specifier's own characters are not a path expression: without this,
 * `import('../lib/auto-merge-cwd.js')` matches the `cwd` name signal on a
 * filename. Template literals are left intact because their `${…}` bodies are
 * exactly what both rules need to read.
 *
 * @param {string} text
 * @returns {string}
 */
function blankStrings(text) {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      i = skipStringLiteral(text, i);
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = skipStringLiteral(text, i);
      for (let k = i + 1; k < end - 1; k += 1) out[k] = ' ';
      i = end;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * Capture the text between the parenthesis at `open` and its match.
 *
 * Balanced rather than line-based because both shapes span lines in practice
 * — a `pathToFileURL(path.resolve(…)).href` argument runs to six.
 *
 * @param {string} src
 * @param {number} open index of the opening `(`
 * @returns {string|null} the argument text, or `null` when unbalanced
 */
function captureArgs(src, open) {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipStringLiteral(src, i);
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
    i += 1;
  }
  return null;
}

/**
 * Every `${…}` substitution body in `text`, at one level of nesting.
 *
 * @param {string} text
 * @returns {string[]}
 */
function substitutions(text) {
  const found = [];
  for (let i = 0; i < text.length - 1; i += 1) {
    if (text[i] !== '$' || text[i + 1] !== '{') continue;
    let depth = 0;
    for (let k = i + 1; k < text.length; k += 1) {
      if (text[k] === '{') depth += 1;
      else if (text[k] === '}') {
        depth -= 1;
        if (depth === 0) {
          found.push(text.slice(i + 2, k));
          i = k;
          break;
        }
      }
    }
  }
  return found;
}

/**
 * Line number (1-based) of `index` within `src`.
 *
 * @param {string} src
 * @param {number} index
 * @returns {number}
 */
function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i += 1) {
    if (src[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Whether the finding at `line` (1-based) is opted out by a marker on that
 * line or the one above it.
 *
 * @param {string[]} lines original source lines
 * @param {number} line
 * @returns {boolean}
 */
function isSuppressed(lines, line) {
  const here = lines[line - 1] ?? '';
  const above = line >= 2 ? (lines[line - 2] ?? '') : '';
  return here.includes(LINT_ESCAPE) || above.includes(LINT_ESCAPE);
}

/**
 * Scan one file's source for both shapes.
 *
 * @param {string} rel repo-relative POSIX path, used in the report
 * @param {string} source raw file contents
 * @returns {{ file: string, line: number, shape: string, text: string }[]}
 */
function scanSource(rel, source) {
  const src = blankComments(source);
  const lines = source.split('\n');
  const findings = [];
  const add = (index, shape, detail) => {
    const line = lineOf(src, index);
    if (isSuppressed(lines, line)) return;
    findings.push({ file: rel, line, shape, text: detail });
  };

  for (const m of src.matchAll(/\bnew\s+RegExp\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const args = captureArgs(src, open);
    if (args === null) continue;
    const offender = substitutions(args).find(
      (sub) =>
        PATH_EXPRESSION.test(blankStrings(sub)) && !REGEX_ESCAPED.test(sub),
    );
    if (offender !== undefined) {
      add(m.index, 'regexp-from-path', `\${${offender.trim()}}`);
    }
  }

  for (const m of src.matchAll(FILE_URL_PATHNAME)) {
    add(m.index, 'url-pathname-as-path', m[0].trim().replace(/\s+/g, ' '));
  }

  for (const m of src.matchAll(/(?<![\w$.])import\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const args = captureArgs(src, open);
    if (args === null) continue;
    if (PATH_EXPRESSION.test(blankStrings(args)) && !URL_LAUNDERED.test(args)) {
      add(m.index, 'import-raw-path', args.trim().replace(/\s+/g, ' '));
    }
  }

  return findings;
}

/**
 * Is `rel` a test source this guard scans?
 *
 * @param {string} rel repo-relative POSIX path
 * @returns {boolean}
 */
function isTestSource(rel) {
  if (!/\.(?:js|mjs|cjs)$/.test(rel)) return false;
  if (rel.startsWith('tests/')) return true;
  return rel.startsWith('.agents/scripts/') && rel.includes('/__tests__/');
}

/**
 * Walk `root` for scannable test sources, POSIX-relative and sorted.
 *
 * @param {string} root
 * @param {typeof fs} fsImpl
 * @returns {string[]}
 */
function listTestSources(root, fsImpl) {
  const out = [];
  const walk = (dir, prefix) => {
    if (!fsImpl.existsSync(dir)) return;
    for (const ent of fsImpl.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), rel);
      else if (ent.isFile() && isTestSource(rel)) out.push(rel);
    }
  };
  for (const scanRoot of SCAN_ROOTS) {
    walk(path.join(root, scanRoot), scanRoot);
  }
  return out.sort();
}

/**
 * Collect every finding under `root`.
 *
 * @param {string} root repository root to scan
 * @param {{ fsImpl?: typeof fs }} [deps]
 * @returns {{ file: string, line: number, shape: string, text: string }[]}
 */
function findPortabilityIssues(root, { fsImpl = fs } = {}) {
  const findings = [];
  for (const rel of listTestSources(root, fsImpl)) {
    const source = fsImpl.readFileSync(path.join(root, rel), 'utf8');
    findings.push(...scanSource(rel, source));
  }
  return findings;
}

/** Remedy line printed under each shape, keyed by the shape's id. */
const REMEDIES = Object.freeze({
  'regexp-from-path':
    'a path interpolated into a RegExp is literal on POSIX and escaped on Windows — assert with `includes()`, or escape the interpolation.',
  'import-raw-path':
    'a filesystem path is not a valid ESM specifier on Windows — import `pathToFileURL(p).href`.',
  'url-pathname-as-path':
    "a file URL's `.pathname` is a URL path, not a filesystem path: on Windows it reads `/D:/…`, and resolving it yields `D:\\D:\\…` — use `fileURLToPath(url)`.",
});

/**
 * Parse argv into normalised options.
 *
 * @param {string[]} argv
 * @returns {{ root: string, json: boolean }}
 */
function parseArgv(argv) {
  let root = REPO_ROOT;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') json = true;
    else if (argv[i] === '--root') {
      i += 1;
      root = path.resolve(String(argv[i] ?? '.'));
    }
  }
  return { root, json };
}

/**
 * Execute the guard and return the process exit code.
 *
 * @param {{ root: string, json: boolean }} opts
 * @param {(line: string) => void} [log]
 * @param {{ fsImpl?: typeof fs }} [deps]
 * @returns {number}
 */
function runPortability(
  opts,
  log = (l) => process.stdout.write(`${l}\n`),
  deps,
) {
  const findings = findPortabilityIssues(opts.root, deps);
  if (opts.json) {
    log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2));
    return findings.length === 0 ? 0 : 1;
  }
  if (findings.length === 0) {
    log(
      '[test-portability] OK — no path-derived RegExp or raw-path dynamic import in test sources.',
    );
    return 0;
  }
  log(
    `[test-portability] FAIL — ${findings.length} Windows-hostile shape(s) in test sources:`,
  );
  for (const f of findings) {
    log(`  ${f.file}:${f.line}  [${f.shape}]  ${f.text}`);
  }
  for (const shape of new Set(findings.map((f) => f.shape))) {
    log(`[test-portability] ${shape}: ${REMEDIES[shape]}`);
  }
  log(
    `[test-portability] the windows-smoke job is advisory, so these land on main unnoticed. Mark a deliberate exception with '${LINT_ESCAPE}: <reason>' on the line or the line above.`,
  );
  return 1;
}

runAsCli(
  import.meta.url,
  async () => runPortability(parseArgv(process.argv.slice(2))),
  {
    source: 'check-test-portability',
    propagateExitCode: true,
    usage: {
      invocation:
        'node .agents/scripts/check-test-portability.js [--json] [--root <dir>]',
      summary:
        'Static guard for the two Windows-only shapes that reach main through the advisory windows-smoke job: a RegExp built from an interpolated filesystem path, and a dynamic import() of a raw path instead of a pathToFileURL href.',
      flags: [
        [
          '--json',
          'Emit { ok, findings[] } as JSON instead of the text report.',
        ],
        ['--root <dir>', 'Repository root to scan (default: this repo root).'],
      ],
      notes: [
        "A line (or the line above it) carrying 'portability-allow' opts out.",
        'Scope: tests/** plus .agents/scripts/**/__tests__/**.',
        'Exit codes:\n  0  clean\n  1  at least one finding',
      ],
    },
  },
);
