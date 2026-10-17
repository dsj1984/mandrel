/**
 * The CLIs each inline review provider can run on, in preference order —
 * the one source both the `llm-review` provider (its probe order) and the
 * doctor's `llm-review-provider` check read. Node built-ins only: doctor
 * cannot import the provider registry, which pulls in the config resolver.
 */
const clis = {
  'code-review': ['claude'],
  'security-review': ['claude'],
  codex: ['codex'],
  'llm-review': ['claude', 'codex'],
};

for (const order of Object.values(clis)) Object.freeze(order);

/** @type {Readonly<Record<string, ReadonlyArray<string>>>} */
export const REVIEW_PROVIDER_CLIS = Object.freeze(clis);
