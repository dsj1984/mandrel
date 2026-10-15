// lib/cli/doctor-checks/payload.js — Doctor checks: agents-drift, pin-current.

import fs from 'node:fs';
import path from 'node:path';
import {
  defaultResolvePackageRoot,
  listFiles as listPayloadFiles,
} from '../sync.js';
import {
  compareVersions as compareSemver,
  resolveConsumerPinSpec,
  satisfiesPinSpec,
} from '../version-helpers.js';

// check: agents-drift

/**
 * A size mismatch proves drift without reading contents; equal sizes fall
 * through to a byte compare. `statSync` is optional on the seam.
 *
 * @param {string} src - absolute path to the package-payload file
 * @param {string} dest - absolute path to the materialized file
 * @param {{ readFileSync: Function, statSync?: Function }} fsImpl
 * @returns {boolean} `true` when the files differ
 */
function payloadFileDrifted(src, dest, fsImpl) {
  if (
    typeof fsImpl.statSync === 'function' &&
    fsImpl.statSync(src).size !== fsImpl.statSync(dest).size
  ) {
    return true;
  }
  return !fsImpl.readFileSync(src).equals(fsImpl.readFileSync(dest));
}

/**
 * Compare materialized `./.agents/` bytes to the installed package payload
 * (excluding `.agents/local/`) and report the first missing or drifted file.
 * Only paths and counts are reported, never contents.
 *
 * @param {{
 *   cwd?: () => string,
 *   fsImpl?: { existsSync: (p: string) => boolean, readdirSync: Function, readFileSync: Function, statSync?: Function },
 *   resolvePackageRoot?: (fromDir: string) => string,
 * }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runAgentsDrift({ cwd, fsImpl = fs, resolvePackageRoot } = {}) {
  const getCwd = cwd ?? (() => process.cwd());
  const resolveRoot = resolvePackageRoot ?? defaultResolvePackageRoot;
  const projectRoot = getCwd();

  let packageRoot;
  try {
    packageRoot = resolveRoot(projectRoot);
  } catch {
    // agents-materialized owns the "not installed" remedy.
    return {
      ok: true,
      detail: 'mandrel not installed — drift skipped',
    };
  }

  const sourceRoot = path.join(packageRoot, '.agents');
  if (!fsImpl.existsSync(sourceRoot)) {
    return {
      ok: true,
      detail: 'mandrel ships no .agents/ payload — drift skipped',
    };
  }

  const destRoot = path.join(projectRoot, '.agents');
  if (!fsImpl.existsSync(destRoot)) {
    return { ok: true, detail: './.agents/ not materialized — drift skipped' };
  }

  const files = listPayloadFiles(sourceRoot, fsImpl);
  let comparedCount = 0;
  let missingCount = 0;

  for (const rel of files) {
    const src = path.join(sourceRoot, rel);
    const dest = path.join(destRoot, rel);
    const relLabel = path.join('.agents', rel);

    if (!fsImpl.existsSync(dest)) {
      missingCount += 1;
      return {
        ok: false,
        detail: `${relLabel} is missing from ./.agents/ (${missingCount} of ${files.length} payload files checked so far)`,
        remedy:
          'Run `mandrel sync` to restore the materialized .agents/ payload.',
      };
    }

    comparedCount += 1;
    if (payloadFileDrifted(src, dest, fsImpl)) {
      return {
        ok: false,
        detail: `${relLabel} differs from the installed package payload`,
        remedy:
          'Run `mandrel sync` to overwrite local edits, or move intentional changes into the `.agents/local/` zone.',
      };
    }
  }

  return {
    ok: true,
    detail: `${comparedCount} materialized file(s) match the package payload`,
  };
}

// check: pin-current

/**
 * Fatal: does the installed `mandrel` satisfy the consumer's declared range?
 * Distinct from `agents-drift` (file contents) and `version-current` (newer
 * published). Graded by range satisfaction, not identity, because `^2.1.0` +
 * 2.4.0 after `npm update` is the normal steady state:
 * - satisfies and equals the base → pass;
 * - satisfies but newer than the base → pass, advisory in `detail`;
 * - behind the base → fail (distinct message);
 * - otherwise outside the range → fail.
 * No resolvable semver pin (absent, `workspace:`, `git+`, `latest`, …) skips.
 *
 * @param {{
 *   cwd?: () => string,
 *   fsImpl?: typeof fs,
 *   resolvePackageRoot?: (fromDir: string) => string,
 * }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runPinCurrent({ cwd, fsImpl = fs, resolvePackageRoot } = {}) {
  const getCwd = cwd ?? (() => process.cwd());
  const resolveRoot = resolvePackageRoot ?? defaultResolvePackageRoot;
  const projectRoot = getCwd();

  const spec = resolveConsumerPinSpec(projectRoot, fsImpl);
  if (!spec) {
    return {
      ok: true,
      detail: 'no resolvable mandrel dependency pin — skipped',
    };
  }

  let installedRoot;
  try {
    installedRoot = resolveRoot(projectRoot);
  } catch {
    return {
      ok: true,
      detail: 'mandrel not installed — pin check skipped',
    };
  }

  let installed;
  try {
    const parsed = JSON.parse(
      fsImpl.readFileSync(path.join(installedRoot, 'package.json'), 'utf8'),
    );
    installed = String(parsed.version);
  } catch {
    return {
      ok: true,
      detail: 'installed version unreadable — pin check skipped',
    };
  }

  const declared = `${spec.operator}${spec.version}`;

  if (compareSemver(installed, spec.version) < 0) {
    return {
      ok: false,
      detail: `package.json pins ${declared} but an older v${installed} is installed`,
      remedy:
        'Run `npm install` to install a version satisfying the package.json pin.',
    };
  }

  if (!satisfiesPinSpec(installed, spec)) {
    return {
      ok: false,
      detail: `package.json pins ${declared} but v${installed} is installed — outside the declared range`,
      remedy:
        'Run `mandrel update` to reconcile the package.json pin with the installed version.',
    };
  }

  if (compareSemver(installed, spec.version) > 0) {
    // The doctor prints only `detail` for a pass, so the advisory rides there.
    return {
      ok: true,
      detail: `v${installed} satisfies the ${declared} pin but is newer than it — run \`mandrel update\` to re-pin (advisory)`,
    };
  }

  return {
    ok: true,
    detail: `pin ${declared} matches the installed version`,
  };
}
