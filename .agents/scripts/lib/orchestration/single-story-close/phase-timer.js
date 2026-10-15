import { Logger } from '../../Logger.js';

const progress = Logger.createProgress('single-story-close', { stderr: true });

/**
 * Wall-clock seconds per named phase; each transition logs the phase it ends.
 * Overlapping work `pause`s the clock and `record`s its own time.
 *
 * @param {() => number} [nowMs]
 */
export function createPhaseTimer(nowMs = Date.now) {
  const durations = {};
  let current = null;
  let since = 0;
  const record = (phase, ms) => {
    const seconds = Math.round(Math.max(0, ms) / 100) / 10;
    durations[phase] = (durations[phase] ?? 0) + seconds;
    progress('TIMING', `⏱  ${phase}: ${seconds}s`);
  };
  const end = () => {
    if (current === null) return;
    record(current, nowMs() - since);
    current = null;
  };
  return {
    enter(phase) {
      end();
      if (phase === 'init') return;
      current = phase;
      since = nowMs();
    },
    record,
    pause: end,
    finish() {
      end();
      return Object.keys(durations).length > 0 ? { ...durations } : null;
    },
    stamp(terminal) {
      const phaseDurations = this.finish();
      if (phaseDurations) terminal.phaseDurations = phaseDurations;
    },
  };
}
