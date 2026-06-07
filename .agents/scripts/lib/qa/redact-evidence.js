/**
 * redact-evidence.js — deterministic secrets/PII scrubber for captured evidence.
 *
 * Story #3717 (Feature #3713, Epic #3686), broadened by Story #3737. The QA
 * harness captures evidence strings (console text, network bodies, error
 * symptoms) that may carry sensitive material. The security baseline
 * (`.agents/rules/security-baseline.md` § Data Leakage & Logging, § Secrets
 * Management) forbids persisting or posting that material to disk or GitHub.
 * This module is the redaction pass that runs **before** any such persistence.
 *
 * The rule set covers the full security-baseline secret/PII taxonomy:
 * bearer tokens, session cookies, email addresses, **passwords**, **API keys**,
 * **credit-card numbers (PANs)**, and **SSNs**. Story #3737 added the last four
 * classes (the #3686 epic-audit + PR #3736 code-review flagged the original
 * scope as narrower than the baseline it advertises) and tightened the
 * session-cookie rule so a benign `name=value` pair whose name merely
 * *contains* a session word (e.g. `author=Jane`, `outside=cold`) is no longer
 * over-redacted (the M1 cookie over-redaction finding).
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
 * charset run long enough to re-trigger, no `=` cookie assignment, no digit
 * run long enough to read as a PAN/SSN), which is what makes the pass a fixed
 * point — feeding a redacted string back in matches nothing and changes
 * nothing.
 *
 * @type {Readonly<Record<string, string>>}
 */
const PLACEHOLDERS = Object.freeze({
  bearer: '[REDACTED:bearer-token]',
  cookie: '[REDACTED:session-cookie]',
  email: '[REDACTED:email]',
  password: '[REDACTED:password]',
  apiKey: '[REDACTED:api-key]',
  creditCard: '[REDACTED:credit-card]',
  ssn: '[REDACTED:ssn]',
});

/**
 * Session-secret cookie-name words. A cookie assignment is redacted only when
 * one of these appears as a whole `_`/`.`/`-`-delimited segment of the cookie
 * name — so `sessionId`, `connect.sid`, `auth_token`, `csrf_token`, and
 * `JSESSIONID` match, but `author`, `outside`, `presidency`, and `tokenize`
 * (which merely *contain* a session substring) do not. This segment anchoring
 * is the M1 over-redaction fix.
 *
 * @type {string}
 */
const SESSION_WORDS = 'session|sessionid|sid|auth|token|jsessionid|csrf|xsrf';

/**
 * Build the case-insensitive session-cookie pattern. The cookie name is one or
 * more `_`/`.`/`-`-delimited segments where at least one segment *is* a session
 * word (boundaries `^`, `_`, `.`, `-`, `$` on both sides), followed by `=` and
 * a value up to the next `;`, whitespace, or end of string.
 *
 * @returns {RegExp}
 */
function buildCookiePattern() {
  const segment = '[A-Za-z0-9]+';
  const sessionSegment = `(?:${SESSION_WORDS})`;
  // name = optional leading segments, a session segment, optional trailing
  // segments, all joined by `_`/`.`/`-`. The (?:...) around the whole name is
  // captured so `replace` can preserve it.
  const name = `(?:${segment}[._-])*${sessionSegment}(?:[._-]${segment})*`;
  // The value charset excludes `[` so an already-substituted placeholder
  // (`[REDACTED:…]`, emitted by an earlier value-masking rule such as
  // apiKeyAssignment on `access_token=…`) is not re-matched and re-labelled as
  // a session cookie. This keeps rule order hermetic and the pass idempotent.
  return new RegExp(`\\b(${name})=([^;\\s[]+)`, 'gi');
}

/**
 * Decide whether a digit run (optionally space/hyphen grouped) is a 13–19 digit
 * credit-card number. Used by the credit-card rule's `replace` to confirm the
 * digit count after the loose pattern matches, so a longer numeric id is never
 * partially masked.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function isCreditCard(candidate) {
  const digits = candidate.replace(/[ -]/g, '');
  return /^\d{13,19}$/.test(digits);
}

/**
 * Ordered redaction rules. Order matters:
 *   - the bearer-token rule runs before the cookie rule so an
 *     `Authorization: Bearer …` header is classified as a token rather than
 *     swept up by a broader cookie match;
 *   - the password and API-key rules run before the cookie rule so a
 *     `password=…` / `api_key=…` assignment is classified by its own
 *     placeholder rather than read as a session cookie;
 *   - the credit-card and SSN rules run before the email rule so a bare digit
 *     run is classified before the email pass; the email rule runs last so an
 *     address embedded in an already-redacted span is never re-scrubbed.
 *
 * Each `pattern` is a global `RegExp` (case-insensitive where the surrounding
 * keywords are alphabetic). The `replace` is a function so a rule can preserve
 * a non-secret prefix (the `Bearer ` keyword, the key name, the cookie name)
 * while masking only the secret value.
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
  // Passwords: a `password` / `passwd` / `pwd` assignment in the common
  // shapes — `password=...`, `pwd: ...`, JSON `"password": "..."`. Preserve
  // the key and the assignment punctuation (`=`, `:`, optional quotes); mask
  // the value up to the next delimiter (`&`, `;`, `,`, whitespace, matching
  // quote, or end of string). Requires a non-empty value so a bare
  // `password=` is left alone.
  {
    name: 'password',
    pattern: /\b(passwd|password|pwd)(["']?\s*[:=]\s*)(["']?)([^"'&;,\s]+)\3/gi,
    replace: (_match, key, sep, quote) =>
      `${key}${sep}${quote}${PLACEHOLDERS.password}${quote}`,
  },
  // API keys (provider-prefixed): Stripe / GitHub `<prefix>_<token>`,
  // OpenAI/Anthropic `sk-<token>`, Google `AIza<token>`, AWS `AKIA<id>`.
  // Masked whole.
  {
    name: 'apiKeyPrefixed',
    pattern:
      /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|ghr)[-_][A-Za-z0-9][A-Za-z0-9_-]{10,}\b|\bAIza[A-Za-z0-9\-_]{20,}\b|\bAKIA[A-Z0-9]{16}\b/g,
    replace: () => PLACEHOLDERS.apiKey,
  },
  // API keys (assignment form): `api_key=...`, `apikey: "..."`,
  // `access-token=...`, `secret_key=...`. Preserve the key name; mask the
  // value.
  {
    name: 'apiKeyAssignment',
    pattern:
      /\b(api[_-]?key|apikey|access[_-]?token|secret[_-]?key)(["']?\s*[:=]\s*)(["']?)([^"'&;,\s]+)\3/gi,
    replace: (_match, key, sep, quote) =>
      `${key}${sep}${quote}${PLACEHOLDERS.apiKey}${quote}`,
  },
  // Session cookies: a cookie assignment whose name carries a session-secret
  // word as a whole delimited segment (see SESSION_WORDS / buildCookiePattern).
  // Preserve the cookie name and `=`; mask the value up to the next `;`,
  // whitespace, or end of string.
  {
    name: 'cookie',
    pattern: buildCookiePattern(),
    replace: (_match, name) => `${name}=${PLACEHOLDERS.cookie}`,
  },
  // Credit-card numbers (PANs): 13–19 digit runs, optionally grouped by single
  // spaces or hyphens (`4111 1111 1111 1111`, `4111-1111-1111-1111`,
  // `4111111111111111`). The loose pattern matches a digit/separator run; the
  // `replace` confirms the 13–19 digit count before masking so a longer
  // numeric id is never partially redacted. Bounded by non-digit edges.
  {
    name: 'creditCard',
    pattern: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g,
    replace: (match) => (isCreditCard(match) ? PLACEHOLDERS.creditCard : match),
  },
  // US Social Security Numbers: `NNN-NN-NNNN`. Masked whole. Hyphen-separated
  // form only — a bare 9-digit run is intentionally not treated as an SSN to
  // avoid clobbering benign numeric ids.
  {
    name: 'ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replace: () => PLACEHOLDERS.ssn,
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
 * Scrub the full security-baseline secret/PII taxonomy — bearer tokens,
 * passwords, API keys, session cookies, credit-card numbers, SSNs, and email
 * addresses — from an evidence string before it is persisted to disk or posted
 * to GitHub.
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
