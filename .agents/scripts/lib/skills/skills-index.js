// .agents/scripts/lib/skills/skills-index.js
//
// Shared I/O for the two skills manifests (payload and local zone). They are
// read, compared and audited identically but never merged: the shipped one is
// compared byte-for-byte against the installed package.

import fs from 'node:fs';
import path from 'node:path';

export const INDEX_FILENAME = 'skills.index.json';

/**
 * @param {string} repoRoot
 * @param {readonly string[]} rootSegments From `walk-skill-files.js`.
 * @returns {string}
 */
export function indexPathFor(repoRoot, rootSegments) {
  return path.join(repoRoot, ...rootSegments, INDEX_FILENAME);
}

/**
 * `reason` separates "missing" from "unparseable" so callers can say which.
 *
 * @param {string} indexPath
 * @returns {{ manifest: object | null, reason: string | null }}
 */
export function readManifest(indexPath) {
  if (!fs.existsSync(indexPath)) {
    return { manifest: null, reason: 'missing' };
  }
  let src;
  try {
    src = fs.readFileSync(indexPath, 'utf8');
  } catch (err) {
    return { manifest: null, reason: `read-error: ${err.message}` };
  }
  try {
    return { manifest: JSON.parse(src), reason: null };
  } catch (err) {
    return { manifest: null, reason: `parse-error: ${err.message}` };
  }
}

/**
 * @param {string} indexPath
 * @returns {{ exists: boolean, paths: Set<string> | null, manifest: object | null, indexPath: string, parseError?: string }}
 */
export function readIndexPaths(indexPath) {
  const { manifest, reason } = readManifest(indexPath);
  if (reason === 'missing') {
    return { exists: false, paths: null, manifest: null, indexPath };
  }
  if (manifest === null) {
    return {
      exists: true,
      paths: null,
      manifest: null,
      indexPath,
      parseError: reason,
    };
  }
  const paths = new Set(
    Array.isArray(manifest.skills)
      ? manifest.skills.map((s) => s.path).filter((p) => typeof p === 'string')
      : [],
  );
  return { exists: true, paths, manifest, indexPath };
}

/**
 * Ignores the volatile `generatedAt`; `null` when the manifests match.
 *
 * @param {object | null} diskManifest
 * @param {object} freshManifest
 * @param {string} label Manifest name for the message.
 * @returns {string | null}
 */
export function diffManifests(diskManifest, freshManifest, label) {
  if (diskManifest === null) {
    return `${label}: on-disk manifest is missing or unreadable`;
  }
  const a = { ...diskManifest };
  const b = { ...freshManifest };
  a.generatedAt = undefined;
  b.generatedAt = undefined;
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  const count = (m) => (Array.isArray(m.skills) ? m.skills.length : 'n/a');
  return [
    `${label} drift detected:`,
    `  on-disk entries:  ${count(diskManifest)}`,
    `  generated entries: ${count(freshManifest)}`,
    "  run 'node .agents/scripts/generate-skills-index.js' to refresh",
  ].join('\n');
}

/**
 * The validator is injected so this module avoids schema-loading side effects.
 *
 * @param {object} manifest
 * @param {string} indexRelPath
 * @param {(m: object) => boolean} validateManifest Compiled AJV validator.
 * @returns {string[]}
 */
function validateManifestSchema(manifest, indexRelPath, validateManifest) {
  const findings = [];
  if (validateManifest(manifest)) return findings;
  for (const err of validateManifest.errors ?? []) {
    const where = err.instancePath || '(root)';
    findings.push(
      `${indexRelPath}: manifest-schema: schema violation at ${where}: ${err.message}`,
    );
  }
  return findings;
}

/**
 * Present, parseable and schema-valid — the same bar for both roots.
 *
 * @param {{ exists: boolean, paths: Set<string> | null, manifest: object | null, parseError?: string }} indexInfo
 * @param {string} indexRelPath
 * @param {(m: object) => boolean} validateManifest
 * @param {{ required: boolean }} options
 * @returns {string[]}
 */
export function auditIndex(
  indexInfo,
  indexRelPath,
  validateManifest,
  { required },
) {
  if (!indexInfo.exists) {
    return required
      ? [
          `index missing: ${indexRelPath} not found — run 'node .agents/scripts/generate-skills-index.js'`,
        ]
      : [];
  }
  if (indexInfo.paths === null) {
    return [`index unparseable: ${indexRelPath} — ${indexInfo.parseError}`];
  }
  if (indexInfo.manifest === null) return [];
  return validateManifestSchema(
    indexInfo.manifest,
    indexRelPath,
    validateManifest,
  );
}
