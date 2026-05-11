/**
 * Fixture check — epic-deliver scope only. Always fires a warning finding.
 * Paired with scope-story.js to prove the scope filter excludes
 * non-matching checks.
 */
export default {
  id: 'fixture-scope-epic',
  severity: 'warning',
  scope: ['epic-deliver'],
  autoCorrect: 'refuse-and-print',
  detect() {
    return {
      id: 'fixture-scope-epic',
      severity: 'warning',
      scope: 'epic-deliver',
      summary: 'fixture epic-deliver warning',
      fixCommand: 'echo epic-deliver',
      autoCorrectable: false,
    };
  },
};
