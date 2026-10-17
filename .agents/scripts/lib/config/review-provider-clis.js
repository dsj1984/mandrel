/** Each review provider's CLIs, in probe order. Built-ins only, for doctor. */
const clis = {
  'code-review': ['claude'],
  'security-review': ['claude'],
  codex: ['codex'],
  'llm-review': ['claude', 'codex'],
};

for (const order of Object.values(clis)) Object.freeze(order);

export const REVIEW_PROVIDER_CLIS = Object.freeze(clis);
