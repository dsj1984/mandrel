/**
 * @file planning-state-manager.js
 * Extracted state-healing and artifact idempotency logic for epic planning.
 *
 * Invariant: After planning completes, exactly ONE open PRD and ONE open
 * Tech Spec must exist as sub-issues of the Epic.  All others are closed
 * (state_reason: 'not_planned') and detached.
 */

import { Logger } from '../Logger.js';
import {
  ACCEPTANCE_NA,
  AGENT_LABELS,
  CONTEXT_LABELS,
} from '../label-constants.js';
import { concurrentMap } from '../util/concurrent-map.js';

/**
 * Snapshot of the Epic's planning-artifact state as seen / mutated by
 * {@link PlanningStateManager}. Mirrors the `epic-plan-state` structured
 * comment schema owned by `epic-plan-state-store.js`, narrowed to the fields
 * this manager reads and rewrites.
 *
 * @typedef {object} PlanCheckpointState
 * @property {number} epicId                             Epic ticket id.
 * @property {{ prd: (number | null), techSpec: (number | null), acceptanceSpec: (number | null) }} linkedIssues  Canonical planning-artifact references persisted on the Epic.
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
   * With `force=true` (re-plan requested): **overwrite the canonical
   * context tickets in place.** Keep the canonical PRD / Tech Spec /
   * Acceptance Spec **open** and keep `epic.linkedIssues` pointing at them
   * (so the caller can refresh their bodies via `provider.updateTicket`),
   * close + detach only the redundant duplicate artifacts (exactly as the
   * non-force path does), and strip the `## Planning Artifacts` section
   * from the Epic body so the caller re-appends it pointing at the same
   * preserved IDs. Context tickets are no longer closed-and-recreated on a
   * forced re-plan; only Feature/Story child tickets keep that behaviour
   * (handled outside this manager by `forceCloseExistingChildren`).
   *
   * Mutates `epic.linkedIssues` and `epic.body` in place.
   *
   * @param {PlanCheckpointState & { linkedIssues: object, body: string, id: number }} epic  Epic ticket with mutable planning state.
   * @param {boolean} [force=false]  When true, preserve canonical context tickets (overwrite-in-place) and strip the Planning Artifacts body section for a forced re-plan.
   * @returns {Promise<void>}
   * @throws {Error}  Propagates non-404/410 errors from `provider.updateTicket`. All other provider errors are intentionally swallowed.
   */
  async healAndCleanupArtifacts(epic, force = false) {
    const epicId = epic.id;
    const relatedTickets = await this.provider.getTickets(epicId);
    this.provider.primeTicketCache(relatedTickets);

    // One descriptor per planning-artifact type. Each entry parameterizes
    // the label filter, the canonical reference key on `epic.linkedIssues`,
    // and a human-readable name for the heal log line, so the per-type
    // filter / canonical / heal / successor logic runs from a single loop
    // instead of three inlined copies.
    const ARTIFACT_TYPES = [
      { label: CONTEXT_LABELS.PRD, key: 'prd', name: 'PRD' },
      { label: CONTEXT_LABELS.TECH_SPEC, key: 'techSpec', name: 'Tech Spec' },
      {
        label: CONTEXT_LABELS.ACCEPTANCE_SPEC,
        key: 'acceptanceSpec',
        name: 'Acceptance Spec',
      },
    ];

    // Resolve each artifact type: collect ALL matching tickets (open AND
    // closed) so stale sub-issue links get cleaned up regardless of state;
    // pick the canonical one (first open, else first overall); heal a
    // dangling `epic.linkedIssues` reference; and record the resolved
    // canonical id for successor resolution below.
    const resolved = ARTIFACT_TYPES.map((descriptor) => {
      const all = relatedTickets.filter((t) =>
        t.labels.includes(descriptor.label),
      );
      const canonical = all.find((t) => t.state === 'open') ?? all[0] ?? null;

      if (!epic.linkedIssues[descriptor.key] && canonical?.state === 'open') {
        epic.linkedIssues[descriptor.key] = canonical.id;
        Logger.info(
          `[Epic Planner] Healed dangling ${descriptor.name} reference: #${epic.linkedIssues[descriptor.key]}`,
        );
      }

      const canonicalId = epic.linkedIssues[descriptor.key] ?? canonical?.id;
      return { ...descriptor, all, canonicalId };
    });

    // Identify redundant artifacts: everything that is NOT the canonical one.
    const redundant = resolved.flatMap((r) =>
      r.all.filter((t) => t.id !== r.canonicalId),
    );

    // Map artifact label → resolved canonical id, for successor resolution.
    const successorByLabel = new Map(
      resolved.map((r) => [r.label, r.canonicalId]),
    );

    // Bound the close+detach mutation burst at 3 so wide redundancy
    // cleanup does not race the GitHub secondary rate limit.
    await concurrentMap(
      redundant,
      async (t) => {
        const descriptor = ARTIFACT_TYPES.find((d) =>
          t.labels.includes(d.label),
        );
        const successorId = descriptor
          ? successorByLabel.get(descriptor.label)
          : undefined;
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
          } catch (err) {
            Logger.warn(
              `[Epic Planner]   Could not post audit-trace comment on #${t.id}: ${err.message}`,
            );
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

    // Force re-plan: overwrite the canonical context tickets in place.
    // The redundant duplicates have already been closed + detached by the
    // cleanup pass above. Here we only strip the `## Planning Artifacts`
    // body section so `planEpic` re-appends it pointing at the same
    // preserved canonical IDs. We deliberately DO NOT close the canonical
    // PRD / Tech Spec / Acceptance Spec, and we keep `epic.linkedIssues`
    // pointing at them so the caller can refresh their bodies.
    if (force) {
      const stripped = epic.body.replace(
        /\n*## Planning Artifacts[\s\S]*$/,
        '',
      );
      if (stripped !== epic.body) {
        await this.provider.updateTicket(epicId, { body: stripped });
        epic.body = stripped;
        Logger.info(
          '[Epic Planner]   Stripped old Planning Artifacts section from Epic body (canonical context tickets preserved for in-place overwrite).',
        );
      }
    }
  }

  /**
   * Compute whether an Epic is ready to transition from `agent::review-spec`
   * to `agent::ready` by inspecting the state of its context tickets.
   *
   * An Epic is ready when **all three** context tickets — PRD, Tech Spec, and
   * Acceptance Spec — exist and are closed. The acceptance-spec requirement
   * can be waived by attaching the `acceptance::n-a` label to the Epic, in
   * which case acceptance-spec presence and state are ignored. Missing PRD
   * or Tech Spec is never waivable through this method.
   *
   * This predicate is **pure** with respect to the world: it reads tickets
   * via the provider and computes a verdict. Callers (e.g. the planning
   * runner) are responsible for actually flipping the label when
   * `ready === true`.
   *
   * @param {number} epicId  Epic ticket id.
   * @returns {Promise<{ ready: boolean, reason: string, contexts: { prd: ('open' | 'closed' | 'missing'), techSpec: ('open' | 'closed' | 'missing'), acceptanceSpec: ('open' | 'closed' | 'missing' | 'waived') } }>}
   *   `ready` is `true` when the Epic satisfies the readiness gate.
   *   `reason` is a machine-readable code suitable for logging / metrics
   *   (`all-context-closed`, `acceptance-waived`, `prd-missing`,
   *   `prd-open`, `tech-spec-missing`, `tech-spec-open`,
   *   `acceptance-spec-missing`, `acceptance-spec-open`).
   *   `contexts` is per-axis status for callers that want to render the
   *   verdict alongside ticket links.
   */
  async computeReviewReadiness(epicId) {
    const epic = await this.provider.getTicket(epicId);
    const relatedTickets = await this.provider.getTickets(epicId);
    this.provider.primeTicketCache(relatedTickets);

    const epicLabels = epic?.labels ?? [];
    const acceptanceWaived = epicLabels.includes(ACCEPTANCE_NA);

    const findByLabel = (label) =>
      relatedTickets.find((t) => (t.labels ?? []).includes(label)) ?? null;

    const prd = findByLabel(CONTEXT_LABELS.PRD);
    const techSpec = findByLabel(CONTEXT_LABELS.TECH_SPEC);
    const acceptanceSpec = findByLabel(CONTEXT_LABELS.ACCEPTANCE_SPEC);

    const axisStatus = (ticket) => {
      if (!ticket) return 'missing';
      return ticket.state === 'closed' ? 'closed' : 'open';
    };

    const contexts = {
      prd: axisStatus(prd),
      techSpec: axisStatus(techSpec),
      acceptanceSpec: acceptanceWaived ? 'waived' : axisStatus(acceptanceSpec),
    };

    if (contexts.prd === 'missing') {
      return { ready: false, reason: 'prd-missing', contexts };
    }
    if (contexts.prd === 'open') {
      return { ready: false, reason: 'prd-open', contexts };
    }
    if (contexts.techSpec === 'missing') {
      return { ready: false, reason: 'tech-spec-missing', contexts };
    }
    if (contexts.techSpec === 'open') {
      return { ready: false, reason: 'tech-spec-open', contexts };
    }
    if (!acceptanceWaived) {
      if (contexts.acceptanceSpec === 'missing') {
        return { ready: false, reason: 'acceptance-spec-missing', contexts };
      }
      if (contexts.acceptanceSpec === 'open') {
        return { ready: false, reason: 'acceptance-spec-open', contexts };
      }
    }

    return {
      ready: true,
      reason: acceptanceWaived ? 'acceptance-waived' : 'all-context-closed',
      contexts,
    };
  }

  /**
   * If the Epic satisfies {@link computeReviewReadiness}, flip it from
   * `agent::review-spec` to `agent::ready`. Returns the verdict plus the
   * label transition that was applied (if any). No-ops when readiness is
   * not yet satisfied — callers are expected to retry on the next planning
   * tick rather than block.
   *
   * @param {number} epicId
   * @returns {Promise<{ ready: boolean, reason: string, contexts: object, transitioned: boolean }>}
   */
  async flipEpicToReadyIfContextClosed(epicId) {
    const verdict = await this.computeReviewReadiness(epicId);
    if (!verdict.ready) {
      return { ...verdict, transitioned: false };
    }
    await this.provider.updateTicket(epicId, {
      labels: {
        add: [AGENT_LABELS.READY],
        remove: [AGENT_LABELS.REVIEW_SPEC],
      },
    });
    Logger.info(
      `[Epic Planner] Epic #${epicId} → ${AGENT_LABELS.READY} (${verdict.reason}).`,
    );
    return { ...verdict, transitioned: true };
  }
}
