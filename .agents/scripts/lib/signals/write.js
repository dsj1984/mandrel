/**
 * `lib/signals/write.js` — thin re-export of the signals/traces writer.
 *
 * The real implementation lives at `../observability/signals-writer.js`
 * (Epic #1030 / Story #1041). This module exists so callers can converge
 * on `lib/signals/` for both reads and writes — the reader barrel landed
 * in Epic #1181 / Story #1438, but the writer surface was still split
 * across `lib/observability/`. New code should `import { appendSignal }
 * from './lib/signals/index.js'` (or `'./lib/signals/write.js'` for a
 * narrower import); legacy direct imports from `lib/observability/` keep
 * working unchanged.
 */

export {
  appendSignal,
  appendTrace,
  forEachLine,
} from '../observability/signals-writer.js';
