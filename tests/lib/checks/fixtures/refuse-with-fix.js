/**
 * Fixture check — declares autoCorrect:'refuse-and-print' AND defines
 * a fix() body. The runner-integration test asserts the runner NEVER
 * invokes this fix() even when called with autoFix:true.
 *
 * The fix() body sets a module-level flag (`fixObserved`) so the test
 * can assert it remained false after the run.
 */
export const observed = { fixObserved: false };

export default {
  id: 'fixture-refuse-with-fix',
  severity: 'blocker',
  scope: ['story-close', 'retro'],
  autoCorrect: 'refuse-and-print',
  detect() {
    return {
      id: 'fixture-refuse-with-fix',
      severity: 'blocker',
      scope: 'story-close',
      summary: 'fixture refuse-and-print check with a fix body',
      fixCommand: 'echo do-not-auto-fix',
      autoCorrectable: false,
    };
  },
  fix() {
    observed.fixObserved = true;
    return { ok: true, message: 'should never run' };
  },
};
