/**
 * Integration: after a `getTickets(epicId)` sweep followed by
 * `primeTicketCache`, subsequent `getTicket(childId)` calls must issue 0
 * additional HTTP requests. Protects the perf invariant behind story #561.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGh } from '../.agents/scripts/lib/gh-exec.js';
import { GitHubProvider } from '../.agents/scripts/providers/github.js';

process.env.GITHUB_TOKEN = 'mock-token';

function makeIssue(number, extraLabels = []) {
  return {
    number,
    id: 10_000 + number,
    node_id: `N_${number}`,
    title: `Issue ${number}`,
    body: `Epic: #10\n`,
    labels: [{ name: 'type::task' }, ...extraLabels.map((n) => ({ name: n }))],
    assignees: [],
    state: 'open',
  };
}

/**
 * Build a fake gh-exec for the prime-after-sweep integration. The sweep
 * endpoint (`/issues?...`) returns the canned issue list; any other call
 * throws so a regression that misroutes a getTicket fetch fails loudly.
 */
function ghForSweep(issues, calls) {
  const exec = async ({ args, input }) => {
    calls.push({ args, input });
    const endpoint = args[3] ?? '';
    // Paginated list — page=1 returns the issues, page>1 stops the loop.
    if (/\/issues\?/.test(endpoint)) {
      const pageMatch = /\bpage=(\d+)\b/.exec(endpoint);
      const page = pageMatch ? Number(pageMatch[1]) : 1;
      if (page === 1) {
        return { stdout: JSON.stringify(issues), stderr: '', code: 0 };
      }
      return { stdout: '[]', stderr: '', code: 0 };
    }
    throw new Error(`unexpected gh call to ${endpoint}`);
  };
  return createGh(exec);
}

describe('integration: primeTicketCache after getTickets sweep', () => {
  it('GitHubProvider direct: 10 getTicket reads after sweep → 0 extra HTTP calls', async () => {
    const issues = Array.from({ length: 10 }, (_, i) => makeIssue(100 + i));
    const calls = [];
    const gh = ghForSweep(issues, calls);

    const provider = new GitHubProvider(
      { owner: 'o', repo: 'r' },
      { gh, token: 'mock-token' },
    );

    const sweep = await provider.getTickets(10);
    assert.equal(sweep.length, 10);

    const afterSweep = calls.length;
    provider.primeTicketCache(sweep);

    for (const t of sweep) {
      const hit = await provider.getTicket(t.id);
      assert.equal(hit.id, t.id);
    }

    assert.equal(
      calls.length - afterSweep,
      0,
      `expected 0 extra HTTP calls after sweep+prime, got ${calls.length - afterSweep}`,
    );
  });

  // TODO(#3209): deleted — exercised `fetchTasks` (task-fetcher.js), removed
  // with the Task-tier dispatch runtime in Epic #3163 / Story #3205. The
  // GitHubProvider sweep+prime invariant above already covers the perf
  // contract this case duplicated through the Task-fetch path.
});
