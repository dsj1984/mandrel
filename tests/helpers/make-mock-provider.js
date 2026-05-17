/**
 * tests/helpers/make-mock-provider.js
 *
 * Shared mock-provider factory for orchestration unit tests.
 *
 * Many tests in this suite stub the ticketing provider passed to
 * orchestration entry points (e.g. `injectedProvider` for
 * `runEpicDeliverFinalize`, `reconcileAcceptanceSpec`,
 * `reconcileBaselinesOnEpicBranch`). Historically every test hand-rolled
 * a one-off `{ getTicket: async () => ({...}) }` object, which meant that
 * when a new gate label was added to production code (e.g.
 * `acceptance::n-a`), tests that did NOT exercise that gate started
 * failing because their hand-rolled tickets returned no `labels` array,
 * and the gate's `labels.includes(...)` check threw or behaved
 * unexpectedly.
 *
 * `makeMockProvider` centralises the safe defaults so unrelated tests
 * are insulated from new gate labels:
 *
 *   - `labels` defaults to `['acceptance::n-a']` — the canonical waiver
 *     label that lets the acceptance-spec reconciler short-circuit
 *     without scanning features. Tests that do not care about acceptance
 *     coverage inherit the waiver for free.
 *   - The returned `getTicket(id)` echoes the requested `id` and merges
 *     the resolved `labels`, `title`, and `body` into the ticket shape.
 *   - Any override key (e.g. `getTicket`, `getEpic`, `getTicketDependencies`)
 *     **replaces** the corresponding default field rather than merging
 *     into it. This is intentional: tests that need bespoke behaviour
 *     opt in by supplying their own implementation.
 *
 * See `tests/helpers/README.md` for the full contract and migration notes.
 */

const DEFAULT_LABELS = ['acceptance::n-a'];

/**
 * Build a ticketing provider double for orchestration unit tests.
 *
 * @param {object} [options]
 * @param {string[]} [options.labels=['acceptance::n-a']]
 *   Labels returned on every `getTicket` payload. Passing an explicit
 *   array (including `[]`) overrides the default — labels are not
 *   merged.
 * @param {string} [options.title='Test Ticket']
 *   Title field on the default `getTicket` payload.
 * @param {string} [options.body='']
 *   Body field on the default `getTicket` payload.
 * @param {object} [overrides]
 *   Any additional keys on the returned provider replace the default
 *   field of the same name (e.g. supplying `getTicket: customFn`
 *   discards the default implementation entirely).
 * @returns {object} A provider object suitable for `injectedProvider`.
 */
export function makeMockProvider({
  labels = DEFAULT_LABELS,
  title = 'Test Ticket',
  body = '',
  ...overrides
} = {}) {
  const resolvedLabels = Array.isArray(labels) ? [...labels] : DEFAULT_LABELS;

  const defaults = {
    async getTicket(id) {
      return {
        id,
        title,
        body,
        labels: [...resolvedLabels],
      };
    },
  };

  return { ...defaults, ...overrides };
}
