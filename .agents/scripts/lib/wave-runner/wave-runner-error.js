/**
 * Tagged error class thrown by `tick()` on **unexpected** failures only
 * (GH 5xx, malformed checkpoint, invalid input). Expected failures
 * (blocked stories, gate failures) route through `WaveTickResult`.
 *
 * Callers classify via `err.phase`: `checkpoint-missing`,
 * `checkpoint-read`, `old-shape-checkpoint`, `story-fetch`,
 * `invalid-input`.
 *
 * @module lib/wave-runner/wave-runner-error
 */
export class WaveRunnerError extends Error {
  constructor(phase, cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`[wave-runner:${phase}] ${msg}`);
    this.name = 'WaveRunnerError';
    this.phase = phase;
    this.cause = cause instanceof Error ? cause : new Error(String(cause));
  }
}
