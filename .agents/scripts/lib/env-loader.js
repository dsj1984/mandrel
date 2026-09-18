import fs from 'node:fs';
import path from 'node:path';
import { Logger } from './Logger.js';

/**
 * Quoted values are kept verbatim up to the matching quote (text after it is
 * dropped); unquoted values end at the first unescaped `#` (`\#` is a
 * literal). An unclosed quote falls through to the unquoted rule.
 *
 * @param {string} raw — the text after the `=`, unparsed.
 * @returns {string} The value with any inline comment removed.
 */
function parseEnvValue(raw) {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';

  const quote = trimmed.charAt(0);
  if (quote === '"' || quote === "'") {
    const closing = trimmed.indexOf(quote, 1);
    if (closing !== -1) return trimmed.slice(1, closing);
  }

  let value = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed.charAt(i);
    if (char === '\\' && trimmed.charAt(i + 1) === '#') {
      value += '#';
      i += 1;
      continue;
    }
    if (char === '#') break;
    value += char;
  }
  return value.trim();
}

export function loadEnv(projectRoot) {
  const envPath = path.resolve(projectRoot, '.env');
  let envContent;
  try {
    // A single read, not existsSync + read, avoids a TOCTOU race.
    envContent = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    // A missing .env is expected; anything else deserves a one-line hint.
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
      process.env[key] = parseEnvValue(match[2] || '');
    }
  });
}
