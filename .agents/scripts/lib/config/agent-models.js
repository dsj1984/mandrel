/**
 * `delivery.routing.agentModels`: a per-role override of the `model:`
 * frontmatter default each `.agents/agents/<role>.md` declares, applied when
 * `sync-claude-agents` projects `.claude/agents/`. It never selects or changes
 * the operator's session model.
 */

/** The role-scoped agents `.agents/agents/` ships — the `agentModels` keys. */
export const ROLE_AGENT_NAMES = Object.freeze([
  'story-worker',
  'acceptance-critic',
  'plan-critic',
  'auditor',
]);

/** A model alias, a full model id, or `inherit` — shell-safe by construction. */
export const AGENT_MODEL_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]*$';

/** What an agent with no `model:` runs on: the operator's session model. */
export const INHERIT_MODEL = 'inherit';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const MODEL_LINE_RE = /^model:[^\r\n]*$/m;

/**
 * The valid overrides only: an unknown role or an unsafe value is dropped
 * (config validation already refuses both on load).
 *
 * @param {object | null | undefined} config
 * @returns {Record<string, string>}
 */
export function getAgentModels(config) {
  const raw = config?.delivery?.routing?.agentModels;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const pattern = new RegExp(AGENT_MODEL_PATTERN);
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([role, model]) =>
        ROLE_AGENT_NAMES.includes(role) &&
        typeof model === 'string' &&
        pattern.test(model),
    ),
  );
}

/**
 * The `model:` a role file's frontmatter declares, or null.
 *
 * @param {string} content
 * @returns {string|null}
 */
export function frontmatterModel(content) {
  const block = String(content ?? '').match(FRONTMATTER_RE);
  const line = block?.[1].match(MODEL_LINE_RE);
  const value = line?.[0].slice('model:'.length).trim();
  return value || null;
}

/**
 * The model a role runs on: its `agentModels` override, else its frontmatter
 * default, else `inherit`.
 *
 * @param {{ role: string, config?: object|null, content?: string }} args
 * @returns {string}
 */
export function resolveAgentModel({ role, config, content }) {
  const override = getAgentModels(config)[role];
  return override ?? frontmatterModel(content) ?? INHERIT_MODEL;
}

/**
 * Write `model` into a role file's frontmatter, replacing a declared default
 * or appending one; content without frontmatter is returned unchanged.
 *
 * @param {string} content
 * @param {string} model
 * @returns {string}
 */
export function applyAgentModel(content, model) {
  const block = content.match(FRONTMATTER_RE);
  if (!block) return content;
  const inner = MODEL_LINE_RE.test(block[1])
    ? block[1].replace(MODEL_LINE_RE, `model: ${model}`)
    : `${block[1]}\nmodel: ${model}`;
  return `---\n${inner}\n---\n${content.slice(block[0].length)}`;
}
