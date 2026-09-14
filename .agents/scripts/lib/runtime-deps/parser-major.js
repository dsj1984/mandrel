/**
 * runtime-deps/parser-major — which `@babel/parser` major the complexity
 * kernel can actually parse with, and how to say so when it is wrong.
 *
 * Its own module because two very different callers need the same answer and
 * neither should drag the other in: the kernel asserts it at load, and
 * `mandrel doctor` reports it to a consumer. Importing the kernel into doctor
 * to ask one version question would pull the whole metric core and install the
 * AST compatibility patch as a side effect.
 *
 * `.agents/` materializes into the consumer's repository root, so
 * `@babel/parser` resolves from *their* `node_modules`. A range in
 * `runtime-deps.json` documents the requirement; it cannot enforce it. This is
 * the enforcement.
 *
 * @module lib/runtime-deps/parser-major
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';

/**
 * The only `@babel/parser` major the kernel supports.
 *
 * Module-local, with `describeParserMajorError` as the single public door:
 * every caller wants the verdict and the remedy, not the number.
 *
 * 8.x removed several plugin names from the kernel's fixed list (they became
 * default syntax), so it does not merely warn — it throws on the plugin list
 * itself. Adopting it is a deliberate change with a baseline recut attached,
 * not something to absorb from a consumer's resolution.
 */
const SUPPORTED_PARSER_MAJOR = 7;

/** Package whose resolved major gates the kernel. */
const PARSER_PACKAGE = '@babel/parser';

/** Memoised resolved parser version: `undefined` unread, `null` unresolvable. */
let parserVersion;

/**
 * Read the resolved `@babel/parser` version from its own manifest.
 *
 * The package exports no version, so its `package.json` is the only source.
 * This is the one non-static resolution in the file and it deliberately
 * targets a manifest rather than code: `@babel/parser` itself is reached by a
 * static import above, so it is declared and preflighted like every other
 * dependency.
 *
 * @returns {string|null} The resolved version, or `null` when the manifest
 *   cannot be read (a layout that hides `package.json` behind `exports`, say).
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
 * The resolved parser's major version.
 *
 * @returns {number|null} `null` when the version could not be resolved or
 *   does not lead with an integer.
 */
function resolveParserMajor() {
  const version = resolveParserVersion();
  if (version === null) return null;
  const major = Number.parseInt(version, 10);
  return Number.isInteger(major) ? major : null;
}

/**
 * Describe the resolved-parser problem, if there is one.
 *
 * Single-sourced so the load-time assertion below and the preflight guard
 * (`runtime-deps/ensure-installed.js`) emit the *same* named, actionable
 * message — the point of AC-5 is that a consumer never meets this as a
 * plugin-list syntax error mid-scan.
 *
 * An unresolvable version is **not** a problem: a consumer layout that hides
 * the manifest still resolves the parser itself, and refusing to score would
 * be a worse answer than scoring with an unverified parser. Only a
 * *known-wrong* major is reported.
 *
 * @param {{major?: number|null, version?: string|null}} [resolved] Overrides
 *   the resolved parser, so the message a consumer on an unsupported major
 *   would read is assertable without installing one.
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
