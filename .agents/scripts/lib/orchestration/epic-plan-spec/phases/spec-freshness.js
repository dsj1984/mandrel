/**
 * phases/spec-freshness.js — Tech Spec freshness check phase.
 *
 * Cross-validates the authored Tech Spec body against the base branch and
 * surfaces any stale path-shaped references on the Epic (Story #4324: the
 * Tech Spec is folded into the Epic body, so the Epic is the comment
 * target). Two side effects, both best-effort and non-blocking:
 *
 *   1. Write the full `{ stale, fresh, ambiguous }` report to
 *      `<tempRoot>/epic-<id>-spec-freshness.json` so downstream tooling
 *      (the `--code-freshness` health check on the roadmap, or an
 *      operator inspecting the run) can read it without re-probing git.
 *   2. When `stale.length > 0`, upsert a `spec-freshness` structured
 *      comment on the Epic listing each suspect citation.
 *      The comment is upserted, so re-running spec re-renders the same
 *      comment in place rather than spamming the issue.
 *
 * Caller signals are aggressive in containment — any error in this path
 * is downgraded to a warning. Phase 7 must not fail because a doc-author
 * cited a path the validator can't probe (e.g. shallow clone, base ref
 * not fetched). The non-blocking contract is the load-bearing AC.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Logger } from '../../../Logger.js';
import {
  renderSpecFreshnessComment,
  validateSpecFreshness,
} from '../../spec-freshness.js';
import { upsertStructuredComment } from '../../ticketing.js';

/**
 * @param {object} opts
 * @param {number} opts.epicId
 * @param {string} opts.techSpecContent
 * @param {string} opts.baseBranchRef
 * @param {string} opts.tempRoot
 * @param {import('../../../ITicketingProvider.js').ITicketingProvider} opts.provider
 * @param {Function} [opts.validator] - Testing seam (defaults to validateSpecFreshness).
 * @param {Function} [opts.commentUpserter] - Testing seam (defaults to upsertStructuredComment).
 * @param {Function} [opts.fileWriter] - Testing seam (defaults to fs writeFile/mkdir wrapper).
 * @returns {Promise<{ stale: number, ambiguous: number, fresh: number, reportPath: string|null, commentPosted: boolean }>}
 */
export async function runSpecFreshnessCheck({
  epicId,
  techSpecContent,
  baseBranchRef,
  tempRoot,
  provider,
  validator = validateSpecFreshness,
  commentUpserter = upsertStructuredComment,
  fileWriter = async (filePath, body) => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body, 'utf8');
  },
}) {
  try {
    const report = validator(techSpecContent, { baseBranchRef });
    const reportPath = path.join(
      tempRoot,
      `epic-${epicId}-spec-freshness.json`,
    );
    const payload = {
      epicId,
      baseBranchRef,
      generatedAt: new Date().toISOString(),
      summary: {
        stale: report.stale.length,
        ambiguous: report.ambiguous.length,
        fresh: report.fresh.length,
      },
      ...report,
    };
    await fileWriter(reportPath, `${JSON.stringify(payload, null, 2)}\n`);

    let commentPosted = false;
    if (report.stale.length > 0 && Number.isFinite(epicId)) {
      const body = renderSpecFreshnessComment(report, {
        baseBranchRef,
        epicId,
      });
      await commentUpserter(provider, epicId, 'spec-freshness', body);
      commentPosted = true;
    }

    if (report.stale.length > 0 || report.ambiguous.length > 0) {
      Logger.warn(
        `[epic-plan-spec] Tech Spec freshness: ${report.stale.length} stale, ${report.ambiguous.length} ambiguous, ${report.fresh.length} fresh against ${baseBranchRef}. Report: ${reportPath}.`,
      );
    } else {
      Logger.info(
        `[epic-plan-spec] Tech Spec freshness: ${report.fresh.length} fresh references against ${baseBranchRef}. No drift detected.`,
      );
    }

    return {
      stale: report.stale.length,
      ambiguous: report.ambiguous.length,
      fresh: report.fresh.length,
      reportPath,
      commentPosted,
    };
  } catch (err) {
    Logger.warn(
      `[epic-plan-spec] Tech Spec freshness check skipped: ${err.message}`,
    );
    return {
      stale: 0,
      ambiguous: 0,
      fresh: 0,
      reportPath: null,
      commentPosted: false,
      error: err.message,
    };
  }
}
