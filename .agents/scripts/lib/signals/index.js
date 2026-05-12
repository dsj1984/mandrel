/**
 * `lib/signals/` barrel.
 *
 * Consumers do `import { read, schema, buildSpanTree } from './lib/signals/index.js'`
 * (or `import * as signals from './lib/signals/index.js'`) so a future
 * shape migration only has to touch this file.
 *
 * History:
 *   - Epic #1181 / Story #1438 / Task #1459 — initial barrel with `read`
 *     + `schema`; `buildSpanTree` was a throwing placeholder.
 *   - Epic #1181 / Story #1440 / Task #1461 — placeholder replaced by
 *     the real export from `./span-tree.js`.
 *
 * @module lib/signals
 */

import { read } from './read.js';
import * as schema from './schema.js';
import { buildSpanTree } from './span-tree.js';

export { buildSpanTree, read, schema };
