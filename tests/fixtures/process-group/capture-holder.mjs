/**
 * A coverage capture holding the full-suite lock (Story #5377, AC-1): runs
 * the real `runCapture` behind the real `lockedCapture` in `cwd`, whose
 * `test:coverage` script is `suite-tree.mjs`.
 */
import { runCapture } from '../../../.agents/scripts/lib/coverage-capture.js';
import { lockedCapture } from '../../../.agents/scripts/lib/full-suite-lock.js';

const [cwd] = process.argv.slice(2);
const code = await lockedCapture(runCapture, {})({ cwd });
process.exit(code);
