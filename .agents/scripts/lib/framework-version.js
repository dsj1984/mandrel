// .agents/scripts/lib/framework-version.js
/**
 * framework-version.js — single source of truth for the running Mandrel
 * framework version and the ticket-body authoring stamp.
 *
 * Two concerns live here:
 *
 * 1. **Version resolution.** Under npm distribution the root `package.json`
 *    is the canonical version marker. {@link resolveFrameworkVersion} reads it
 *    and degrades to `'unknown'` (never throws) so a missing/unreadable
 *    manifest can never crash an authoring or hydration path. The private
 *    `getVersion()` in `lib/orchestration/context-hydration-engine.js`
 *    delegates here (DRY — one manifest reader).
 *
 * 2. **Ticket-body stamp.** Epics and Stories are stamped **once at authoring
 *    time** with the running version and the authoring date, via a hybrid
 *    surface:
 *      - a hidden machine-readable field in the trailing
 *        `<!-- meta: {"mandrel_version":"…","authored_at":"…"} -->` block
 *        (the source of truth, queryable by tooling), and
 *      - a single visible footer line
 *        `> 🏷️ Authored with Mandrel v<version> · <YYYY-MM-DD>` so a human
 *        reading the raw GitHub issue sees the provenance without any tooling.
 *
 *    The stamp is **immutable**: {@link stampFrameworkVersion} is a no-op when
 *    the body already carries a `mandrel_version`, so a later re-render or
 *    Epic-body edit preserves the originally-authored version verbatim rather
 *    than bumping it to whatever version happens to be running.
 *
 * This module imports only Node builtins so it can be pulled in from the
 * story-body serializer, the ticket provider, and the Epic ideation renderer
 * without risking an import cycle.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Returned when the package manifest is absent or unreadable. */
export const FALLBACK_VERSION = 'unknown';

/**
 * Trailing machine-metadata comment block: `<!-- meta: {...} -->`. Mirrors the
 * regex the Story-body parser uses so both surfaces recognise the same block.
 */
const META_BLOCK_RE = /<!--\s*meta:\s*(\{[\s\S]*?\})\s*-->/;

/**
 * The visible authoring marker line. A blockquote so GitHub renders it as a
 * callout. Used both to detect an already-emitted marker (for the strip step)
 * and, in the Story-body parser, to skip the line during section parsing so it
 * never pollutes the last structured section.
 */
export const AUTHORED_MARKER_LINE_RE = /^\s*>\s*🏷️\s+Authored with Mandrel\b/;

/**
 * Compute the default path to the root `package.json`. This module ships inside
 * the `mandrel` package at `<pkgRoot>/.agents/scripts/lib/framework-version.js`,
 * so the manifest sits three directories up — the same layout in the dev repo
 * and the published tarball.
 *
 * @returns {string}
 */
function defaultPkgPath() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, '../../..', 'package.json');
}

/**
 * Resolve the running framework version from the root `package.json`. Degrades
 * to {@link FALLBACK_VERSION} (never throws) on any read or parse failure so a
 * missing/unreadable manifest can never crash an authoring or hydration path.
 *
 * @param {{ pkgPath?: string }} [opts] - `pkgPath` override (test seam).
 * @returns {string}
 */
export function resolveFrameworkVersion({ pkgPath } = {}) {
  try {
    const resolved = typeof pkgPath === 'string' ? pkgPath : defaultPkgPath();
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return typeof parsed.version === 'string' && parsed.version.trim()
      ? parsed.version.trim()
      : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

/**
 * Format an authoring date as `YYYY-MM-DD` (UTC). Matches the date shape the
 * rest of the authoring path uses (e.g. `qa-session`).
 *
 * @param {Date} [date=new Date()]
 * @returns {string}
 */
export function formatAuthoredDate(date = new Date()) {
  const d =
    date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return d.toISOString().slice(0, 10);
}

/**
 * Build the visible authoring marker line for a given stamp. Centralised so
 * the string is byte-identical across the two producers (the Story-body
 * serializer and {@link stampFrameworkVersion}).
 *
 * @param {{ version: string, authoredAt: string }} stamp
 * @returns {string}
 */
export function authoredMarkerLine({ version, authoredAt }) {
  return `> 🏷️ Authored with Mandrel v${version} · ${authoredAt}`;
}

/**
 * Read the framework stamp from a body's trailing meta block. Returns
 * `{ version, authoredAt }` when a non-empty `mandrel_version` is present, or
 * `null` when the body carries no stamp (or the meta block is malformed).
 * `authoredAt` is `null` when the version is present but the date is absent.
 *
 * @param {string} markdown
 * @returns {{ version: string, authoredAt: string|null }|null}
 */
export function extractFrameworkStamp(markdown) {
  if (typeof markdown !== 'string') return null;
  const match = markdown.match(META_BLOCK_RE);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const version =
    typeof parsed.mandrel_version === 'string' && parsed.mandrel_version.trim()
      ? parsed.mandrel_version.trim()
      : null;
  if (version === null) return null;
  const authoredAt =
    typeof parsed.authored_at === 'string' && parsed.authored_at.trim()
      ? parsed.authored_at.trim()
      : null;
  return { version, authoredAt };
}

/**
 * Stamp a ticket body (Epic or Story markdown) with the framework version and
 * authoring date — **once**. When the body already carries a `mandrel_version`
 * the body is returned verbatim (immutability: never re-derive or bump an
 * already-authored stamp). Otherwise the version keys are merged into (or
 * create) the trailing `<!-- meta -->` block — appended **last** so the key
 * order stays stable with the Story-body serializer — and the visible marker
 * line is (re)emitted just above it.
 *
 * The `version` / `authoredAt` overrides let a caller (e.g. the Epic edit path)
 * preserve a previously-authored stamp; both default to the running version and
 * today's date when omitted.
 *
 * @param {string} markdown
 * @param {{ version?: string, authoredAt?: string }} [stamp]
 * @returns {string}
 */
export function stampFrameworkVersion(markdown, stamp = {}) {
  const body = typeof markdown === 'string' ? markdown : '';

  // Immutability: a body that already carries a version is preserved verbatim.
  if (extractFrameworkStamp(body) !== null) return body;

  const version =
    typeof stamp?.version === 'string' && stamp.version.trim()
      ? stamp.version.trim()
      : resolveFrameworkVersion();
  const authoredAt =
    typeof stamp?.authoredAt === 'string' && stamp.authoredAt.trim()
      ? stamp.authoredAt.trim()
      : formatAuthoredDate();

  // Merge into any existing (version-less) meta block, appending the version
  // keys last for stable key order.
  const metaMatch = body.match(META_BLOCK_RE);
  const meta = {};
  if (metaMatch) {
    try {
      const parsed = JSON.parse(metaMatch[1]);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
      ) {
        Object.assign(meta, parsed);
      }
    } catch {
      // Malformed meta comment — drop it and re-emit a clean block.
    }
  }
  meta.mandrel_version = version;
  meta.authored_at = authoredAt;

  // Strip any existing meta block / marker so both re-append canonically.
  const head = body
    .replace(META_BLOCK_RE, '')
    .replace(new RegExp(AUTHORED_MARKER_LINE_RE.source, 'm'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();

  const marker = authoredMarkerLine({ version, authoredAt });
  return `${head}\n\n${marker}\n\n<!-- meta: ${JSON.stringify(meta)} -->`;
}
