// lib/migrations/steps/2.65.0-fold-claude-md-into-agents-md.js
/**
 * Fold a consumer's root CLAUDE.md into AGENTS.md and delete CLAUDE.md.
 * The host reads CLAUDE.md exclusively whenever it exists, so a surviving one
 * would shadow the AGENTS.md wiring. Shares the bootstrap fold contract.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

import {
  foldClaudeMdIntoAgentsMd,
  LEGACY_ENTRY_DOC,
} from '../../../.agents/scripts/lib/bootstrap/agents-md-fold.js';

export const foldClaudeMdIntoAgentsMdStep = {
  version: '2.65.0',
  description:
    'fold the root CLAUDE.md into AGENTS.md and delete it — AGENTS.md is ' +
    'now the entry doc (Story #5410)',
  /**
   * @param {{ projectRoot?: string, fs?: typeof nodeFs }} [ctx]
   * @param {typeof nodeFs} [fsImpl]
   * @returns {boolean}
   */
  detect(ctx, fsImpl = ctx?.fs ?? nodeFs) {
    const root = ctx?.projectRoot ?? process.cwd();
    return fsImpl.existsSync(path.join(root, LEGACY_ENTRY_DOC));
  },
  /**
   * @param {{ projectRoot?: string, fs?: typeof nodeFs }} [ctx]
   * @param {typeof nodeFs} [fsImpl]
   * @returns {void}
   */
  apply(ctx, fsImpl = ctx?.fs ?? nodeFs) {
    foldClaudeMdIntoAgentsMd(ctx?.projectRoot ?? process.cwd(), fsImpl);
  },
};
