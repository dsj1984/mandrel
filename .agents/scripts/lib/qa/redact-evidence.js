/**
 * redact-evidence.js — deterministic secrets/PII scrubber run before QA
 * evidence is persisted or posted (security baseline § Data Leakage).
 * Idempotent (placeholders match no rule) and pass-through for benign text.
 */

/**
 * Per-rule placeholders, free of anything a pattern matches (`@`, `=`, long
 * token or digit runs) so the pass is a fixed point.
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
 * Must appear as a whole `_`/`.`/`-` segment of the cookie name, so
 * `connect.sid` matches but `author` or `tokenize` do not.
 *
 * @type {string}
 */
const SESSION_WORDS = 'session|sessionid|sid|auth|token|jsessionid|csrf|xsrf';

/**
 * @returns {RegExp}
 */
function buildCookiePattern() {
  const segment = '[A-Za-z0-9]+';
  const sessionSegment = `(?:${SESSION_WORDS})`;
  const name = `(?:${segment}[._-])*${sessionSegment}(?:[._-]${segment})*`;
  // The value excludes `[` so a placeholder emitted by an earlier rule is not
  // re-labelled as a session cookie.
  return new RegExp(`\\b(${name})=([^;\\s[]+)`, 'gi');
}

/**
 * Confirms 13–19 digits after the loose match, so a longer numeric id is
 * never partially masked.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function isCreditCard(candidate) {
  const digits = candidate.replace(/[ -]/g, '');
  return /^\d{13,19}$/.test(digits);
}

/**
 * Order matters: bearer, password and API-key rules precede the cookie rule
 * so those assignments get their own placeholder; digit rules precede email;
 * email runs last.
 *
 * @type {ReadonlyArray<{ name: string, pattern: RegExp, replace: (match: string, ...groups: string[]) => string }>}
 */
const RULES = Object.freeze([
  // ≥8 chars so "Bearer none" is not a credential.
  {
    name: 'bearer',
    pattern: /\b(Bearer)\s+([A-Za-z0-9\-._+/=]{8,})/gi,
    replace: (_match, keyword) => `${keyword} ${PLACEHOLDERS.bearer}`,
  },
  {
    name: 'password',
    pattern: /\b(passwd|password|pwd)(["']?\s*[:=]\s*)(["']?)([^"'&;,\s]+)\3/gi,
    replace: (_match, key, sep, quote) =>
      `${key}${sep}${quote}${PLACEHOLDERS.password}${quote}`,
  },
  {
    name: 'apiKeyPrefixed',
    pattern:
      /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|ghr)[-_][A-Za-z0-9][A-Za-z0-9_-]{10,}\b|\bAIza[A-Za-z0-9\-_]{20,}\b|\bAKIA[A-Z0-9]{16}\b/g,
    replace: () => PLACEHOLDERS.apiKey,
  },
  {
    name: 'apiKeyAssignment',
    pattern:
      /\b(api[_-]?key|apikey|access[_-]?token|secret[_-]?key)(["']?\s*[:=]\s*)(["']?)([^"'&;,\s]+)\3/gi,
    replace: (_match, key, sep, quote) =>
      `${key}${sep}${quote}${PLACEHOLDERS.apiKey}${quote}`,
  },
  {
    name: 'cookie',
    pattern: buildCookiePattern(),
    replace: (_match, name) => `${name}=${PLACEHOLDERS.cookie}`,
  },
  {
    name: 'creditCard',
    pattern: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g,
    replace: (match) => (isCreditCard(match) ? PLACEHOLDERS.creditCard : match),
  },
  // Hyphenated form only; a bare 9-digit run is too often a benign id.
  {
    name: 'ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replace: () => PLACEHOLDERS.ssn,
  },
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: () => PLACEHOLDERS.email,
  },
]);

/**
 * Non-string input returns '' so a secret-bearing object is never
 * stringified.
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
    rule.pattern.lastIndex = 0;
    result = result.replace(rule.pattern, rule.replace);
  }
  return result;
}

/**
 * @type {Readonly<Record<string, string>>}
 */
export const REDACTION_PLACEHOLDERS = PLACEHOLDERS;
