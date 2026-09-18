/**
 * lib/project-root.js — side-effect-free leaf for the repo root, so
 * importers avoid loading the stateful config subsystem.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/lib/ → scripts/ → .agents/ → project root
export const PROJECT_ROOT = path.resolve(__dirname, '../../..');
