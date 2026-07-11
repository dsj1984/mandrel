/**
 * Detectors barrel (Epic #1721 / Story #1771 / Task #1774).
 *
 * Single import surface for every signal detector. Detector Stories
 * (rework in #1771, retry in #1768) re-export from here so callers
 * (`lib/orchestration/detectors-phase.js`) only ever import from one
 * place. The Epic #1769 hotspot detector was retired in the Epic #4406
 * signal-contract cutover (no live emitter, no consumer).
 *
 * @module lib/signals/detectors
 */

export { detectRetry } from './retry.js';
export { detectRework } from './rework.js';
