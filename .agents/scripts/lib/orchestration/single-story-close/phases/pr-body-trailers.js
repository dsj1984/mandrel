/**
 * pr-body-trailers.js — lift consumer-declared git trailers from the Story
 * branch commits into the PR body (Story #5875). Parses the messages close
 * already read; never spawns git.
 */

import { getPullRequestDelivery } from '../../../config/pull-request.js';
import { Logger } from '../../../Logger.js';

/**
 * The final paragraph's `<Key>: <value>` lines, keyed lower-case — git's
 * trailer block, read from the message already in hand.
 *
 * @param {string} message
 * @returns {Map<string, string>}
 */
function parseTrailers(message) {
  const paragraphs = message.trim().split(/\n\s*\n/);
  const trailers = new Map();
  if (paragraphs.length < 2) return trailers;
  for (const line of paragraphs.at(-1).split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/.exec(line);
    if (match && match[2].trim()) {
      trailers.set(match[1].toLowerCase(), match[2].trim());
    }
  }
  return trailers;
}

/**
 * Each `delivery.pullRequest.bodyTrailers` key's value from the LAST commit
 * that carries it; a key no commit carries is skipped and named on one info
 * line. A non-empty result opens with the blank separator line.
 *
 * @param {{ commitMessages: string[], config?: object,
 *   logger?: { info: Function } }} args
 * @returns {string[]} `<Key>: <value>` lines in declaration order.
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
