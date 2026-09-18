/**
 * A close-validation gate in flight (Story #5377, AC-4): runs `suite-tree.mjs`
 * through the real `defaultGateRunner`, so a signal to this process exercises
 * the same forwarding a signal to `single-story-close.js` does.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultGateRunner } from '../../../.agents/scripts/lib/close-validation/process.js';

const [cwd, pidFile] = process.argv.slice(2);
const tree = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'suite-tree.mjs',
);
const { status } = await defaultGateRunner(process.execPath, [tree, pidFile], {
  cwd,
  gateName: 'coverage-capture',
  log: () => {},
});
process.exit(status);
