/**
 * `lib/signals/` barrel — the one import point, so a shape migration touches
 * only this file.
 *
 * @module lib/signals
 */

import * as schema from './schema.js';
import { appendSignal, forEachLine } from './write.js';

export { appendSignal, forEachLine, schema };
