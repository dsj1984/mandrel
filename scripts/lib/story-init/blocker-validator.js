/**
 * blocker-validator.js — Stage 3 of the story-init pipeline.
 *
 * Parses `blocked by #N` references from the Story body and verifies each
 * one is resolved (labelled `agent::done` or GitHub state `closed`).
 * Verification failures are treated as blocking so agents never proceed
 * past a dependency whose state is unknown.
 */

import { parseBlockedBy } from '../dependency-parser.js';
import { STATE_LABELS } from '../orchestration/ticketing.js';

/**
 * @param {object} deps
 * @param {object} deps.provider
 * @param {object} [deps.logger]
 * @param {object} deps.input
 * @param {string} deps.input.body        Story body to parse.
 * @returns {Promise<{ openBlockers: Array<{id:number,title:string,state:string,fetchError?:boolean}> }>}
 */
export async function validateBlockers({ provider, logger, input }) {
  const { body } = input;
  const progress = logger?.progress ?? (() => {});

  const blockedBy = parseBlockedBy(body);
  if (blockedBy.length === 0) return { openBlockers: [] };

  progress(
    'BLOCKERS',
    `Checking ${blockedBy.length} dependency/dependencies...`,
  );

  const results = await Promise.all(
    blockedBy.map(async (depId) => {
      try {
        const dep = await provider.getTicket(depId);
        const isDone =
          dep.labels.includes(STATE_LABELS.DONE) || dep.state === 'closed';
        if (!isDone) {
          const currentState =
            dep.labels.find((l) => l.startsWith('agent::')) ??
            'no agent:: label';
          return { id: depId, title: dep.title, state: currentState };
        }
        return null;
      } catch (err) {
        return {
          id: depId,
          title: '(fetch failed)',
          state: err.message,
          fetchError: true,
        };
      }
    }),
  );

  const openBlockers = results.filter((b) => b !== null);

  const fetchErrors = openBlockers.filter((b) => b.fetchError);
  if (fetchErrors.length > 0) {
    progress(
      'BLOCKERS',
      `⚠️ Could not verify ${fetchErrors.length} blocker(s) (network/API error): ${fetchErrors.map((b) => `#${b.id}`).join(', ')}. Treating as blocking until verified.`,
    );
  }

  return { openBlockers };
}
