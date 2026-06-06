// .agents/scripts/lib/dynamic-workflow/report-contract-core.js
/**
 * Shared markdown section contract assertions for audit report lenses.
 *
 * Individual lens modules own their report title and required section list;
 * this helper owns the invariant string-analysis mechanics.
 *
 * @module dynamic-workflow/report-contract-core
 */

/**
 * Assert that a rendered markdown report has the expected H1 title and every
 * required `##` section heading. Returns a structured result rather than
 * throwing, so callers can report precisely which sections are missing.
 *
 * Pure function — string analysis only.
 *
 * @param {string} markdown - The rendered report body.
 * @param {{ title: string, requiredSections: readonly string[] }} contract
 *   - The per-lens report contract constants.
 * @returns {{ conformant: boolean, missingSections: string[], hasTitle: boolean }}
 */
export function assertSectionsContract(markdown, { title, requiredSections }) {
  const text = typeof markdown === 'string' ? markdown : '';
  const hasTitle = new RegExp(`^#\\s+${escapeRegExp(title)}\\s*$`, 'm').test(
    text,
  );

  const missingSections = requiredSections.filter(
    (heading) =>
      !new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'm').test(text),
  );

  return {
    conformant: hasTitle && missingSections.length === 0,
    missingSections,
    hasTitle,
  };
}

export function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
