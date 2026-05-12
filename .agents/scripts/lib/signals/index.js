/**
 * `lib/signals/` barrel.
 *
 * Consumers do `import { read, schema, buildSpanTree, appendSignal } from './lib/signals/index.js'`
 * (or `import * as signals from './lib/signals/index.js'`) so a future
 * shape migration only has to touch this file.
 *
 * History:
 *   - Epic #1181 / Story #1438 / Task #1459 — initial barrel with `read`
 *     + `schema`; `buildSpanTree` was a throwing placeholder.
 *   - Epic #1181 / Story #1440 / Task #1461 — placeholder replaced by
 *     the real export from `./span-tree.js`.
 *   - Story #1476 — `appendSignal` / `appendTrace` / `appendEpicSignal`
 *     re-exported here via `./write.js` so the gate scripts (and any
 *     new code) converge on `lib/signals/` instead of importing the
 *     writer directly from `lib/observability/`.
 *
 * @module lib/signals
 */

import { read } from './read.js';
import * as schema from './schema.js';
import { buildSpanTree } from './span-tree.js';
import {
  appendEpicSignal,
  appendSignal,
  appendTrace,
  forEachLine,
} from './write.js';

export {
  appendEpicSignal,
  appendSignal,
  appendTrace,
  buildSpanTree,
  forEachLine,
  read,
  schema,
};
