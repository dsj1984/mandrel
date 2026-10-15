/** `github.cliConfigDir` → `process.env.GH_CONFIG_DIR`, inherited by every `gh` child. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Logger } from '../Logger.js';

function resolveGhConfigDir(value, root, { homedir = os.homedir } = {}) {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homedir(), value.slice(2));
  }
  return path.resolve(root, value);
}

function isDirectory(fsImpl, dir) {
  try {
    return fsImpl.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Sets `env.GH_CONFIG_DIR` from `github.cliConfigDir`, idempotently. Absent
 * key = no-op. A missing directory is a config error, never a silent
 * fallback to the default store; a differing inherited value is overridden
 * with one warning naming both paths.
 *
 * @param {{ cliConfigDir?: string|null }|null|undefined} github
 * @param {string} root
 * @param {{ env?: NodeJS.ProcessEnv, fsImpl?: import('node:fs'),
 *   warn?: (msg: string) => void, homedir?: () => string }} [deps]
 * @returns {string|null} the applied absolute path, or null when unset.
 */
export function applyGhConfigDir(
  github,
  root,
  {
    env = process.env,
    fsImpl = fs,
    warn = (msg) => Logger.warn(msg),
    homedir,
  } = {},
) {
  const configured = github?.cliConfigDir;
  if (typeof configured !== 'string' || configured.length === 0) return null;
  const dir = resolveGhConfigDir(configured, root, { homedir });
  if (!isDirectory(fsImpl, dir)) {
    throw new Error(
      `[config] github.cliConfigDir points at ${dir}, which is not an existing directory. ` +
        'Create it (e.g. `GH_CONFIG_DIR=<dir> gh auth login`) or remove the key to use the default gh store.',
    );
  }
  const inherited = env.GH_CONFIG_DIR;
  if (inherited && path.resolve(inherited) !== dir) {
    warn(
      `[config] github.cliConfigDir (${dir}) overrides the inherited GH_CONFIG_DIR (${inherited}).`,
    );
  }
  env.GH_CONFIG_DIR = dir;
  return dir;
}
