/**
 * The coordination channel: `publish(event)` and `poll(since)` over issue
 * comments (`github-comments`, the only adapter that both reads and writes).
 * The webhook is a write-only mirror reached through `notify()`.
 */

import { notify as defaultNotify } from '../../notify.js';
import { getCoordination } from '../config/github.js';
import { redactErrorMessage } from '../error-redactor.js';
import { Logger } from '../Logger.js';
import { COORDINATION_LABEL, LABEL_COLORS } from '../label-constants.js';
import {
  findStructuredComment,
  getProviderCommentCache,
  structuredCommentCacheKey,
} from '../orchestration/ticketing/reads.js';
import { postStructuredComment } from '../orchestration/ticketing/transition.js';
import { createProvider } from '../provider-factory.js';
import {
  buildEvent,
  COMMENT_TYPE,
  decodeEventComment,
  EventRefusedError,
  encodeEventComment,
  isEventComment,
} from './event.js';
import { isTrustedComment } from './pertinence.js';

const COORDINATION_ISSUE = Object.freeze({
  title: 'Coordination channel',
  body: [
    'Coordination events that have no acting Story are posted here as comments by `coordination.js publish`.',
    '',
    `Leave this issue open: the channel posts to the lowest-numbered open issue labelled \`${COORDINATION_LABEL}\`. Readers find events wherever they were posted.`,
  ].join('\n'),
  label: {
    name: COORDINATION_LABEL,
    color: LABEL_COLORS.META,
    description:
      'Carries coordination-channel events that have no acting Story.',
  },
});

/**
 * Why a call degraded, as one redacted line.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function degradedReason(err) {
  const [line] = String(err?.message ?? err).split('\n');
  return `provider-error: ${redactErrorMessage(line).slice(0, 300)}`;
}

/**
 * @param {{ provider: object, config: object, notifyFn?: Function, now?: () => Date }} deps
 * @returns {{ adapter: string, publish: Function, publishOnce: Function, poll: Function }}
 */
export function createChannel({
  provider,
  config,
  notifyFn = defaultNotify,
  now,
}) {
  const github = config?.github ?? {};
  const { trustedAuthors } = getCoordination(config);

  /** The lowest-numbered open coordination issue, created on first need. */
  async function coordinationIssueId() {
    const { title, body, label } = COORDINATION_ISSUE;
    const open = await provider.listTicketsByLabel({
      state: 'open',
      labels: label.name,
    });
    if (open.length > 0) return Math.min(...open.map((ticket) => ticket.id));
    await provider.ensureLabels([label]);
    const created = await provider.createIssue({
      title,
      body,
      labels: [label.name],
    });
    return created.id;
  }

  /** Best-effort: the comment is the event, the webhook only mirrors it. */
  async function mirror(issueId, event) {
    const link = event.link ? ` — ${event.link}` : '';
    try {
      await notifyFn(
        issueId,
        {
          message: `coordination ${event.kind}: ${event.summary}${link}`,
          event: 'coordination',
        },
        { config, provider, skipComment: true },
      );
    } catch (err) {
      Logger.warn(
        `[coordination] webhook mirror failed: ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Validate, post one comment, then mirror. `once` posts nothing when a
   * trusted event of the same kind is already on that issue.
   *
   * @throws {import('./event.js').EventRefusedError}
   */
  async function publish(input, { once = false } = {}) {
    const event = buildEvent(input, { github, now });
    const { kind } = event;
    const issueId = event.actor.storyId ?? (await coordinationIssueId());
    if (once) {
      const prior = await findStructuredComment(
        provider,
        issueId,
        COMMENT_TYPE,
        { kind },
      );
      if (prior && isTrustedComment(prior, trustedAuthors)) {
        return { published: false, skipped: 'exists', kind, issueId };
      }
    }
    const posted = await postStructuredComment(
      provider,
      issueId,
      COMMENT_TYPE,
      encodeEventComment(event),
    );
    // A memoised miss would let a second once-only publish post again.
    getProviderCommentCache(provider).delete(
      structuredCommentCacheKey(issueId, COMMENT_TYPE, { kind }),
    );
    await mirror(issueId, event);
    return {
      published: true,
      kind,
      issueId,
      commentId: posted?.commentId ?? null,
    };
  }

  /**
   * Every trusted, valid event updated since `since`, in one repo-wide read.
   * `watermark` is the newest `updated_at` seen, the next poll's `since`.
   *
   * @param {string} since ISO timestamp, inclusive.
   */
  async function poll(since) {
    const comments = (await provider.getRepoCommentsSince(since)) ?? [];
    const events = [];
    const dropped = { untrusted: 0, invalid: 0 };
    let newest = Date.parse(since);
    for (const comment of comments) {
      const updated = Date.parse(comment?.updated_at);
      if (updated > newest) newest = updated;
      if (!isEventComment(comment?.body)) continue;
      if (!isTrustedComment(comment, trustedAuthors)) {
        dropped.untrusted += 1;
        continue;
      }
      const event = decodeEventComment(comment, github);
      if (event) events.push(event);
      else dropped.invalid += 1;
    }
    return { events, dropped, watermark: new Date(newest).toISOString() };
  }

  return {
    adapter: 'github-comments',
    publish,
    publishOnce: (input) => publish(input, { once: true }),
    poll,
  };
}

/**
 * Fail-open publish: never throws. Answers the channel's result,
 * `{ disabled: true }`, `{ refused }` for an input the envelope refuses, or
 * `{ degraded }` when the provider failed.
 *
 * @param {object} input See `buildEvent`.
 * @param {{ config: object, provider?: object, env?: NodeJS.ProcessEnv,
 *   once?: boolean, notifyFn?: Function, now?: () => Date }} opts
 * @returns {Promise<object>}
 */
export async function publishEvent(
  input,
  { config, provider, env = process.env, once = false, notifyFn, now } = {},
) {
  if (!getCoordination(config, env).enabled) return { disabled: true };
  try {
    const channel = createChannel({
      provider: provider ?? createProvider(config),
      config,
      notifyFn,
      now,
    });
    return await (once ? channel.publishOnce(input) : channel.publish(input));
  } catch (err) {
    if (err instanceof EventRefusedError) return { refused: err.message };
    return { degraded: degradedReason(err) };
  }
}
