/**
 * Shell-injection pattern source (string form) used inside JSON Schema
 * `not.pattern` clauses. Kept as a string so the schema literal and the
 * regex form share one definition.
 *
 * Matches `;`, `&`, `|`, backtick, or `$(`.
 */
export const SHELL_INJECTION_PATTERN_STRING = '([;&|`]|\\$\\()';

/**
 * Regex form of the lenient shell-injection pattern for runtime string checks.
 */
export const SHELL_INJECTION_RE = new RegExp(SHELL_INJECTION_PATTERN_STRING);

/**
 * Stricter shell metacharacter pattern for orchestration runtime values
 * (owner, repo, operator handle, webhook URL) where no shell metacharacters
 * are ever legitimate.
 */
export const SHELL_INJECTION_RE_STRICT = /[&|;`<>()$]/;

// Re-export the canonical baseline schema registry (Story #1888). The
// registry implementation lives in `baseline-schema-registry.js`; this
// re-export keeps `config-schema-shared.js` as the canonical import surface
// for downstream consumers and the mirror-drift test.
export {
  BASELINE_ENVELOPE_FILE,
  BASELINE_KIND_SCHEMA_FILES,
  BASELINE_SCHEMA_FILES,
  BASELINE_SCHEMAS_DIR,
  buildBaselineSchemaAjv,
} from './baseline-schema-registry.js';
