/**
 * `qa.gherkinLint`. Opt-in, because an upgrade lands in every consumer at
 * once and default-on would redden repos that never asked; once opted in it
 * fails closed. Each feature resolves against its own scope's step roots so
 * one app's steps cannot vouch for another's feature.
 */

const GHERKIN_LINT_DEFAULTS = Object.freeze({
  exemptionTags: Object.freeze(['@skip']),
  stepWaivers: Object.freeze([]),
});

function stringArray(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((item) => typeof item === 'string' && item.length > 0);
}

/**
 * @param {string} name
 * @param {object} raw
 * @returns {{ name: string, featureRoots: string[], stepRoots: string[] }}
 */
function normalizeScope(name, raw) {
  return {
    name,
    featureRoots: stringArray(raw?.featureRoots, []),
    stepRoots: stringArray(raw?.stepRoots, []),
  };
}

/**
 * @param {object | null | undefined} raw
 * @returns {{
 *   scopes: Array<{ name: string, featureRoots: string[], stepRoots: string[] }>,
 *   exemptionTags: string[],
 *   stepWaivers: string[],
 * } | null} `null` when the block is absent or not an object
 */
function resolveGherkinLint(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const scopesRaw =
    raw.scopes && typeof raw.scopes === 'object' && !Array.isArray(raw.scopes)
      ? raw.scopes
      : {};
  return {
    scopes: Object.keys(scopesRaw)
      .sort()
      .map((name) => normalizeScope(name, scopesRaw[name])),
    exemptionTags: stringArray(
      raw.exemptionTags,
      GHERKIN_LINT_DEFAULTS.exemptionTags,
    ),
    stepWaivers: stringArray(
      raw.stepWaivers,
      GHERKIN_LINT_DEFAULTS.stepWaivers,
    ),
  };
}

/**
 * @param {object | null | undefined} config
 * @returns {ReturnType<typeof resolveGherkinLint>}
 */
export function getGherkinLint(config) {
  return resolveGherkinLint(config?.qa?.gherkinLint);
}

export const __testing = Object.freeze({
  GHERKIN_LINT_DEFAULTS,
  resolveGherkinLint,
});
