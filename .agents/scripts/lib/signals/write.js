/**
 * `lib/signals/write.js` — re-export of `../observability/signals-writer.js`
 * so callers converge on `lib/signals/` for the write surface.
 */

export {
  appendSignal,
  forEachLine,
} from '../observability/signals-writer.js';
