/**
 * The one default review chain: the factory's unset/empty fallback and the
 * runtime schema's declared default. `code-review` is `optional` so hosts
 * without the `claude` CLI close on `native` alone.
 */
export const DEFAULT_REVIEW_PROVIDERS = Object.freeze([
  Object.freeze({ name: 'native' }),
  Object.freeze({
    name: 'code-review',
    scopes: Object.freeze(['story']),
    optional: true,
  }),
]);
