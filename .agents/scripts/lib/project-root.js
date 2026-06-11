/**
 * lib/project-root.js — side-effect-free leaf module for the repository
 * root path.
 *
 * Extracted from `config-resolver.js` (Story #3993) so the ~10 importers
 * that need only the path constant no longer transitively load the
 * stateful config subsystem (module-global caches + `.env` load side
 * effect). `config-resolver.js` re-exports this constant, so its barrel
 * surface is unchanged.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/lib/ → scripts/ → .agents/ → project root
export const PROJECT_ROOT = path.resolve(__dirname, '../../..');
