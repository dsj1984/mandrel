/**
 * source-classifier.js — pure classifier that tags a friction signal
 * record as either `"framework"` (the Mandrel framework itself) or
 * `"consumer"` (the host project that consumes the framework via the
 * materialized `.agents/` directory).
 *
 * Used by `signals-writer.js#appendSignal` so every
 * record in `temp/run-<id>/stories/story-<sid>/signals.ndjson` carries an
 * authoritative `source` field, allowing downstream retro consumers to
 * route framework signals back to mandrel and keep consumer signals in
 * the host project (Epic #2547 / Story #2553).
 *
 * Heuristic (Tech Spec #2550):
 *   - A signal is `"framework"` when its `failingPath` or `command`
 *     mentions any path under the framework's own surface area:
 *       - `.agents/`
 *       - `.agentrc.json`
 *       - `.claude/`
 *       - `node .agents/scripts/`
 *   - Anything else (or empty input) defaults to `"consumer"`. The default
 *     is intentional — most friction comes from consumer code touching
 *     framework tooling, and we'd rather under-tag than mis-route a
 *     consumer signal into the framework retro stream.
 *
 * The classifier is pure: no I/O, no logging, no throws on weird input.
 * Callers (the writer) are responsible for swallowing classifier-level
 * faults — but the only way this function can throw is via a programmer
 * error in this file, which would surface during unit testing.
 */

/**
 * Framework prefixes, in declaration order. Order is significant only
 * for documentation purposes — any one match returns `"framework"`.
 *
 * @type {readonly string[]}
 */
const FRAMEWORK_PREFIXES = Object.freeze([
  '.agents/',
  '.agentrc.json',
  '.claude/',
  'node .agents/scripts/',
]);

/**
 * Normalise a value to a string for prefix scanning. Anything that is not
 * a string (undefined, null, numbers, objects) becomes the empty string,
 * which scans clean against every framework prefix.
 *
 * @param {unknown} value
 * @returns {string}
 */
function toScanString(value) {
  if (typeof value !== 'string') return '';
  return value;
}

/**
 * Return true when `haystack` contains any framework prefix as a
 * substring. We use `includes` (not `startsWith`) because a command line
 * like `node .agents/scripts/single-story-init.js` carries the prefix in the
 * middle, and a failing-path like `repo/.agents/foo.js` may carry an
 * absolute prefix.
 *
 * @param {string} haystack
 * @returns {boolean}
 */
function containsFrameworkPrefix(haystack) {
  if (haystack.length === 0) return false;
  for (const prefix of FRAMEWORK_PREFIXES) {
    if (haystack.includes(prefix)) return true;
  }
  return false;
}

/**
 * Classify a friction signal as `"framework"` or `"consumer"`.
 *
 * Both arguments are best-effort: pass whatever the detector already has
 * (the failing file path, the failing command line, or both). When both
 * are empty / non-string, returns `"consumer"` — the safe default for
 * routing.
 *
 * Framework-wins: if either input matches a framework prefix, the result
 * is `"framework"` even when the other input looks consumer-shaped. This
 * matters for mixed cases like a consumer test invoking
 * `node .agents/scripts/single-story-init.js` — that's framework friction even
 * though the failing test path lives under the consumer.
 *
 * @param {unknown} failingPath  The path of the file or directory the
 *                               signal blames (e.g. `"tests/foo.test.js"`).
 * @param {unknown} command       The command line the signal blames
 *                                (e.g. `"node .agents/scripts/single-story-init.js"`).
 * @returns {"framework"|"consumer"}
 */
export function classifyPathSource(failingPath, command) {
  const path = toScanString(failingPath);
  const cmd = toScanString(command);
  if (containsFrameworkPrefix(path)) return 'framework';
  if (containsFrameworkPrefix(cmd)) return 'framework';
  return 'consumer';
}

export const __testing = Object.freeze({ FRAMEWORK_PREFIXES });
