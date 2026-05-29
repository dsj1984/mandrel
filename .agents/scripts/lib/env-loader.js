import fs from 'node:fs';
import path from 'node:path';
import { Logger } from './Logger.js';

/**
 * Auto-load .env from the project root if it exists
 */
export function loadEnv(projectRoot) {
  const envPath = path.resolve(projectRoot, '.env');
  let envContent;
  try {
    // Read directly rather than existsSync + readFileSync: the latter is a
    // TOCTOU race (the file can vanish between the two calls) and double-stats
    // the path. A single read with code-based error handling is both correct
    // and cheaper.
    envContent = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    // A missing .env is the expected case — environment may be provided via
    // other means, so stay silent. Any other failure (permissions, a
    // directory in place of the file, I/O error) is worth surfacing so the
    // operator gets a one-line hint instead of an opaque silent skip.
    if (err.code !== 'ENOENT') {
      Logger.warn(
        `env-loader: failed to read ${envPath} (${err.code ?? err.message}); skipping .env load.`,
      );
    }
    return;
  }

  envContent.split('\n').forEach((line) => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) {
      const key = match[1];
      let value = (match[2] || '').trim();
      // Remove quotes if present
      if (
        value.length > 0 &&
        value.charAt(0) === '"' &&
        value.charAt(value.length - 1) === '"'
      ) {
        value = value.substring(1, value.length - 1);
      } else if (
        value.length > 0 &&
        value.charAt(0) === "'" &&
        value.charAt(value.length - 1) === "'"
      ) {
        value = value.substring(1, value.length - 1);
      }
      process.env[key] = value;
    }
  });
}
