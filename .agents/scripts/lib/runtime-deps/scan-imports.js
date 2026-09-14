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
import { stripJsComments } from '../source-text/strip-js-comments.js';

/** Node builtins, with and without the `node:` prefix. */
const BUILTIN_MODULES = new Set([
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
// Names bound to a `createRequire(...)` result, e.g.
// `const fromReader = createRequire(x)`. Such a binding is a require function
// under a different name, so calls through it are real runtime imports that
// `CALL_FORM` cannot see — it matches the literal callees `require`/`import`.
// A module reached only that way would be an undeclared, unpreflighted
// dependency that this scanner reported as absent.
const REQUIRE_ALIAS =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createRequire\s*\(/g;

/**
 * Build a matcher for calls through `createRequire`-bound identifiers.
 *
 * Returns `null` when the source binds none, so the common case adds no pass.
 * Aliases named `require` need no entry — `CALL_FORM` already covers them.
 *
 * @param {string} cleaned Comment-stripped source.
 * @returns {RegExp|null}
 */
function aliasedRequireMatcher(cleaned) {
  REQUIRE_ALIAS.lastIndex = 0;
  const names = new Set();
  let m = REQUIRE_ALIAS.exec(cleaned);
  while (m !== null) {
    if (m[1] !== 'require') names.add(m[1]);
    m = REQUIRE_ALIAS.exec(cleaned);
  }
  if (names.size === 0) return null;
  const alternation = [...names]
    .map((n) => n.replace(/[$]/g, '\\$$'))
    .join('|');
  return new RegExp(`\\b(?:${alternation})\\s*\\(\\s*['"]([^'"]+)['"]`, 'g');
}

/**
 * The specifier patterns to run over one source: the three fixed forms, plus
 * an alias matcher when the source binds a `createRequire` result.
 *
 * @param {string} cleaned Comment-stripped source.
 * @returns {RegExp[]}
 */
function specifierMatchers(cleaned) {
  const aliased = aliasedRequireMatcher(cleaned);
  if (!aliased) return [STATIC_FROM, SIDE_EFFECT, CALL_FORM];
  return [STATIC_FROM, SIDE_EFFECT, CALL_FORM, aliased];
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
  const cleaned = stripJsComments(source);
  for (const re of specifierMatchers(cleaned)) {
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
