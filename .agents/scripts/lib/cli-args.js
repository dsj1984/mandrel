import { parseArgs } from 'node:util';

/**
 * Parse a single ticket-ID-style value. Strips an optional leading `#`,
 * coerces to a positive integer, and returns `null` for anything invalid.
 *
 * Shared by every CLI that accepts `--epic`, `--story`, `--task`, `--recut-of`,
 * or a ticket positional, so the `Number.parseInt(..., 10)` + `# ` prefix dance lives
 * in exactly one place.
 *
 * @param {string|number|null|undefined} value
 * @returns {number|null}
 */
export function parseTicketId(value) {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'number' ? String(value) : value.toString();
  const cleaned = raw.replace(/^#/, '').trim();
  if (cleaned === '') return null;
  const n = Number.parseInt(cleaned, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Standardized CLI argument parser for sprint scripts.
 * Supports options like --epic, --story, --dry-run, --skip-dashboard.
 * @param {string[]} args Array of arguments (defaults to process.argv)
 * @returns {object} Parsed and typed argument values
 */
export function parseSprintArgs(args = process.argv) {
  const { values, positionals } = parseArgs({
    args: args.slice(2),
    options: {
      epic: { type: 'string', short: 'e' },
      story: { type: 'string', short: 's' },
      'dry-run': { type: 'boolean', default: false },
      'skip-dashboard': { type: 'boolean', default: false },
      executor: { type: 'string' },
      cwd: { type: 'string' },
      'recut-of': { type: 'string' },
      resume: { type: 'boolean', default: false },
      restart: { type: 'boolean', default: false },
      'no-evidence': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const parsed = {
    epicId: parseTicketId(values.epic),
    storyId: parseTicketId(values.story),
    ticketId: null,
    dryRun: values['dry-run'] ?? false,
    skipDashboard: values['skip-dashboard'] ?? false,
    executor: values.executor ?? null,
    // Resolve worktree cwd from flag or env. Empty string/whitespace → null.
    cwd:
      (typeof values.cwd === 'string' && values.cwd.trim()) ||
      process.env.AGENT_WORKTREE_ROOT ||
      null,
    recutOf: parseTicketId(values['recut-of']),
    resume: values.resume ?? false,
    restart: values.restart ?? false,
    noEvidence: values['no-evidence'] ?? false,
  };

  parsed.ticketId =
    parseTicketId(positionals[0]) ?? parsed.storyId ?? parsed.epicId ?? null;

  return parsed;
}

const SUPPORTED_FLAG_TYPES = new Set([
  'boolean',
  'ticket',
  'integer',
  'string',
  'string-multi',
]);

function camelCase(name) {
  return name.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
}

function initialValueFor(type) {
  if (type === 'boolean') return false;
  if (type === 'string-multi') return [];
  if (type === 'ticket') return null;
  return undefined;
}

function coerceValue(type, raw) {
  if (type === 'string') return raw;
  if (type === 'ticket') return parseTicketId(raw);
  if (type === 'integer') return Number(raw);
  return raw;
}

/**
 * Declarative argv parser used by every top-level script under
 * `.agents/scripts/`. Replaces the hand-rolled `parseCliArgs` walkers that
 * the `tests/enforcement/parse-cli-args.test.js` enforcement gate forbids.
 *
 * Spec entry shape:
 *   { type, alias?, default?, envKey?, optionalValue?, short? }
 *
 *   - `type`: 'boolean' | 'ticket' | 'integer' | 'string' | 'string-multi'.
 *     'ticket' coerces via `parseTicketId` (positive int, leading `#` stripped,
 *     `null` for invalid). 'integer' coerces via `Number()` (NaN on garbage).
 *   - `alias`: output key on `values`. Defaults to camel-cased flag name.
 *   - `default`: applied when no value was provided AND no envKey produced
 *     one. For 'ticket' the default fires when the parsed value is null.
 *   - `envKey`: env-var fallback, used only when the flag is absent and the
 *     env value is a non-empty string.
 *   - `optionalValue`: value to assign when the flag is present without a
 *     value (i.e. EOF or the next token is another `--flag`).
 *   - `short`: single-char short flag (e.g. `-h`).
 *
 * @param {Record<string, object>} spec
 * @param {string[]} args  argv slice (no `process` / script entries)
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ values: Record<string, any>, positionals: string[] }}
 */
export function defineFlags(spec, args = [], opts = {}) {
  for (const [name, def] of Object.entries(spec)) {
    if (!SUPPORTED_FLAG_TYPES.has(def.type)) {
      throw new Error(
        `defineFlags: unsupported type "${def.type}" for flag "${name}"`,
      );
    }
  }

  const env = opts.env ?? process.env;
  const values = {};
  const keyOf = {};
  for (const [name, def] of Object.entries(spec)) {
    const key = def.alias ?? camelCase(name);
    keyOf[name] = key;
    values[key] = initialValueFor(def.type);
  }

  const shortMap = {};
  for (const [name, def] of Object.entries(spec)) {
    if (def.short) shortMap[def.short] = name;
  }

  const positionals = [];
  let i = 0;
  while (i < args.length) {
    const tok = args[i];
    if (typeof tok !== 'string') {
      i += 1;
      continue;
    }
    if (tok === '--') {
      for (let j = i + 1; j < args.length; j += 1) positionals.push(args[j]);
      break;
    }

    let flagName = null;
    let inlineValue = null;
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq >= 0) {
        flagName = tok.slice(2, eq);
        inlineValue = tok.slice(eq + 1);
      } else {
        flagName = tok.slice(2);
      }
    } else if (tok.startsWith('-') && tok.length > 1) {
      const candidate = shortMap[tok.slice(1)];
      if (candidate) flagName = candidate;
    }

    if (!flagName) {
      positionals.push(tok);
      i += 1;
      continue;
    }
    const def = spec[flagName];
    if (!def) {
      i += 1;
      continue;
    }
    const key = keyOf[flagName];

    if (def.type === 'boolean') {
      values[key] = true;
      i += 1;
      continue;
    }

    let raw;
    if (inlineValue !== null) {
      raw = inlineValue;
      i += 1;
    } else {
      const next = args[i + 1];
      const missing =
        next === undefined ||
        (typeof next === 'string' && next.startsWith('--'));
      if (missing) {
        if (def.optionalValue !== undefined) {
          values[key] = def.optionalValue;
        }
        i += 1;
        continue;
      }
      raw = next;
      i += 2;
    }

    if (def.type === 'string-multi') {
      values[key] = [...(values[key] ?? []), raw];
    } else {
      values[key] = coerceValue(def.type, raw);
    }
  }

  for (const [name, def] of Object.entries(spec)) {
    if (!def.envKey) continue;
    const envRaw = env?.[def.envKey];
    if (typeof envRaw !== 'string' || envRaw.length === 0) continue;
    const key = keyOf[name];
    const cur = values[key];
    let absent;
    if (def.type === 'ticket') absent = cur === null;
    else if (def.type === 'string-multi') absent = cur.length === 0;
    else absent = cur === undefined;
    if (!absent) continue;
    if (def.type === 'string-multi') {
      values[key] = [envRaw];
    } else {
      values[key] = coerceValue(def.type, envRaw);
    }
  }

  for (const [name, def] of Object.entries(spec)) {
    if (!('default' in def)) continue;
    const key = keyOf[name];
    const cur = values[key];
    const absent = def.type === 'ticket' ? cur === null : cur === undefined;
    if (absent) values[key] = def.default;
  }

  return { values, positionals };
}
