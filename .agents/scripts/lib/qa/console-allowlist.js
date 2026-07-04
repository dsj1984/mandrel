/**
 * console-allowlist.js — deterministic console-message → finding filter.
 *
 * Story #3295 (Feature #3289 "Instrumentation, inspection & findings",
 * Epic #3214). The QA harness captures per-surface console messages via
 * `list_console_messages` and must turn genuine console errors into
 * structured findings while suppressing benign, expected noise. The
 * suppression contract is the `qa.consoleAllowlist` array bound in
 * `.agentrc.json` (landed by Story #3293): a list of inline patterns that
 * mark a console message as expected.
 *
 * This module is the pure, side-effect-free decision layer. Given a list of
 * captured console messages and the consumer's `consoleAllowlist`, it returns
 * one structured finding per non-allowlisted console error and drops every
 * message matched by an allowlist pattern. Determinism is load-bearing:
 * re-running the filter over the same captured console with the same allowlist
 * always yields the same findings in the same order, so the surrounding
 * harness produces stable, diffable evidence.
 *
 * The emitted finding aligns with the `F#` finding shape from Tech Spec #3285
 * (`{ id, classification, surface, symptom, likelyRootCause, disposition,
 * acceptance, evidence: { console[], network[] } }`). This module produces the
 * console-derived subset; `/qa-run` (Story #4330) maps each such finding onto a
 * `QaLedgerItem` (`qa-ledger.schema.json`) before routing it through the shared
 * classify/route/dedup/promote core, leaving richer enrichment
 * (likely-root-cause heuristics, drafting) to those later layers.
 */

/**
 * Console message levels that the harness treats as error-grade. Only
 * messages at one of these levels can become a finding; `log`, `info`,
 * `debug`, and `warning` are never escalated by this module.
 *
 * @type {ReadonlySet<string>}
 */
const ERROR_LEVELS = new Set(['error', 'severe']);

/**
 * Normalise a captured console message into `{ level, text }`. Capture
 * surfaces (`list_console_messages`, raw CDP, etc.) disagree on field names,
 * so accept the common spellings and coerce defensively. A message with no
 * recoverable text normalises to an empty string (which never matches an
 * allowlist pattern and never reads as an error symptom).
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
 * Decide whether a console message text is matched by any allowlist pattern.
 *
 * Each allowlist entry is matched as a case-sensitive substring against the
 * message text. Substring (not regex) matching is the deliberate contract:
 * patterns stay readable in `.agentrc.json`, an operator never has to escape
 * regex metacharacters, and the decision is trivially deterministic. An empty
 * or blank pattern is ignored (it would otherwise match everything and
 * silently swallow every error).
 *
 * @param {string} text Normalised console message text.
 * @param {string[]} allowlist Inline benign-console patterns.
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
 * Build a structured finding for a single non-allowlisted console error.
 * The `id` is assigned by the caller (1-based finding index across a surface)
 * so the surrounding harness controls finding numbering across console and
 * network evidence.
 *
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
 * Filter captured console messages through the `consoleAllowlist` and emit a
 * structured finding for each non-allowlisted console error.
 *
 * Behaviour contract:
 * - A console **error** (level `error`/`severe`) whose text matches no
 *   allowlist pattern becomes exactly one finding.
 * - A console message matched by any allowlist pattern is suppressed — no
 *   finding — even when it is an error.
 * - Non-error levels (`log`, `info`, `warning`, …) are never escalated.
 * - Findings are returned in capture order; ids are assigned `F1`, `F2`, …
 *   in that order.
 *
 * @param {Array<unknown>} messages Captured console messages.
 * @param {string[]} [allowlist] `qa.consoleAllowlist` patterns.
 * @param {{ surface?: string }} [opts] Surface label for the finding.
 * @returns {object[]} Structured findings (possibly empty).
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
