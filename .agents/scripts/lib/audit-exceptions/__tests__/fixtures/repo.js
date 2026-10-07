/**
 * Throwaway repositories for the `/audit-exceptions` tests, built per test in
 * the suite temp root — never committed. Fixture manifests and lockfiles
 * living in the tree would be picked up by knip, Renovate and `npm audit`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { gitSync } from '../../../git-utils.js';
import { makeTempDir } from '../../../test-temp.js';

/**
 * @param {Record<string, string|object>} files - path → text (objects are JSON-encoded).
 * @param {object} [opts]
 * @param {Record<string, string|object>} [opts.untracked] - written but never `git add`ed.
 * @param {string|null} [opts.origin] - `origin` remote URL to register.
 * @returns {string} the repo root.
 */
export function makeRepo(files, { untracked = {}, origin = null } = {}) {
  const root = makeTempDir('audit-exceptions-');
  const write = (rel, content) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      typeof content === 'string'
        ? content
        : `${JSON.stringify(content, null, 2)}\n`,
    );
  };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  gitSync(root, 'init', '-q', '-b', 'main');
  gitSync(root, 'add', '-A');
  gitSync(
    root,
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'fixture',
  );
  if (origin) gitSync(root, 'remote', 'add', 'origin', origin);
  for (const [rel, content] of Object.entries(untracked)) write(rel, content);
  return root;
}

/**
 * Write an installed package manifest under `node_modules` (or any prefix).
 *
 * @param {string} root
 * @param {string} dir - e.g. `node_modules/foo` or `node_modules/.pnpm/foo@1.0.0/node_modules/foo`.
 * @param {object} manifest
 */
export function installManifest(root, dir, manifest) {
  const abs = path.join(root, dir);
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, 'package.json'), JSON.stringify(manifest));
}

/** A `gh` facade double answering every issue with the state in `states`. */
export function fakeGh(states) {
  return {
    api: async ({ endpoint }) => {
      const num = endpoint.split('/').pop();
      if (!(num in states)) throw new Error(`unexpected ${endpoint}`);
      return { stdout: `${states[num]}\n` };
    },
  };
}

/** Lines joined with `\n` — keeps directive text off a bare source line. */
export const lines = (...parts) => `${parts.join('\n')}\n`;
