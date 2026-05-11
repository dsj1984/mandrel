/**
 * Fixture check — autoCorrect:'auto' with a successful fix(). Proves
 * the happy path: detect fires, fix runs, finding migrates to `fixed`.
 */
export const observed = { fixCalls: 0 };

export default {
  id: 'fixture-auto-fix',
  severity: 'warning',
  scope: ['story-close'],
  autoCorrect: 'auto',
  detect() {
    return {
      id: 'fixture-auto-fix',
      severity: 'warning',
      scope: 'story-close',
      summary: 'fixture auto-fix warning',
      fixCommand: 'echo auto',
      autoCorrectable: true,
    };
  },
  fix() {
    observed.fixCalls += 1;
    return { ok: true, message: 'auto-fixed' };
  },
};
