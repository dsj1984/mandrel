/**
 * GitHub Provider — ProjectBoardGateway: threads the provider's shared
 * `_ctx` into the Projects V2 shim.
 */

import * as projects from './projects-v2-graphql.js';

export class ProjectBoardGateway {
  /**
   * @param {{ ctx: object }} deps
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
