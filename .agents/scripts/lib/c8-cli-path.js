/**
 * Resolves c8's CLI entry point so callers can spawn it via
 * `process.execPath <c8Cli>` (shell:false) instead of routing through
 * the `npx.cmd` shim, which would force shell:true under
 * CVE-2024-27980's .cmd/.bat policy and re-open CWE-78.
 *
 * `bin/c8.js` is not exported from c8's package.json, so the lookup
 * goes through `package.json` (always in the exports map) and
 * `path.join` to its sibling bin file.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

export const C8_CLI = path.join(
  path.dirname(require.resolve('c8/package.json')),
  'bin',
  'c8.js',
);
