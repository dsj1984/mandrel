/**
 * Fixture check — story-close scope only. Always fires a blocker finding.
 * Used by runner-integration.test.js to assert the scope filter only
 * dispatches story-close checks under scope='story-close'.
 */
export default {
  id: 'fixture-scope-story',
  severity: 'blocker',
  scope: ['story-close'],
  autoCorrect: 'refuse-and-print',
  detect() {
    return {
      id: 'fixture-scope-story',
      severity: 'blocker',
      scope: 'story-close',
      summary: 'fixture story-close blocker',
      fixCommand: 'echo story-close',
      autoCorrectable: false,
    };
  },
};
