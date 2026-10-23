/** `delivery.pullRequest`: trailer keys close lifts into the PR body. */

export const TRAILER_KEY_PATTERN = '^[A-Za-z][A-Za-z0-9-]*$';

export const PULL_REQUEST_DELIVERY_DEFAULTS = Object.freeze({
  bodyTrailers: Object.freeze([]),
});

const TRAILER_KEY_RE = new RegExp(TRAILER_KEY_PATTERN);

/** Accepts the full config, `delivery`, or `pullRequest`; drops bad keys. */
export function getPullRequestDelivery(config) {
  const block =
    config?.delivery?.pullRequest ?? config?.pullRequest ?? config ?? {};
  const keys = Array.isArray(block.bodyTrailers) ? block.bodyTrailers : [];
  return {
    bodyTrailers: [
      ...new Set(
        keys.filter(
          (key) => typeof key === 'string' && TRAILER_KEY_RE.test(key),
        ),
      ),
    ],
  };
}
