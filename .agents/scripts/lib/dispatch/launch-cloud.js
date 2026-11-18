/**
 * The `claude-cloud` launch target: fire a Claude Code routine so a Story's
 * delivery runs in an Anthropic-hosted session. The routine token is read
 * from the environment variable the entry names and never leaves the request
 * headers: every error, record and comment is built without it.
 *
 * @module lib/dispatch/launch-cloud
 */

const ROUTINES_BASE = 'https://api.anthropic.com/v1/claude_code/routines';
const REDACTED = '[redacted]';

/** A refused or unconfirmed fire; `keepLabel` when the session may exist. */
export class CloudLaunchError extends Error {
  /**
   * @param {string} reason
   * @param {string} detail
   * @param {{ keepLabel?: boolean, status?: number, retryAfter?: string|null }} [extra]
   */
  constructor(reason, detail, { keepLabel = false, ...extra } = {}) {
    super(detail);
    this.reason = reason;
    this.keepLabel = keepLabel;
    Object.assign(this, extra);
  }
}

/**
 * The fire request for one Story.
 *
 * @param {{ routine: string }} environment
 * @param {number} storyId
 * @param {string} token
 * @returns {{ url: string, method: string, headers: Record<string, string>, body: string }}
 */
function fireRequest(environment, storyId, token) {
  return {
    url: `${ROUTINES_BASE}/${environment.routine}/fire`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'experimental-cc-routine-2026-04-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: `mandrel-deliver ${storyId}` }),
  };
}

/**
 * The envelope fields a failed fire reports.
 *
 * @param {CloudLaunchError} err
 * @returns {{ reason: string, detail: string, status?: number, retryAfter?: string|null }}
 */
export function cloudEnvelopeFields(err) {
  const fields = { reason: err.reason, detail: err.message };
  if (err.status !== undefined) fields.status = err.status;
  if (err.reason === 'rate-limited') fields.retryAfter = err.retryAfter;
  return fields;
}

/** The request `--dry-run` prints: the Authorization value redacted. */
export function describeFireRequest(environment, storyId) {
  const request = fireRequest(environment, storyId, '');
  return {
    ...request,
    headers: { ...request.headers, Authorization: REDACTED },
  };
}

const scrub = (text, token) => String(text ?? '').replaceAll(token, REDACTED);

async function send(fetchImpl, request, token) {
  const { url, ...init } = request;
  try {
    return await fetchImpl(url, init);
  } catch (err) {
    throw new CloudLaunchError(
      'launch-unconfirmed',
      `The fire request got no response (${scrub(err?.message, token)}); ` +
        'check the routine for a new session before dispatching again.',
      { keepLabel: true },
    );
  }
}

function refused(response) {
  if (response.status === 429) {
    const retryAfter = response.headers?.get?.('retry-after') ?? null;
    return new CloudLaunchError(
      'rate-limited',
      `The routine refused the fire (429); retry after ${retryAfter ?? 'an unstated delay'}.`,
      { status: 429, retryAfter },
    );
  }
  return new CloudLaunchError(
    'launch-failed',
    `The routine refused the fire (HTTP ${response.status}).`,
    { status: response.status },
  );
}

async function sessionOf(response) {
  try {
    const json = await response.json();
    if (json?.claude_code_session_url) return json;
  } catch {
    // An unreadable success body is handled below like a missing field.
  }
  throw new CloudLaunchError(
    'launch-unconfirmed',
    'The routine accepted the fire but returned no session URL; check its sessions.',
    { keepLabel: true },
  );
}

/**
 * Fire the environment's routine for a Story, once (the endpoint has no
 * idempotency key), and post the session URL on the Story.
 *
 * @param {{ storyId: number, environment: object,
 *   provider: { postComment: Function } }} args
 * @param {{ fetchImpl?: typeof fetch, env?: Record<string, string|undefined>,
 *   now?: () => Date }} [deps]
 * @returns {Promise<object>} The dispatch record.
 * @throws {CloudLaunchError}
 */
export async function launchCloud(
  { storyId, environment, provider },
  { fetchImpl = fetch, env = process.env, now = () => new Date() } = {},
) {
  const token = env[environment.tokenEnv];
  if (!token) {
    throw new CloudLaunchError(
      'offline',
      `Environment variable ${environment.tokenEnv} is not set.`,
    );
  }
  const response = await send(
    fetchImpl,
    fireRequest(environment, storyId, token),
    token,
  );
  if (!response.ok) throw refused(response);
  const session = await sessionOf(response);
  await provider.postComment(storyId, {
    body: `Dispatched to environment \`${environment.name}\` (claude-cloud): ${session.claude_code_session_url}`,
  });
  return {
    storyId,
    environment: environment.name,
    startedAt: now().toISOString(),
    sessionId: session.claude_code_session_id ?? null,
    sessionUrl: session.claude_code_session_url,
  };
}
