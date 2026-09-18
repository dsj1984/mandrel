/**
 * console-allowlist.js — deterministic console-message → finding filter.
 * Each non-allowlisted console error becomes one `F#` finding (console-derived
 * subset); `qa.consoleAllowlist` patterns suppress expected noise.
 */

/**
 * Only these levels can become a finding.
 *
 * @type {ReadonlySet<string>}
 */
const ERROR_LEVELS = new Set(['error', 'severe']);

/**
 * Capture surfaces disagree on field names, so accept the common spellings.
 *
 * @param {unknown} message
 * @returns {{ level: string, text: string }}
 */
function normaliseMessage(message) {
  if (message == null || typeof message !== 'object') {
    return { level: '', text: typeof message === 'string' ? message : '' };
  }
  const record = /** @type {Record<string, unknown>} */ (message);
  const rawLevel = record.level ?? record.type ?? record.severity ?? '';
  const rawText = record.text ?? record.message ?? record.value ?? '';
  return {
    level: String(rawLevel).toLowerCase(),
    text: String(rawText),
  };
}

/**
 * Case-sensitive substring match (not regex, so operators never escape
 * metacharacters). A blank pattern is ignored — it would swallow every error.
 *
 * @param {string} text Normalised console message text.
 * @param {string[]} allowlist
 * @returns {boolean} `true` when the message is allowlisted (suppress it).
 */
export function isAllowlisted(text, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return false;
  }
  return allowlist.some((pattern) => {
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      return false;
    }
    return text.includes(pattern);
  });
}

/**
 * @param {{ level: string, text: string }} message Normalised console error.
 * @param {{ surface?: string, index: number }} ctx
 * @returns {object} Structured `F#` finding (console-derived subset).
 */
function buildFinding(message, ctx) {
  return {
    id: `F${ctx.index}`,
    classification: 'console-error',
    surface: ctx.surface ?? 'unknown',
    symptom: message.text,
    likelyRootCause: null,
    disposition: 'follow-up',
    acceptance: null,
    evidence: {
      console: [{ level: message.level, text: message.text }],
      network: [],
    },
  };
}

/**
 * Findings in capture order, ids `F1`, `F2`, …
 *
 * @param {Array<unknown>} messages Captured console messages.
 * @param {string[]} [allowlist] `qa.consoleAllowlist` patterns.
 * @param {{ surface?: string }} [opts]
 * @returns {object[]}
 */
export function filterConsoleMessages(messages, allowlist = [], opts = {}) {
  if (!Array.isArray(messages)) {
    return [];
  }
  const findings = [];
  for (const raw of messages) {
    const message = normaliseMessage(raw);
    if (!ERROR_LEVELS.has(message.level)) {
      continue;
    }
    if (isAllowlisted(message.text, allowlist)) {
      continue;
    }
    findings.push(
      buildFinding(message, {
        surface: opts.surface,
        index: findings.length + 1,
      }),
    );
  }
  return findings;
}
