// lib/migrations/steps/2.84.0-hoist-system-prompt-block.js
/**
 * Move an already-appended Mandrel system-prompt block to the top of
 * AGENTS.md (after a leading H1) and upgrade it to carry the prose read
 * directive. Codex stops reading AGENTS.md at `project_doc_max_bytes` and
 * expands no `@` imports, so a block appended to a long file never loads
 * there. Shares the bootstrap placement contract.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

import {
  hoistSystemPromptBlock,
  needsSystemPromptHoist,
} from '../../../.agents/scripts/lib/bootstrap/agents-md-fold.js';

const ENTRY_DOC = 'AGENTS.md';

/**
 * @param {{ projectRoot?: string }} [ctx]
 * @param {typeof nodeFs} fsImpl
 * @returns {string | null} AGENTS.md text, or null when absent.
 */
function readEntryDoc(ctx, fsImpl) {
  const target = path.join(ctx?.projectRoot ?? process.cwd(), ENTRY_DOC);
  try {
    return fsImpl.readFileSync(target, 'utf8');
  } catch {
    return null;
  }
}

export const hoistSystemPromptBlockStep = {
  version: '2.84.0',
  description:
    'move the AGENTS.md system-prompt block to the top and add the read ' +
    'directive for hosts without @-imports (Story #5655)',
  /**
   * @param {{ projectRoot?: string, fs?: typeof nodeFs }} [ctx]
   * @param {typeof nodeFs} [fsImpl]
   * @returns {boolean}
   */
  detect(ctx, fsImpl = ctx?.fs ?? nodeFs) {
    const text = readEntryDoc(ctx, fsImpl);
    return text !== null && needsSystemPromptHoist(text);
  },
  /**
   * @param {{ projectRoot?: string, fs?: typeof nodeFs }} [ctx]
   * @param {typeof nodeFs} [fsImpl]
   * @returns {void}
   */
  apply(ctx, fsImpl = ctx?.fs ?? nodeFs) {
    const text = readEntryDoc(ctx, fsImpl);
    if (text === null) return;
    const next = hoistSystemPromptBlock(text);
    if (next === text) return;
    fsImpl.writeFileSync(
      path.join(ctx?.projectRoot ?? process.cwd(), ENTRY_DOC),
      next,
      'utf8',
    );
  },
};
