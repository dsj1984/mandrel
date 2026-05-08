/**
 * @file planning-state-manager.js
 * Extracted state-healing and artifact idempotency logic for epic planning.
 *
 * Invariant: After planning completes, exactly ONE open PRD and ONE open
 * Tech Spec must exist as sub-issues of the Epic.  All others are closed
 * (state_reason: 'not_planned') and detached.
 */

import { Logger } from '../Logger.js';
import { concurrentMap } from '../util/concurrent-map.js';
/**
 * Snapshot of the Epic's planning-artifact state as seen / mutated by
 * {@link PlanningStateManager}. Mirrors the `epic-plan-state` structured
 * comment schema owned by `plan-checkpointer.js`, narrowed to the fields
 * this manager reads and rewrites.
 *
 * @typedef {object} PlanCheckpointState
 * @property {number} epicId                             Epic ticket id.
 * @property {{ prd: (number | null), techSpec: (number | null) }} linkedIssues  Canonical planning-artifact references persisted on the Epic.
 * @property {string} body                               Current Epic body (may include a `## Planning Artifacts` section).
 */

/**
 * Heals and de-duplicates the Epic's PRD / Tech Spec planning artifacts so
 * the post-state invariant holds: exactly ONE open PRD and ONE open Tech
 * Spec, both linked from the Epic body. All redundant artifacts are closed
 * (`state_reason: 'not_planned'`) and detached.
 */
export class PlanningStateManager {
  /**
   * @param {import('../ITicketingProvider.js').ITicketingProvider} provider  Ticketing provider used for ticket + sub-issue mutations.
   */
  constructor(provider) {
    this.provider = provider;
  }

  /**
   * Resolve existing planning artifacts and heal / clean up the graph.
   *
   * With `force=false` (normal run):
   *   - Pick the canonical PRD / Tech Spec (first open one, else first overall).
   *   - Heal dangling `epic.linkedIssues` references.
   *   - Close + detach any redundant artifacts (posting an audit-trace
   *     notification first).
   *   - Persist the healed references back to the Epic body if they were not
   *     already written.
   *
   * With `force=true` (re-plan requested): close ALL existing PRD / Tech
   * Spec artifacts, detach them, strip the `## Planning Artifacts` section
   * from the Epic body, and null out `linkedIssues` so the caller can
   * regenerate fresh artifacts.
   *
   * Mutates `epic.linkedIssues` and `epic.body` in place.
   *
   * @param {PlanCheckpointState & { linkedIssues: object, body: string, id: number }} epic  Epic ticket with mutable planning state.
   * @param {boolean} [force=false]  When true, close ALL existing artifacts and reset linkedIssues for a forced re-plan.
   * @returns {Promise<void>}
   * @throws {Error}  Propagates non-404/410 errors from `provider.updateTicket` when `force=true`. All other provider errors are intentionally swallowed.
   */
  async healAndCleanupArtifacts(epic, force = false) {
    const epicId = epic.id;
    const relatedTickets = await this.provider.getTickets(epicId);
    this.provider.primeTicketCache(relatedTickets);

    // Collect ALL planning artifacts — open AND closed — so stale
    // sub-issue links get cleaned up regardless of issue state.
    const allPrds = relatedTickets.filter((t) =>
      t.labels.includes('context::prd'),
    );
    const allSpecs = relatedTickets.filter((t) =>
      t.labels.includes('context::tech-spec'),
    );

    // Canonical artifact = first open one; fallback to first overall.
    const canonicalPrd =
      allPrds.find((t) => t.state === 'open') ?? allPrds[0] ?? null;
    const canonicalSpec =
      allSpecs.find((t) => t.state === 'open') ?? allSpecs[0] ?? null;

    // Heal linkedIssues if empty but tickets exist
    if (!epic.linkedIssues.prd && canonicalPrd?.state === 'open') {
      epic.linkedIssues.prd = canonicalPrd.id;
      Logger.info(
        `[Epic Planner] Healed dangling PRD reference: #${epic.linkedIssues.prd}`,
      );
    }
    if (!epic.linkedIssues.techSpec && canonicalSpec?.state === 'open') {
      epic.linkedIssues.techSpec = canonicalSpec.id;
      Logger.info(
        `[Epic Planner] Healed dangling Tech Spec reference: #${epic.linkedIssues.techSpec}`,
      );
    }

    // Identify redundant artifacts: everything that is NOT the canonical one.
    const canonicalPrdId = epic.linkedIssues.prd ?? canonicalPrd?.id;
    const canonicalSpecId = epic.linkedIssues.techSpec ?? canonicalSpec?.id;

    const redundant = [
      ...allPrds.filter((t) => t.id !== canonicalPrdId),
      ...allSpecs.filter((t) => t.id !== canonicalSpecId),
    ];

    // Bound the close+detach mutation burst at 3 so wide redundancy
    // cleanup does not race the GitHub secondary rate limit.
    await concurrentMap(
      redundant,
      async (t) => {
        const successorId = t.labels.includes('context::prd')
          ? canonicalPrdId
          : canonicalSpecId;
        Logger.info(
          `[Epic Planner] Cleaning up redundant artifact #${t.id} (superseded by #${successorId})...`,
        );

        // Close the issue if it's still open
        if (t.state === 'open') {
          try {
            await this.provider.postComment(t.id, {
              type: 'notification',
              body: `⚠️ **Audit Trace**: This planning artifact was created during an interrupted or failed orchestration run and is now **superseded by #${successorId}**. \n\nClosing this issue to maintain a single source of truth for Epic #${epicId}.`,
            });
          } catch (_err) {
            // Ignore comment failures
          }
          await this.provider.updateTicket(t.id, {
            state: 'closed',
            state_reason: 'not_planned',
          });
        }

        // Detach the sub-issue from the Epic to prevent orphaned links
        try {
          await this.provider.removeSubIssue(epicId, t.id);
          Logger.info(
            `[Epic Planner]   Detached #${t.id} from Epic #${epicId}.`,
          );
        } catch (_err) {
          // Already detached or API doesn't support — safe to ignore
          Logger.info(
            `[Epic Planner]   Could not detach #${t.id} (may already be detached).`,
          );
        }
      },
      { concurrency: 3 },
    );

    // Persist healed references to the body if needed.
    if (
      !force &&
      epic.linkedIssues.prd &&
      epic.linkedIssues.techSpec &&
      !epic.body.includes('## Planning Artifacts')
    ) {
      Logger.info(
        `[Epic Planner] Persisting healed references to Epic body...`,
      );
      const appendBody = `\n\n## Planning Artifacts\n- [ ] PRD: #${epic.linkedIssues.prd}\n- [ ] Tech Spec: #${epic.linkedIssues.techSpec}\n`;
      await this.provider.updateTicket(epicId, {
        body: epic.body + appendBody,
      });
      epic.body += appendBody;
    }

    // Force re-plan: close ALL old planning artifacts and strip body
    if (force) {
      const idsToClose = new Set(
        [epic.linkedIssues.prd, epic.linkedIssues.techSpec].filter(Boolean),
      );
      for (const t of [...allPrds, ...allSpecs]) {
        idsToClose.add(t.id);
      }

      if (idsToClose.size > 0) {
        Logger.info(
          '[Epic Planner] --force: Closing old planning artifacts...',
        );
        // Bound the force-close burst at 3 so wide --force re-plans do
        // not race the GitHub secondary rate limit.
        await concurrentMap(
          Array.from(idsToClose),
          async (oldId) => {
            try {
              await this.provider.updateTicket(oldId, {
                state: 'closed',
                state_reason: 'not_planned',
              });
              Logger.info(`[Epic Planner]   Closed old artifact #${oldId}`);
            } catch (err) {
              if (err.message.includes('404') || err.message.includes('410')) {
                Logger.info(
                  `[Epic Planner]   Old artifact #${oldId} was already removed or is inaccessible. Skipping.`,
                );
              } else {
                throw err;
              }
            }

            // Also detach from the Epic
            try {
              await this.provider.removeSubIssue(epicId, oldId);
            } catch (_err) {
              // Safe to ignore
            }
          },
          { concurrency: 3 },
        );
      }

      const stripped = epic.body.replace(
        /\n*## Planning Artifacts[\s\S]*$/,
        '',
      );
      if (stripped !== epic.body) {
        await this.provider.updateTicket(epicId, { body: stripped });
        epic.body = stripped;
        Logger.info(
          '[Epic Planner]   Stripped old Planning Artifacts section from Epic body.',
        );
      }

      epic.linkedIssues.prd = null;
      epic.linkedIssues.techSpec = null;
    }
  }
}
