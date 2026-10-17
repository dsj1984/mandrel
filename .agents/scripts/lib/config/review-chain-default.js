/**
 * The one default review chain: the factory's unset/empty fallback and the
 * runtime schema's declared default. `llm-review` (the first available of
 * `claude` then `codex`) is `optional` so hosts with neither CLI close on
 * `native` alone.
 */
export const DEFAULT_REVIEW_PROVIDERS = Object.freeze([
  Object.freeze({ name: 'native' }),
  Object.freeze({
    name: 'llm-review',
    scopes: Object.freeze(['story']),
    optional: true,
  }),
]);
