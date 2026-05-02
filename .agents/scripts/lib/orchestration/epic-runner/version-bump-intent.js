/**
 * VersionBumpIntent — Phase 0.5 snapshot for Epic Mode.
 *
 * Parses the Epic body for version-bump directives (`Release target: ...`,
 * `--segment ...`, `version target: ...`) and compares the declared intent
 * against `release.autoVersionBump` from `.agentrc.json`. When the two
 * disagree, emits a `notification` structured comment on the Epic at the
 * same emission point as the initial `epic-run-state` checkpoint.
 *
 * No-op when the Epic body and config agree (or when the Epic body declares
 * no directive at all), to avoid noise.
 */

import { postStructuredComment } from '../ticketing.js';

export const VERSION_BUMP_INTENT_MARKER =
  '<!-- notification: version-bump-intent -->';
const VERSION_BUMP_NOTIFICATION_TYPE = 'notification';

const SEGMENT_VALUES = new Set(['major', 'minor', 'patch']);

const RELEASE_TARGET_RE =
  /(?:^|\n)\s*(?:Release|Version)\s+target:\s*([^\n(]+?)(?:\s*\(\s*(major|minor|patch)\s*\))?\s*(?=\n|$)/i;
const SEGMENT_FLAG_RE = /--segment[=\s]+(major|minor|patch)\b/i;

/**
 * Parse an Epic body for version-bump intent.
 *
 * @param {string} body
 * @returns {{ hasDirective: boolean, target: string | null, segment: string | null, sources: string[] }}
 */
export function parseVersionBumpIntent(body) {
  const result = {
    hasDirective: false,
    target: null,
    segment: null,
    sources: [],
  };
  if (typeof body !== 'string' || body.length === 0) return result;

  const targetMatch = body.match(RELEASE_TARGET_RE);
  if (targetMatch) {
    const target = targetMatch[1]?.trim();
    const segment = targetMatch[2]?.toLowerCase() ?? null;
    if (target) {
      result.hasDirective = true;
      result.target = target;
      result.sources.push('release-target');
    }
    if (segment) {
      result.segment = segment;
    }
  }

  const flagMatch = body.match(SEGMENT_FLAG_RE);
  if (flagMatch) {
    result.hasDirective = true;
    const flagSegment = flagMatch[1].toLowerCase();
    // Prefer the explicit --segment flag when it disagrees with the
    // parenthetical segment from the Release target line — the mismatch
    // itself is reported via detectIntentMismatch.
    if (!result.segment) result.segment = flagSegment;
    result.sources.push('segment-flag');
    result._flagSegment = flagSegment;
  }

  return result;
}

/**
 * Compare a parsed intent against `autoVersionBump` and return the mismatch
 * verdict. The shape is deliberately small so the caller can decide whether
 * to emit a notification.
 *
 * @param {{
 *   intent: ReturnType<typeof parseVersionBumpIntent>,
 *   autoVersionBump: boolean,
 * }} args
 * @returns {{ mismatch: boolean, reason: string | null }}
 */
export function detectIntentMismatch({ intent, autoVersionBump }) {
  if (!intent?.hasDirective) {
    return { mismatch: false, reason: null };
  }

  // Disagreement A: Epic declares a release target but auto-bump is disabled.
  if (!autoVersionBump) {
    return {
      mismatch: true,
      reason:
        'Epic body declares a release-target directive, but ' +
        '`release.autoVersionBump` is `false` in `.agentrc.json`. The ' +
        'orchestrator will not bump or tag at Epic close.',
    };
  }

  // Disagreement B: segment inside `Release target: ... (X)` disagrees with
  // an explicit `--segment Y` flag on the same body.
  const flagSegment = intent._flagSegment;
  if (
    flagSegment &&
    intent.segment &&
    SEGMENT_VALUES.has(flagSegment) &&
    SEGMENT_VALUES.has(intent.segment) &&
    flagSegment !== intent.segment
  ) {
    return {
      mismatch: true,
      reason:
        `Epic body declares conflicting segments — release target says ` +
        `\`${intent.segment}\` but \`--segment ${flagSegment}\` disagrees.`,
    };
  }

  return { mismatch: false, reason: null };
}

/**
 * Build the notification body for a version-bump-intent mismatch. The
 * sub-variant marker (`<!-- notification: version-bump-intent -->`) is
 * embedded in the body so the emission is discoverable and dedupable across
 * orchestrator restarts.
 *
 * @param {{
 *   intent: ReturnType<typeof parseVersionBumpIntent>,
 *   autoVersionBump: boolean,
 *   reason: string,
 * }} args
 * @returns {string}
 */
export function buildIntentNotificationBody({
  intent,
  autoVersionBump,
  reason,
}) {
  const lines = [
    VERSION_BUMP_INTENT_MARKER,
    '',
    '### ⚠️ Version-bump intent mismatch',
    '',
    reason,
    '',
    '**Parsed intent**',
    `- \`target\`: ${intent.target ? `\`${intent.target}\`` : '_none_'}`,
    `- \`segment\`: ${intent.segment ? `\`${intent.segment}\`` : '_none_'}`,
    `- \`sources\`: ${intent.sources.join(', ') || '_none_'}`,
    '',
    '**Config**',
    `- \`release.autoVersionBump\`: \`${Boolean(autoVersionBump)}\``,
    '',
    'This notification is advisory. Reconcile the Epic body with config ' +
      'before Epic close to avoid a version/tag surprise.',
  ];
  return lines.join('\n');
}

/**
 * Check version-bump intent and emit a `notification` comment when intent
 * and config disagree. Dedupes on the sub-variant marker so a resume or
 * re-run won't spam the ticket.
 *
 * @param {{
 *   provider: import('../../ITicketingProvider.js').ITicketingProvider,
 *   epicId: number,
 *   epicBody: string,
 *   autoVersionBump: boolean,
 *   logger?: { warn?: Function, info?: Function },
 * }} args
 * @returns {Promise<{
 *   checked: boolean,
 *   mismatch: boolean,
 *   emitted: boolean,
 *   reason: string | null,
 *   intent: ReturnType<typeof parseVersionBumpIntent>,
 * }>}
 */
export async function checkVersionBumpIntent({
  provider,
  epicId,
  epicBody,
  autoVersionBump,
  logger,
}) {
  const intent = parseVersionBumpIntent(epicBody ?? '');
  const { mismatch, reason } = detectIntentMismatch({
    intent,
    autoVersionBump,
  });

  if (!mismatch) {
    return { checked: true, mismatch: false, emitted: false, reason, intent };
  }

  const comments = (await provider.getTicketComments?.(epicId)) ?? [];
  const alreadyEmitted = comments.some(
    (c) =>
      typeof c?.body === 'string' &&
      c.body.includes(VERSION_BUMP_INTENT_MARKER),
  );
  if (alreadyEmitted) {
    return { checked: true, mismatch: true, emitted: false, reason, intent };
  }

  const body = buildIntentNotificationBody({
    intent,
    autoVersionBump,
    reason,
  });
  try {
    await postStructuredComment(
      provider,
      epicId,
      VERSION_BUMP_NOTIFICATION_TYPE,
      body,
    );
    return { checked: true, mismatch: true, emitted: true, reason, intent };
  } catch (err) {
    logger?.warn?.(
      `[VersionBumpIntent] notification emission failed: ${err?.message ?? err}`,
    );
    return { checked: true, mismatch: true, emitted: false, reason, intent };
  }
}
