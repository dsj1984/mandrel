/**
 * detect-stack.js — Consumer stack detection for `mandrel init`
 *
 * Inspects a consumer repository root and reports the package manager,
 * test runner, and primary language it can infer from on-disk signals
 * (lockfiles, `package.json` contents, and source-file extensions). The
 * `mandrel init` configure-path tail (Feature #3514, Story #4045) uses
 * this to tell the operator what it found before scaffolding missing
 * `docsContextFiles`.
 *
 * The detection functions are seam-injectable: each takes an injected
 * filesystem facade (`exists` / `readFile` / `listExtensions`) so they
 * are unit-testable in isolation against an in-memory fixture, mirroring
 * the style of `lib/runtime-deps/preflight.js#detectPackageManager`. The
 * default facade reads the real filesystem so callers can point it at a
 * sample-repo fixture directory.
 *
 * Story #3520 (refs #3520).
 */

import fs from 'node:fs';
import path from 'node:path';
import { detectPackageManager as detectPm } from '../detect-package-manager.js';

/**
 * Filesystem facade. Pure detection logic talks to disk only through
 * this seam so tests can drive it with an in-memory fixture.
 *
 * @typedef {object} FsFacade
 * @property {(p: string) => boolean} exists - Path existence probe.
 * @property {(p: string) => string|null} readFile - UTF-8 read; null when absent/unreadable.
 * @property {(root: string) => string[]} listExtensions - Lowercased source-file extensions (with leading dot) found under root.
 */

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.rb',
  '.java',
  '.kt',
  '.php',
  '.cs',
  '.swift',
]);

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  'vendor',
  'target',
  '__pycache__',
  '.venv',
  'venv',
]);

/**
 * Map a source-file extension to a primary-language label.
 *
 * @param {string} ext - Lowercased extension including the leading dot.
 * @returns {string|null} Language label, or null when the extension is not a recognized source type.
 */
function extensionToLanguage(ext) {
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.py':
      return 'python';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.rb':
      return 'ruby';
    case '.java':
      return 'java';
    case '.kt':
      return 'kotlin';
    case '.php':
      return 'php';
    case '.cs':
      return 'csharp';
    case '.swift':
      return 'swift';
    default:
      return null;
  }
}

/**
 * Recursively collect lowercased source-file extensions under `root`,
 * skipping vendored / build / VCS directories. Used by the default
 * filesystem facade; tests inject their own `listExtensions`.
 *
 * @param {string} root - Absolute repository root.
 * @returns {string[]} Extensions (with leading dot, possibly repeated) in traversal order.
 */
function listExtensionsOnDisk(root) {
  /** @type {string[]} */
  const extensions = [];
  /** @type {string[]} */
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        stack.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext) extensions.push(ext);
      }
    }
  }

  return extensions;
}

/**
 * Default filesystem facade backed by `node:fs`. Reads the real disk so
 * callers can point detection at a sample-repo fixture directory.
 *
 * @type {FsFacade}
 */
export const defaultFsFacade = {
  exists: (p) => fs.existsSync(p),
  readFile: (p) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  listExtensions: (root) => listExtensionsOnDisk(root),
};

/**
 * Detect the package manager from lockfile presence. Defaults to `npm`
 * when no lockfile is found but a `package.json` exists, and `null` when
 * the repo has no Node manifest at all.
 *
 * Delegates to the shared `detectPackageManager` helper
 * (Story #4048 B3 — one implementation per concept). The `fsFacade.exists`
 * seam is forwarded directly.
 *
 * @param {string} root - Repository root.
 * @param {FsFacade} [fsFacade=defaultFsFacade]
 * @returns {'pnpm'|'yarn'|'bun'|'npm'|null}
 */
export function detectPackageManager(root, fsFacade = defaultFsFacade) {
  return detectPm(root, fsFacade.exists);
}

/**
 * Parse `package.json` into an object, returning `null` when it is
 * absent or unparseable.
 *
 * @param {string} root - Repository root.
 * @param {FsFacade} fsFacade
 * @returns {Record<string, unknown>|null}
 */
function readPackageJson(root, fsFacade) {
  const raw = fsFacade.readFile(path.join(root, 'package.json'));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Detect the test runner from `package.json` dependency declarations and
 * the `test` script. Recognizes vitest, jest, mocha, ava, and the
 * Node.js built-in test runner (`node --test`). Returns `null` when no
 * runner can be inferred.
 *
 * @param {string} root - Repository root.
 * @param {FsFacade} [fsFacade=defaultFsFacade]
 * @returns {'vitest'|'jest'|'mocha'|'ava'|'node-test'|null}
 */
export function detectTestRunner(root, fsFacade = defaultFsFacade) {
  const pkg = readPackageJson(root, fsFacade);
  if (!pkg) return null;

  const deps = {
    .../** @type {Record<string, unknown>} */ (pkg.dependencies ?? {}),
    .../** @type {Record<string, unknown>} */ (pkg.devDependencies ?? {}),
  };

  if (deps.vitest) return 'vitest';
  if (deps.jest) return 'jest';
  if (deps.mocha) return 'mocha';
  if (deps.ava) return 'ava';

  const scripts = /** @type {Record<string, unknown>} */ (pkg.scripts ?? {});
  const testScript =
    typeof scripts.test === 'string' ? scripts.test.toLowerCase() : '';
  if (testScript) {
    if (testScript.includes('vitest')) return 'vitest';
    if (testScript.includes('jest')) return 'jest';
    if (testScript.includes('mocha')) return 'mocha';
    if (testScript.includes('ava')) return 'ava';
    if (
      testScript.includes('node --test') ||
      testScript.includes('node:test')
    ) {
      return 'node-test';
    }
  }

  return null;
}

/**
 * Detect the primary language by tallying source-file extensions and
 * picking the most frequent recognized language. A `tsconfig.json`
 * breaks ties toward TypeScript. Returns `null` when no recognized
 * source files are found.
 *
 * @param {string} root - Repository root.
 * @param {FsFacade} [fsFacade=defaultFsFacade]
 * @returns {string|null}
 */
export function detectPrimaryLanguage(root, fsFacade = defaultFsFacade) {
  const extensions = fsFacade.listExtensions(root) ?? [];
  /** @type {Map<string, number>} */
  const tally = new Map();

  for (const ext of extensions) {
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    const language = extensionToLanguage(ext);
    if (!language) continue;
    tally.set(language, (tally.get(language) ?? 0) + 1);
  }

  if (tally.size === 0) return null;

  // tsconfig.json is a strong TypeScript signal: nudge the tally so a
  // mixed JS/TS repo resolves to typescript when the config is present.
  if (fsFacade.exists(path.join(root, 'tsconfig.json'))) {
    tally.set('typescript', (tally.get('typescript') ?? 0) + 1);
  }

  let best = null;
  let bestCount = -1;
  for (const [language, count] of tally) {
    if (count > bestCount) {
      best = language;
      bestCount = count;
    }
  }

  return best;
}

/**
 * Inspect a consumer repository and report the inferred stack.
 *
 * @param {string} root - Absolute repository root to inspect.
 * @param {FsFacade} [fsFacade=defaultFsFacade] - Filesystem seam (defaults to real disk).
 * @returns {{ packageManager: 'pnpm'|'yarn'|'bun'|'npm'|null, testRunner: 'vitest'|'jest'|'mocha'|'ava'|'node-test'|null, primaryLanguage: string|null }}
 */
export function detectStack(root, fsFacade = defaultFsFacade) {
  if (!root || typeof root !== 'string') {
    throw new Error('detectStack: root must be a non-empty string path');
  }

  return {
    packageManager: detectPackageManager(root, fsFacade),
    testRunner: detectTestRunner(root, fsFacade),
    primaryLanguage: detectPrimaryLanguage(root, fsFacade),
  };
}
