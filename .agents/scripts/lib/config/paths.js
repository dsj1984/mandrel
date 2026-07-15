/**
 * `project.paths` accessor (Epic #1720 Story #1739 — top-level reshape).
 *
 * The seven legacy `*Root` subdirectory keys and the legacy `auditOutputDir`
 * were dropped — every `${dir}Root` is derived at runtime as
 * `${agentRoot}/<dir>`, and `auditOutputDir` is derived as `${tempRoot}/audits`.
 */

/**
 * Framework defaults for the derived path keys. `agentRoot`, `docsRoot`, and
 * `tempRoot` are schema-required (no defaults — the resolver never silently
 * fills them in); everything else is derived from the required roots and
 * exposed here so call sites that previously read e.g.
 * `paths.scriptsRoot` keep working byte-identically.
 */
export const PATHS_DEFAULTS = Object.freeze({
  agentRoot: '.agents',
  docsRoot: 'docs',
  tempRoot: 'temp',
});

/**
 * Resolve the merged `project.paths` block, deriving the legacy `*Root`
 * subdirectory keys at runtime so existing call sites keep reading the
 * same shape.
 *
 * @param {object|undefined} userPaths
 * @returns {{
 *   agentRoot: string,
 *   docsRoot: string,
 *   tempRoot: string,
 *   auditOutputDir: string,
 *   scriptsRoot: string,
 *   workflowsRoot: string,
 *   schemasRoot: string,
 *   skillsRoot: string,
 *   templatesRoot: string,
 *   rulesRoot: string,
 * }}
 */
export function resolvePaths(userPaths) {
  const paths = userPaths && typeof userPaths === 'object' ? userPaths : {};
  const agentRoot = paths.agentRoot ?? PATHS_DEFAULTS.agentRoot;
  const docsRoot = paths.docsRoot ?? PATHS_DEFAULTS.docsRoot;
  const tempRoot = paths.tempRoot ?? PATHS_DEFAULTS.tempRoot;
  return {
    agentRoot,
    docsRoot,
    tempRoot,
    // Derived: every `${dir}Root` lives directly under the framework's
    // `agentRoot`; `auditOutputDir` lives under `tempRoot/audits`.
    auditOutputDir: `${tempRoot}/audits`,
    scriptsRoot: `${agentRoot}/scripts`,
    workflowsRoot: `${agentRoot}/workflows`,
    schemasRoot: `${agentRoot}/schemas`,
    skillsRoot: `${agentRoot}/skills`,
    templatesRoot: `${agentRoot}/templates`,
    rulesRoot: `${agentRoot}/rules`,
  };
}

/**
 * Read the merged `project.paths` block. Accepts the full resolved config
 * or a bare `{ project }` bag.
 *
 * @param {object | null | undefined} config
 * @returns {ReturnType<typeof resolvePaths>}
 */
export function getPaths(config) {
  return resolvePaths(config?.project?.paths);
}
