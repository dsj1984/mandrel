/**
 * GitHub Provider — ProjectBoardGateway.
 *
 * Owns the Projects V2 bootstrap surface: `resolveOrCreateProject`,
 * `ensureStatusField`, `ensureProjectFields`. The low-level GraphQL
 * mutations live in `./projects-v2-graphql.js`; this class threads the
 * parent provider's `_ctx` (which carries `projectNumber`, `projectOwner`,
 * `state`, and the shared cache) into each call so the legacy shim contract
 * is preserved.
 *
 * Extracted from `../github.js` in Story #2462 / Task #2479. Public
 * surface on `GitHubProvider` is unchanged — every project-board method
 * delegates here.
 *
 * @see Story #2462 — Split GitHubProvider god class into seven composed gateways.
 */

import * as projects from './projects-v2-graphql.js';

export class ProjectBoardGateway {
  /**
   * @param {{ ctx: object }} deps
   *   `ctx` is the shared `_ctx` object the parent provider builds —
   *   carries `projectOwner`, `projectName`, `projectNumber`,
   *   `operatorHandle`, `cache`, `state`, and `hooks`.
   */
  constructor({ ctx } = {}) {
    this._ctx = ctx;
  }

  async resolveOrCreateProject(opts = {}) {
    return projects.resolveOrCreateProject(this._ctx, opts);
  }

  async ensureStatusField(optionNames) {
    return projects.ensureStatusField(this._ctx, optionNames);
  }

  /* node:coverage ignore next */
  async ensureProjectFields(fieldDefs) {
    return projects.ensureProjectFields(this._ctx, fieldDefs);
  }
}
