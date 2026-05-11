/**
 * Fixture check — retro-scoped, no fix(). Used to assert the runner
 * throws synchronously on { scope: 'retro', autoFix: true } before any
 * check's detect() runs.
 *
 * `observed.detectCalled` must remain false after the throw — that is
 * the proof the throw happens at the entry guard, not mid-loop.
 */
export const observed = { detectCalled: false };

export default {
  id: 'fixture-retro-readonly',
  severity: 'info',
  scope: ['retro'],
  autoCorrect: 'refuse-and-print',
  detect() {
    observed.detectCalled = true;
    return {
      id: 'fixture-retro-readonly',
      severity: 'info',
      scope: 'retro',
      summary: 'fixture retro info',
      fixCommand: 'echo retro',
      autoCorrectable: false,
    };
  },
};
