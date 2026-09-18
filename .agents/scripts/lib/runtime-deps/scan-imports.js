/**
 * runtime-deps/scan-imports — extract third-party top-level package imports
 * from source, for the import-vs-manifest drift test. To avoid inventing
 * phantom deps from prose, comments are stripped, static imports must start
 * a line, and every name must match the npm package-name grammar. Subpaths
 * collapse to their installable name.
 */

import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { stripJsComments } from '../source-text/strip-js-comments.js';

const BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

// Deliberately strict so accidental prose captures are rejected.
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/**
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
 * @param {string} name
 * @returns {boolean}
 */
export function isValidPackageName(name) {
  return typeof name === 'string' && PACKAGE_NAME.test(name);
}

const STATIC_FROM =
  /^\s*(?:import|export)\b[^\n;]*?\bfrom\s*['"]([^'"]+)['"]/gm;
const SIDE_EFFECT = /^\s*import\s*['"]([^'"]+)['"]/gm;
// `require(...)` and dynamic `import(...)` may appear mid-expression.
const CALL_FORM = /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]/g;
// A `createRequire(...)` binding is a require under another name; calls
// through it are real imports CALL_FORM cannot see.
const REQUIRE_ALIAS =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createRequire\s*\(/g;

/**
 * `null` when the source binds no alias (aliases named `require` are already
 * covered).
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
 * @param {string} cleaned Comment-stripped source.
 * @returns {RegExp[]}
 */
function specifierMatchers(cleaned) {
  const aliased = aliasedRequireMatcher(cleaned);
  if (!aliased) return [STATIC_FROM, SIDE_EFFECT, CALL_FORM];
  return [STATIC_FROM, SIDE_EFFECT, CALL_FORM, aliased];
}

/**
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
      // Advance first so every `continue` below is safe.
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
