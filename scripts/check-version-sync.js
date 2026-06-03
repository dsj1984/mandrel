#!/usr/bin/env node

/**
 * scripts/check-version-sync.js — Version Consistency Guard
 *
 * Verifies that the framework version is identical across the two release
 * sources of truth:
 *   - package.json → `version`
 *   - .release-please-manifest.json → the root package entry (`"."`)
 *
 * Invoked from the pre-commit hook. Exits non-zero with a diagnostic if the
 * pair diverges. release-please writes both in lockstep on every release, so
 * catching drift at commit time prevents shipping a `package.json` bump with
 * a stale manifest entry.
 *
 * Under npm distribution `package.json` is the single source of truth for the
 * framework version; the legacy plaintext version marker is retired, so this
 * gate no longer cross-checks it.
 *
 * This script intentionally lives outside `.agents/` because it is specific
 * to this repository's release process — the `.agents/` tree is distributed
 * to consumer projects and should only contain protocol tooling that is
 * generally useful.
 *
 * Usage:
 *   node scripts/check-version-sync.js
 *
 * Exit codes:
 *   0 — Both sources match.
 *   1 — Mismatch or unreadable source (details on stderr).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');

// The root package is keyed under `"."` in the release-please manifest
// (see release-please-config.json → `packages["."]`).
const ROOT_PACKAGE_KEY = '.';

export function readPackageVersion(root = DEFAULT_ROOT) {
  const raw = readFileSync(resolve(root, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw);
  if (typeof parsed.version !== 'string') {
    throw new Error('package.json has no "version" field');
  }
  return parsed.version.trim();
}

export function readManifestVersion(root = DEFAULT_ROOT) {
  const raw = readFileSync(
    resolve(root, '.release-please-manifest.json'),
    'utf8',
  );
  const parsed = JSON.parse(raw);
  const version = parsed[ROOT_PACKAGE_KEY];
  if (typeof version !== 'string') {
    throw new Error(
      `.release-please-manifest.json has no "${ROOT_PACKAGE_KEY}" root-package entry`,
    );
  }
  return version.trim();
}

export function checkVersionSync(root = DEFAULT_ROOT) {
  const sources = {
    'package.json': readPackageVersion(root),
    '.release-please-manifest.json': readManifestVersion(root),
  };

  const versions = new Set(Object.values(sources));
  if (versions.size === 1) {
    return { ok: true, version: [...versions][0], sources };
  }

  const lines = Object.entries(sources).map(
    ([file, version]) => `  ${file.padEnd(30)} → ${version}`,
  );
  return {
    ok: false,
    sources,
    reason:
      'Version drift detected. The following sources must all agree:\n' +
      lines.join('\n'),
  };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = checkVersionSync();
    if (!result.ok) {
      console.error(`[check-version-sync] ${result.reason}`);
      process.exit(1);
    }
    console.log(`[check-version-sync] ✅ all sources at ${result.version}`);
  } catch (err) {
    console.error(`[check-version-sync] ${err.message}`);
    process.exit(1);
  }
}
