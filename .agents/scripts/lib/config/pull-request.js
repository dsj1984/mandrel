/**
 * `delivery.pullRequest`. `bodyTrailers` names git-trailer keys close lifts
 * from the branch commits into the PR body, for a consumer whose required
 * check reads a body line. Empty (the default) leaves the body unchanged.
 */

export const TRAILER_KEY_PATTERN = '^[A-Za-z][A-Za-z0-9-]*$';

export const PULL_REQUEST_DELIVERY_DEFAULTS = Object.freeze({
  bodyTrailers: Object.freeze([]),
});

const TRAILER_KEY_RE = new RegExp(TRAILER_KEY_PATTERN);

/**
 * Accepts the full config, the `delivery` bag, or the `pullRequest` bag. An
 * entry that is not a valid trailer key is dropped.
 *
 * @param {object | null | undefined} config
 * @returns {{ bodyTrailers: string[] }}
 */
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
