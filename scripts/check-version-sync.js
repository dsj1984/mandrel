#!/usr/bin/env node

/**
 * scripts/check-version-sync.js — Version Consistency Guard
 *
 * Verifies that the version is identical across three sources of truth:
 *   - package.json → `version`
 *   - .agents/VERSION (plain text)
 *   - docs/CHANGELOG.md → latest `## [X.Y.Z]` heading
 *
 * Invoked from the pre-commit hook. Exits non-zero with a diagnostic if any
 * pair diverges. Released versions should always move together; catching
 * drift at commit time prevents shipping a `package.json` bump with a stale
 * VERSION file or an undocumented CHANGELOG.
 *
 * This script intentionally lives outside `.agents/` because it is specific
 * to this repository's release process — the `.agents/` tree is distributed
 * to consumer projects as a submodule and should only contain protocol
 * tooling that is generally useful.
 *
 * Usage:
 *   node scripts/check-version-sync.js
 *
 * Exit codes:
 *   0 — All three sources match.
 *   1 — Mismatch or unreadable source (details on stderr).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');

const CHANGELOG_HEADING_RE = /^##\s*\[(\d+\.\d+\.\d+)\]/m;
const CHANGELOG_UNRELEASED_RE = /^##\s*\[Unreleased\]/m;

export function readPackageVersion(root = DEFAULT_ROOT) {
  const raw = readFileSync(resolve(root, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw);
  if (typeof parsed.version !== 'string') {
    throw new Error('package.json has no "version" field');
  }
  return parsed.version.trim();
}

export function readVersionFile(root = DEFAULT_ROOT) {
  const raw = readFileSync(resolve(root, '.agents/VERSION'), 'utf8');
  return raw.trim();
}

export function readChangelogVersion(root = DEFAULT_ROOT) {
  const raw = readFileSync(resolve(root, 'docs/CHANGELOG.md'), 'utf8');
  const match = raw.match(CHANGELOG_HEADING_RE);
  if (match) {
    return match[1];
  }
  // No `## [X.Y.Z]` heading yet (e.g. the v6 pre-cut window after Story
  // #1605 consolidated the 5.x history out of the live file but before
  // the v6.0.0 release entry has been written). An `## [Unreleased]`
  // anchor is treated as a wildcard that matches whatever version the
  // other two sources agree on.
  if (CHANGELOG_UNRELEASED_RE.test(raw)) {
    return null;
  }
  throw new Error(
    'docs/CHANGELOG.md has no "## [X.Y.Z]" heading or "## [Unreleased]" anchor — cannot determine latest version',
  );
}

export function checkVersionSync(root = DEFAULT_ROOT) {
  const sources = {
    'package.json': readPackageVersion(root),
    '.agents/VERSION': readVersionFile(root),
    'docs/CHANGELOG.md': readChangelogVersion(root),
  };

  // The CHANGELOG may legitimately return `null` while sitting on a bare
  // `## [Unreleased]` anchor (the v6 pre-cut window). When that happens,
  // the changelog source is a wildcard — drop it from the equality check.
  const concreteSources = Object.fromEntries(
    Object.entries(sources).filter(([, version]) => version != null),
  );

  const versions = new Set(Object.values(concreteSources));
  if (versions.size === 1) {
    return { ok: true, version: [...versions][0], sources };
  }

  const lines = Object.entries(sources).map(
    ([file, version]) =>
      `  ${file.padEnd(22)} → ${version ?? '[Unreleased] (wildcard)'}`,
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
