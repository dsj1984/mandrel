/**
 * `lib/signals/` barrel (Epic #1181 / Story #1438 / Task #1459).
 *
 * Consumers do `import { read, schema } from './lib/signals/index.js'`
 * (or `import * as signals from './lib/signals/index.js'`) so a future
 * shape migration only has to touch this file.
 *
 * `buildSpanTree` is a placeholder — Story s-signals-viewer will land
 * the trace-span tree builder; until then the export is a stub that
 * throws so accidental callers fail loudly rather than silently
 * producing an empty tree.
 *
 * @module lib/signals
 */

import { read } from './read.js';
import * as schema from './schema.js';

/**
 * Placeholder for the trace-span-tree builder (Story s-signals-viewer).
 * Throws so callers can detect that the implementation has not yet
 * landed — silent no-ops here would mask wave-2 rollout issues.
 *
 * @returns {never}
 */
function buildSpanTree() {
  throw new Error(
    'signals.buildSpanTree: not yet implemented (lands in Story s-signals-viewer)',
  );
}

export { buildSpanTree, read, schema };
