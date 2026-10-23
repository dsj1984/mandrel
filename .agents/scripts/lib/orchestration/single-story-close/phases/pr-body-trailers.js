/** Lifts declared git trailers from already-read branch commits; no spawn. */

import { getPullRequestDelivery } from '../../../config/pull-request.js';
import { Logger } from '../../../Logger.js';

/** The final paragraph's `<Key>: <value>` lines, keyed lower-case. */
function parseTrailers(message) {
  const paragraphs = message.trim().split(/\n\s*\n/);
  const trailers = new Map();
  if (paragraphs.length < 2) return trailers;
  for (const line of paragraphs.at(-1).split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/.exec(line);
    if (match?.[2].trim()) {
      trailers.set(match[1].toLowerCase(), match[2].trim());
    }
  }
  return trailers;
}

/**
 * The last commit's value per declared key, led by a blank separator; a
 * missing key is logged, never invented.
 */
export function liftTrailers({ commitMessages, config, logger = Logger }) {
  const parsed = commitMessages.map(parseTrailers);
  const lines = [];
  for (const key of getPullRequestDelivery(config).bodyTrailers) {
    const carrier = parsed.findLast((t) => t.has(key.toLowerCase()));
    if (carrier) {
      lines.push(`${key}: ${carrier.get(key.toLowerCase())}`);
    } else {
      logger.info(
        `[normalize-pr-title] declared trailer "${key}" is on no branch commit; the PR body omits it.`,
      );
    }
  }
  return lines.length > 0 ? ['', ...lines] : [];
}
