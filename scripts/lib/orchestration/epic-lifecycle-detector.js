/**
 * Epic-completion detection + bookend lifecycle trigger. Posts the summary
 * comment on the Epic and fires the operator webhook when every Task under
 * the Epic has landed as `agent::done`.
 */

import { notify } from '../../notify.js';
import { Logger } from '../Logger.js';
import { STATE_LABELS } from './ticketing.js';

const AGENT_DONE_LABEL = STATE_LABELS.DONE;

/**
 * Detect Epic completion and fire the bookend lifecycle.
 *
 * @param {{
 *   epicId: number,
 *   epic?: object,
 *   tasks: Array<object>,
 *   manifest: object,
 *   provider: object,
 *   dryRun: boolean,
 * }} params
 */
/* node:coverage ignore next */
export async function detectEpicCompletion({
  epicId,
  epic: _epic,
  tasks,
  manifest,
  provider,
  dryRun,
}) {
  if (tasks.length === 0) return;
  const allDone = tasks.every((t) => t.status === AGENT_DONE_LABEL);
  if (!allDone) return;

  Logger.info(
    `🎉 All Tasks under Epic #${epicId} are agent::done. Starting Bookend Lifecycle.`,
  );

  if (dryRun) {
    Logger.info('[DRY-RUN] Would post epic-complete comment and fire webhook.');
    return;
  }

  const taskLines = tasks.map((t) => `- ✅ #${t.id}: ${t.title}`).join('\n');
  const summaryComment = [
    `## 🎉 Epic #${epicId} Complete`,
    '',
    `All **${tasks.length}** tasks have been implemented and reviewed.`,
    '',
    '### Completed Tasks',
    taskLines,
    '',
    '### ⚠️ NEXT ACTIONS',
    'The dispatcher does **not** auto-run the close-tail. The operator (or a',
    'follow-up agent) must invoke:',
    '',
    `1. \`/epic-deliver ${epicId}\` — Runs close-validation, code-review, retro, merges into \`epic/${epicId}\`, and opens a PR to main.`,
    '2. After review, the operator merges the PR via the GitHub UI.',
    '',
    `> Progress: ${manifest.summary.progressPercent}% · Generated: ${manifest.generatedAt}`,
  ].join('\n');

  try {
    await provider.postComment(epicId, {
      body: summaryComment,
      type: 'notification',
    });
    Logger.info(`Posted epic-complete summary comment on Epic #${epicId}.`);
  } catch (err) {
    Logger.warn(`Failed to post epic-complete comment: ${err.message}`);
  }

  try {
    await notify(epicId, {
      severity: 'medium',
      message: `Epic #${epicId} complete. All tasks done. Bookend Lifecycle starting.`,
      event: 'epic-complete',
      level: 'epic',
      epicId,
    });
  } catch (err) {
    Logger.warn(`Webhook notification failed (non-fatal): ${err.message}`);
  }
}
