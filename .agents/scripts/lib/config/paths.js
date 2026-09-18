/**
 * `project.paths` accessor; every `*Root` subdirectory and `auditOutputDir`
 * is derived from `agentRoot` / `tempRoot`.
 */

export const PATHS_DEFAULTS = Object.freeze({
  agentRoot: '.agents',
  docsRoot: 'docs',
  tempRoot: 'temp',
});

/**
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
 * @param {object | null | undefined} config
 * @returns {ReturnType<typeof resolvePaths>}
 */
export function getPaths(config) {
  return resolvePaths(config?.project?.paths);
}
