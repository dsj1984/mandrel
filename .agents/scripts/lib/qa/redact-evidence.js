/**
 * redact-evidence.js — deterministic secrets/PII scrubber for captured evidence.
 *
 * Story #3717 (Feature #3713, Epic #3686). The QA harness captures evidence
 * strings (console text, network bodies, error symptoms) that may carry
 * sensitive material — bearer tokens, session cookies, email addresses. The
 * security baseline (`.agents/rules/security-baseline.md` § Data Leakage &
 * Logging, § Secrets Management) forbids persisting or posting that material
 * to disk or GitHub. This module is the redaction pass that runs **before**
 * any such persistence.
 *
 * Like its sibling `console-allowlist.js`, this is the pure, side-effect-free
 * decision layer: given an evidence string, it returns the string with every
 * matched secret/PII span replaced by a fixed placeholder. Determinism is
 * load-bearing — re-running the pass over the same input always yields the
 * same output, which gives the harness two guarantees the acceptance criteria
 * pin directly:
 *
 *   1. Idempotence — running `redactEvidence` over already-redacted text is a
 *      no-op, because each placeholder contains none of the patterns that
 *      triggered a redaction. The fixed-point property means the harness can
 *      redact eagerly without worrying about double-scrubbing corrupting
 *      evidence.
 *   2. Pass-through — a string matching no rule is returned byte-for-byte
 *      unchanged, so benign evidence is never mangled.
 *
 * Each placeholder is distinct per rule so a reader of the redacted evidence
 * can still tell *what kind* of secret was scrubbed without seeing its value.
 */

/**
 * Placeholder tokens substituted for each redacted span. Each is deliberately
 * free of any character that the redaction patterns match (no `@`, no token
 * charset run long enough to re-trigger, no `=` cookie assignment), which is
 * what makes the pass a fixed point — feeding a redacted string back in
 * matches nothing and changes nothing.
 *
 * @type {Readonly<Record<string, string>>}
 */
const PLACEHOLDERS = Object.freeze({
  bearer: '[REDACTED:bearer-token]',
  cookie: '[REDACTED:session-cookie]',
  email: '[REDACTED:email]',
});

/**
 * Ordered redaction rules. Order matters: the bearer-token rule runs before
 * the cookie rule so an `Authorization: Bearer …` header is classified as a
 * token rather than swept up by a broader cookie match, and the email rule
 * runs last so an address embedded in an already-redacted span is never
 * re-scrubbed.
 *
 * Each `pattern` is a global, case-insensitive `RegExp`. The `replace` is a
 * function so a rule can preserve a non-secret prefix (e.g. the `Bearer `
 * keyword or the cookie name) while masking only the secret value.
 *
 * @type {ReadonlyArray<{ name: string, pattern: RegExp, replace: (match: string, ...groups: string[]) => string }>}
 */
const RULES = Object.freeze([
  // Bearer tokens: `Bearer <token>` (RFC 6750 Authorization header value).
  // Preserve the `Bearer ` keyword; mask the credential. The token charset
  // covers base64url / JWT-style values (letters, digits, `-`, `_`, `.`, `+`,
  // `/`, `=`). Require at least 8 chars so a literal word like "Bearer none"
  // is not mistaken for a credential.
  {
    name: 'bearer',
    pattern: /\b(Bearer)\s+([A-Za-z0-9\-._+/=]{8,})/gi,
    replace: (_match, keyword) => `${keyword} ${PLACEHOLDERS.bearer}`,
  },
  // Session cookies: a cookie assignment whose name signals a session secret
  // (`session`, `sessionid`, `sid`, `connect.sid`, `auth`, `token`,
  // `jsessionid`, …). Preserve the cookie name and `=`; mask the value up to
  // the next `;`, whitespace, or end of string.
  {
    name: 'cookie',
    pattern:
      /\b((?:[A-Za-z0-9_.-]*(?:session|sid|auth|token)[A-Za-z0-9_.-]*))=([^;\s]+)/gi,
    replace: (_match, name) => `${name}=${PLACEHOLDERS.cookie}`,
  },
  // Email addresses (RFC 5322 pragmatic subset). Masked whole — the local
  // part and domain are both PII.
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: () => PLACEHOLDERS.email,
  },
]);

/**
 * Scrub bearer tokens, session cookies, and email addresses from an evidence
 * string before it is persisted to disk or posted to GitHub.
 *
 * Contract:
 * - Each matched secret/PII span is replaced by a rule-specific placeholder.
 * - The pass is **idempotent**: `redactEvidence(redactEvidence(s)) ===
 *   redactEvidence(s)` for all `s`, because placeholders match no rule.
 * - A string matching no rule is returned **unchanged** (referential
 *   identity is preserved for the no-match case).
 * - A non-string input is coerced defensively: `null`/`undefined` and
 *   non-string values return an empty string, so the redactor never throws on
 *   malformed evidence and never leaks a stringified secret-bearing object.
 *
 * @param {unknown} evidence Raw captured evidence text.
 * @returns {string} Redacted evidence (or the original string when no rule
 *   matched).
 */
export function redactEvidence(evidence) {
  if (typeof evidence !== 'string') {
    return '';
  }
  let result = evidence;
  for (const rule of RULES) {
    // Reset lastIndex defensively — the shared global RegExp instances carry
    // mutable state across calls, and `String.prototype.replace` resets it,
    // but an explicit reset keeps each call hermetic and order-independent.
    rule.pattern.lastIndex = 0;
    result = result.replace(rule.pattern, rule.replace);
  }
  return result;
}

/**
 * The placeholder tokens this module substitutes, exported so callers (and
 * tests) can assert on them without hard-coding the literal strings.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const REDACTION_PLACEHOLDERS = PLACEHOLDERS;
