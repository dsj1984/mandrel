/**
 * Detectors barrel (Epic #1721 / Story #1771 / Task #1774).
 *
 * Single import surface for every signal detector. Future detector
 * Stories (hotspot in #1773, retry in #1775) re-export from here so
 * callers (`lib/observability/perf-aggregator.js`, future emission
 * orchestrators) only ever import from one place.
 *
 * @module lib/signals/detectors
 */

export { detectRework } from './rework.js';
