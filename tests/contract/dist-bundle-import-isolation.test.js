/**
 * dist-bundle-import-isolation.test.js — Story #2572.
 *
 * Acceptance:
 *   - Only `.agents/` is distributed to consumers via the `dist` branch.
 *     Any `.agents/scripts/**` file that imports a relative path which
 *     resolves outside `.agents/` will fail at module-load time on a
 *     consumer's checkout (the import target is not part of the bundle).
 *
 * This test walks every `.js` file under `.agents/scripts/`, parses its
 * static ESM imports, resolves every relative specifier against the
 * importer's directory, and fails if any resolution escapes the
 * `.agents/` boundary. Package imports (`node:*`, bare specifiers) are
 * ignored — only relative `./` and `../` specifiers can violate the
 * bundle boundary.
 *
 * Regression seed: prior to Story #2572 the refresh-service module lived
 * at `lib/baselines/refresh-service.js` (repo root, outside `.agents/`)
 * and was imported by three `.agents/scripts/**` files. Consumers
 * tracking `branch=dist` could not resolve those imports.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLE_ROOT = path.join(REPO_ROOT, '.agents');

const SKIP_DIR_NAMES = Object.freeze(
  new Set(['node_modules', '.git', '.worktrees', 'temp']),
);

function listJsFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (SKIP_DIR_NAMES.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...listJsFiles(abs));
    } else if (ent.isFile() && abs.endsWith('.js')) {
      out.push(abs);
    }
  }
  return out;
}

// Match static ESM imports + dynamic import() calls with a string literal.
// Ignores import statements inside `/* … */` or `// …` since those don't
// trigger module resolution.
const IMPORT_RE =
  /(?:^|\n)\s*(?:import\b[^'";]*?from\s*|import\s*|export\b[^'";]*?from\s*)['"]([^'"\n]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;

function extractRelativeImports(source) {
  const specifiers = new Set();
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1];
    if (spec.startsWith('./') || spec.startsWith('../')) {
      specifiers.add(spec);
    }
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT_RE)) {
    const spec = match[1];
    if (spec.startsWith('./') || spec.startsWith('../')) {
      specifiers.add(spec);
    }
  }
  return [...specifiers];
}

describe('dist bundle import isolation (Story #2572)', () => {
  it('AC: every relative import in .agents/scripts resolves inside .agents/', () => {
    assert.ok(
      statSync(BUNDLE_ROOT).isDirectory(),
      '.agents/ bundle root must exist',
    );

    const offenders = [];
    const files = listJsFiles(path.join(BUNDLE_ROOT, 'scripts'));

    for (const abs of files) {
      const source = readFileSync(abs, 'utf8');
      const specifiers = extractRelativeImports(source);
      for (const spec of specifiers) {
        const resolved = path.resolve(path.dirname(abs), spec);
        const relToBundle = path.relative(BUNDLE_ROOT, resolved);
        // path.relative returns "..foo" or "..\\foo" when `resolved` is
        // outside BUNDLE_ROOT. An empty string means the resolution lands
        // exactly on BUNDLE_ROOT (also fine; the bundle root is a valid
        // target). Anything beginning with ".." escapes the bundle.
        if (relToBundle.startsWith('..')) {
          offenders.push({
            file: path.relative(REPO_ROOT, abs).replace(/\\/g, '/'),
            specifier: spec,
            resolved: path.relative(REPO_ROOT, resolved).replace(/\\/g, '/'),
          });
        }
      }
    }

    if (offenders.length > 0) {
      const summary = offenders
        .map(
          ({ file, specifier, resolved }) =>
            `\n  ${file}\n    imports '${specifier}'\n    → resolves to '${resolved}' (outside .agents/)`,
        )
        .join('');
      assert.fail(
        `Found ${offenders.length} import(s) inside .agents/scripts that resolve outside the bundle. ` +
          `Consumers tracking branch=dist cannot resolve these — the import targets are not distributed. ` +
          `Move the target inside .agents/ or refactor the importer.${summary}`,
      );
    }
  });

  it('AC: refresh-service.js lives inside the .agents/ bundle', () => {
    const expectedPath = path.join(
      BUNDLE_ROOT,
      'scripts',
      'lib',
      'baselines',
      'refresh-service.js',
    );
    assert.ok(
      statSync(expectedPath).isFile(),
      'refresh-service.js must live under .agents/scripts/lib/baselines/ so it ships via dist',
    );
  });

  it('AC: canonicalize-path.js lives inside the .agents/ bundle', () => {
    const expectedPath = path.join(
      BUNDLE_ROOT,
      'scripts',
      'lib',
      'baselines',
      'canonicalize-path.js',
    );
    assert.ok(
      statSync(expectedPath).isFile(),
      'canonicalize-path.js must live under .agents/scripts/lib/baselines/ so it ships via dist',
    );
  });
});
