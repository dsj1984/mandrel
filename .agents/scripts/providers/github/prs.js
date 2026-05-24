/**
 * GitHub Provider — PullRequestGateway.
 *
 * Owns `createPullRequest`. Uses `gh pr create` for the create call and
 * follows up with `gh pr view` to harvest the canonical `{number, url, id}`
 * envelope (the create stdout is just the html_url string).
 *
 * Extracted from `../github.js` in Story #2462 / Task #2479. Public
 * surface on `GitHubProvider` is unchanged — `createPullRequest`
 * delegates here.
 *
 * @see Story #2462 — Split GitHubProvider god class into seven composed gateways.
 */

import { Logger } from '../../lib/Logger.js';
import { assertStoryPrBaseAllowed } from '../../lib/orchestration/pr-base-guard.js';

export class PullRequestGateway {
  /**
   * @param {{
   *   gh: object,
   *   hooks?: {
   *     getTicket?: (id: number) => Promise<object>,
   *     addItemToProject?: (nodeId: string) => Promise<unknown>,
   *     getProjectNumber?: () => number|null,
   *   },
   * }} deps
   */
  constructor({ gh, hooks = {} } = {}) {
    this._gh = gh;
    this._hooks = hooks;
  }

  /**
   * Open a Pull Request linking `ticketId` to `branchName` against
   * `baseBranch`. Uses `gh pr create` for the create call and follows up
   * with `gh pr view` to harvest the JSON envelope (`{number, url, id}`).
   *
   * Returns `{ number, url, htmlUrl, nodeId }`.
   */
  /* node:coverage ignore next */
  async createPullRequest(branchName, ticketId, baseBranch = 'main') {
    const getTicket = this._hooks.getTicket;
    if (typeof getTicket !== 'function') {
      throw new Error(
        '[PullRequestGateway] createPullRequest requires a getTicket hook',
      );
    }
    const ticket = await getTicket(ticketId);

    // Story #2960 — refuse `--base main` (or any non-Epic branch) when
    // the ticket body declares an `Epic: #N` parent. Stand-alone Stories
    // pass through untouched.
    assertStoryPrBaseAllowed({
      storyId: ticketId,
      storyBody: ticket?.body,
      baseBranch,
    });

    const createResult = await this._gh.pr.create([
      '--title',
      ticket.title,
      '--body',
      `Closes #${ticketId}`,
      '--base',
      baseBranch,
      '--head',
      branchName,
    ]);
    const htmlUrl = (createResult?.stdout ?? '').trim();

    // `gh pr view <url> --json number,url,id` returns the canonical
    // numeric id, api url, and node id we need for the {number, url,
    // nodeId} envelope and for the Project V2 link below.
    const viewResult = await this._gh.pr.view(htmlUrl, ['number', 'url', 'id']);
    const view = JSON.parse(viewResult?.stdout ?? '{}');

    try {
      const projectNumber =
        typeof this._hooks.getProjectNumber === 'function'
          ? this._hooks.getProjectNumber()
          : null;
      if (
        projectNumber &&
        view.id &&
        typeof this._hooks.addItemToProject === 'function'
      ) {
        await this._hooks.addItemToProject(view.id);
      }
    } catch (err) {
      Logger.warn(
        `[GitHubProvider] Failed to add PR #${view.number} to project: ${err.message}`,
      );
    }

    return {
      number: view.number,
      url: view.url,
      htmlUrl,
      nodeId: view.id,
    };
  }
}
