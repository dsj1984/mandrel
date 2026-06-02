/**
 * runtime-deps/scan-imports — extract third-party package imports from source.
 *
 * Powers the import-vs-manifest drift test (Story #3432): it walks
 * `.agents/scripts/**` and reports every third-party (non-builtin,
 * non-relative) top-level package the framework imports, so the test can
 * assert each one is declared in `.agents/runtime-deps.json`.
 *
 * Robustness is the whole game here. A naive `from ['"]...['"]` regex also
 * matches prose inside strings and comments (e.g. a log line containing the
 * word "from 'x'"), which would invent phantom dependencies. Two guards
 * prevent that:
 *
 *   1. Static `import` / `export … from` matches are anchored to the start
 *      of a line — a real import statement begins the line; prose inside a
 *      template literal does not.
 *   2. Every extracted specifier's *top-level* package name is validated
 *      against the npm package-name grammar. Names with spaces, uppercase,
 *      or stray punctuation (i.e. accidental prose captures) are rejected.
 *
 * Node builtins (`node:fs`, `path`, …) and relative/absolute specifiers are
 * excluded. Subpath specifiers (`ajv/dist/2020.js`, `@scope/pkg/sub`) are
 * collapsed to their installable top-level name (`ajv`, `@scope/pkg`).
 */

import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

/** Node builtins, with and without the `node:` prefix. */
export const BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

/**
 * npm package-name grammar (top-level, optionally scoped). Lowercase,
 * digits, and a small punctuation set only — deliberately strict so that
 * accidental prose captures are rejected.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/**
 * Collapse an import specifier to its installable top-level package name.
 * `@scope/pkg/sub` → `@scope/pkg`; `pkg/sub` → `pkg`.
 *
 * @param {string} specifier
 * @returns {string}
 */
export function toTopLevelPackage(specifier) {
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) return segments.slice(0, 2).join('/');
  return segments[0];
}

/**
 * True when `name` is a syntactically valid npm package name.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isValidPackageName(name) {
  return typeof name === 'string' && PACKAGE_NAME.test(name);
}

// Anchored static import / re-export: the statement must start the line.
const STATIC_FROM =
  /^\s*(?:import|export)\b[^\n;]*?\bfrom\s*['"]([^'"]+)['"]/gm;
// Anchored side-effect import at line start.
const SIDE_EFFECT = /^\s*import\s*['"]([^'"]+)['"]/gm;
// `require(...)` and dynamic `import(...)` may appear mid-expression.
const CALL_FORM = /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]/g;

/**
 * Remove `//` line comments and block comments while preserving string and
 * template literals (which carry the import specifiers we extract). A
 * char-by-char state machine is used rather than a regex so that comment
 * markers inside string literals (e.g. a `https://` URL) are not mistaken
 * for comments, and example import syntax inside *comments* (e.g. a
 * `// require('x')` doc line) does not register as a phantom dependency.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    // Enter a string / template literal — copy verbatim until it closes.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        const c = source[i];
        out += c;
        if (c === '\\') {
          // Copy the escaped char too, then continue.
          if (i + 1 < n) out += source[i + 1];
          i += 2;
          continue;
        }
        i += 1;
        if (c === quote) break;
      }
      continue;
    }
    // Line comment — drop to end of line (keep the newline).
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    // Block comment — drop until the closing `*/`.
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Extract the set of third-party top-level package names imported by a
 * single source string.
 *
 * @param {string} source
 * @returns {Set<string>}
 */
export function extractThirdPartyImports(source) {
  const found = new Set();
  const cleaned = stripComments(source);
  for (const re of [STATIC_FROM, SIDE_EFFECT, CALL_FORM]) {
    re.lastIndex = 0;
    let match = re.exec(cleaned);
    while (match !== null) {
      const specifier = match[1];
      // Advance the iterator up front so every `continue` below is safe.
      match = re.exec(cleaned);
      if (
        specifier.startsWith('.') ||
        specifier.startsWith('/') ||
        specifier.startsWith('node:') ||
        specifier.startsWith('#')
      ) {
        continue;
      }
      const top = toTopLevelPackage(specifier);
      if (!isValidPackageName(top)) continue;
      if (BUILTIN_MODULES.has(top)) continue;
      found.add(top);
    }
  }
  return found;
}

/**
 * Recursively collect every `.js` file under `dir`.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scan every `.js` file under `dir` and map each third-party top-level
 * package to the (relative) files that import it.
 *
 * @param {string} dir — directory root to scan (e.g. `.agents/scripts`).
 * @returns {{ packages: Set<string>, byPackage: Map<string, string[]> }}
 */
export function scanThirdPartyImports(dir) {
  const byPackage = new Map();
  for (const file of listJsFiles(dir)) {
    const source = fs.readFileSync(file, 'utf8');
    const rel = path.relative(dir, file);
    for (const pkg of extractThirdPartyImports(source)) {
      const files = byPackage.get(pkg) ?? [];
      files.push(rel);
      byPackage.set(pkg, files);
    }
  }
  return { packages: new Set(byPackage.keys()), byPackage };
}
