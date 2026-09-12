/**
 * lib/test-isolate/progress-log.js — the `onProgress` sink for a
 * `diagnoseIsolation` run.
 *
 * Story #5316: this was an anonymous arrow inlined into `runTestIsolate`'s
 * argument list, which is exactly why it scored CRAP 72 (cyclomatic 8 at 0%
 * coverage) under a name — `<anon runTestIsolate/(stage,payload)#0>` — that no
 * test could address. As a named factory it is a plain table lookup.
 */

/** How many bisection suspects are named inline before eliding the rest. */
const SUSPECT_PREVIEW = 3;

/**
 * Per-stage line formatters. A stage with no entry here is ignored, which is
 * what the `else if` ladder this replaces did by falling off the end — so a
 * new stage emitted by the runner stays silent rather than throwing.
 */
const STAGE_LINES = {
  'isolated:start': (p) => `[test-isolate] isolated phase: ${p.count} file(s)`,
  'isolated:done': () => '[test-isolate] isolated phase: done',
  'suite:start': (p) => `[test-isolate] suite phase: ${p.count} file(s)`,
  'suite:done': () => '[test-isolate] suite phase: done',
  'bisect:start': (p) => `[test-isolate] bisecting flipper: ${p.target}`,
  'bisect:done': (p) => {
    const list = p.suspects.slice(0, SUSPECT_PREVIEW).join(', ');
    const hidden = p.suspects.length - SUSPECT_PREVIEW;
    const more = hidden > 0 ? ` (+${hidden} more)` : '';
    return `[test-isolate]   suspects: ${list}${more}`;
  },
};

/**
 * Build the progress callback `diagnoseIsolation` calls as each phase starts
 * and finishes.
 *
 * @param {(line: string) => void} onLog
 * @returns {(stage: string, payload: object) => void}
 */
export function createProgressLogger(onLog) {
  return (stage, payload) => {
    const format = STAGE_LINES[stage];
    if (format) onLog(format(payload ?? {}));
  };
}
