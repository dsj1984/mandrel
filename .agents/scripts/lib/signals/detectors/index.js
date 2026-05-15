/**
 * Detectors barrel (Epic #1721 / Story #1771 / Task #1774).
 *
 * Single import surface for every signal detector. Detector Stories
 * (rework in #1771, retry in #1768, hotspot in #1769) re-export from
 * here so callers (`lib/observability/perf-aggregator.js`, future
 * emission orchestrators) only ever import from one place.
 *
 * @module lib/signals/detectors
 */

export { detectHotspot, nearestRankP95 } from './hotspot.js';
export { detectRetry } from './retry.js';
export { detectRework } from './rework.js';
