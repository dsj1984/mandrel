/**
 * runtime-deps/parser-major — whether the resolved `@babel/parser` major is
 * one the complexity kernel can parse with. Separate so `mandrel doctor` can
 * ask without importing the kernel (and its AST patch side effect). The
 * parser resolves from the consumer's tree, so this is the enforcement of the
 * declared range.
 *
 * @module lib/runtime-deps/parser-major
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';

// 8.x throws on the kernel's fixed plugin list; adopting it is a deliberate
// change with a baseline recut, not something to absorb from a consumer.
const SUPPORTED_PARSER_MAJOR = 7;

const PARSER_PACKAGE = '@babel/parser';

/** Memoised: `undefined` unread, `null` unresolvable. */
let parserVersion;

/**
 * The package exports no version, so its manifest is the only source.
 *
 * @returns {string|null} The resolved version, or `null` when the manifest
 *   cannot be read.
 */
function resolveParserVersion() {
  if (parserVersion !== undefined) return parserVersion;
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(`${PARSER_PACKAGE}/package.json`);
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
    parserVersion = typeof parsed?.version === 'string' ? parsed.version : null;
  } catch {
    parserVersion = null;
  }
  return parserVersion;
}

/**
 * @returns {number|null}
 */
function resolveParserMajor() {
  const version = resolveParserVersion();
  if (version === null) return null;
  const major = Number.parseInt(version, 10);
  return Number.isInteger(major) ? major : null;
}

/**
 * One message shared by the kernel's load-time assertion and the preflight
 * guard. An unknowable version is not reported — scoring with an unverified
 * parser beats refusing to score; only a known-wrong major is.
 *
 * @param {{major?: number|null, version?: string|null}} [resolved] Overrides
 *   the resolved parser (test seam).
 * @returns {string|null} The message, or `null` when the resolved parser is
 *   supported (or its version is unknowable).
 */
export function describeParserMajorError(resolved = {}) {
  const { major = resolveParserMajor(), version = resolveParserVersion() } =
    resolved;
  if (major === null || major === SUPPORTED_PARSER_MAJOR) return null;
  return (
    `unsupported ${PARSER_PACKAGE} major: resolved ${version}, ` +
    `the complexity kernel requires ${SUPPORTED_PARSER_MAJOR}.x. It parses ` +
    `with a fixed plugin list that later majors reject, so CRAP and ` +
    `maintainability scoring would fail mid-scan with an opaque plugin-list ` +
    `error. Declare "${PARSER_PACKAGE}": "^${SUPPORTED_PARSER_MAJOR}" in ` +
    `your package.json (see .agents/runtime-deps.json).`
  );
}
