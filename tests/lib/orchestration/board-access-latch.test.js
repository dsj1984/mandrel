/**
 * Unit tests for the board seams' access-failure latches —
 * `.agents/scripts/lib/orchestration/board-access-latch.js` (missing
 * `project` scope) and `board-graphql-latch.js` (Story #5794: a session
 * whose proxy refuses GraphQL).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { Logger } from '../../../.agents/scripts/lib/Logger.js';
import {
  boardScopeFailure,
  isProjectAccessFailure,
  resetBoardAccessLatch,
  toProjectAccessError,
} from '../../../.agents/scripts/lib/orchestration/board-access-latch.js';
import {
  boardAccessFailure,
  isBoardAccessFailure,
} from '../../../.agents/scripts/lib/orchestration/board-graphql-latch.js';
import { addIssueToBoard } from '../../../.agents/scripts/providers/github/board-add.js';

const SCOPE_ERROR =
  '[GitHubProvider] GraphQL errors: [{"type":"INSUFFICIENT_SCOPES","message":"Your token has not been granted the required scopes to execute this query."}]';

function graphqlBlocked() {
  return Object.assign(new Error('gh-exec: gh exited with code 1'), {
    stderr:
      'HTTP 403: GitHub GraphQL is not available from Claude Code sessions (https://api.github.com/graphql)',
  });
}

function sink() {
  const warned = [];
  return { warned, logger: { warn: (m) => warned.push(String(m)) } };
}

describe('board access latches', () => {
  // Latches are per sink; each case's fresh `sink()` starts unwarned.
  beforeEach(() => resetBoardAccessLatch());

  it('maps a GraphQL-blocked refusal to graphql-blocked and warns once', () => {
    const { warned, logger } = sink();
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(boardAccessFailure(graphqlBlocked(), { logger }), {
        reason: 'graphql-blocked',
      });
    }
    assert.equal(warned.length, 1);
    assert.match(warned[0], /GraphQL-only/);
    assert.match(warned[0], /cloud session/);
  });

  it('sees the refusal through a ProjectAccessError wrapper', () => {
    const wrapped = toProjectAccessError(graphqlBlocked());
    const { logger } = sink();
    assert.equal(
      boardAccessFailure(wrapped, { logger })?.reason,
      'graphql-blocked',
    );
  });

  it('a genuine missing project scope still reports insufficient-scope', () => {
    const { warned, logger } = sink();
    const err = new Error(SCOPE_ERROR);
    assert.deepEqual(boardAccessFailure(err, { logger }), {
      reason: 'insufficient-scope',
      scope: 'project',
    });
    assert.equal(warned.length, 1);
    assert.match(warned[0], /gh auth refresh -h github\.com -s project/);
  });

  it('counts a GraphQL-blocked session as a board access failure', () => {
    assert.equal(isBoardAccessFailure(graphqlBlocked()), true);
    assert.equal(isBoardAccessFailure(new Error(SCOPE_ERROR)), true);
  });

  it('leaves an unrelated failure unclassified', () => {
    const { warned, logger } = sink();
    assert.equal(boardAccessFailure(new Error('boom'), { logger }), null);
    assert.equal(boardScopeFailure(new Error('boom'), { logger }), null);
    assert.equal(isProjectAccessFailure(new Error('boom')), false);
    assert.equal(isBoardAccessFailure(new Error('boom')), false);
    assert.deepEqual(warned, []);
  });

  it('board adds report graphql-blocked with one warning across many issues', async (t) => {
    const warned = [];
    t.mock.method(Logger, 'warn', (m) => warned.push(String(m)));
    const adds = [];
    for (const n of [1, 2, 3]) {
      adds.push(
        await addIssueToBoard({
          nodeId: `node_${n}`,
          issueNumber: n,
          getProjectNumber: () => 42,
          addItemToProject: async () => {
            throw graphqlBlocked();
          },
        }),
      );
    }
    for (const add of adds) {
      assert.deepEqual(add, { added: false, reason: 'graphql-blocked' });
    }
    assert.equal(warned.length, 1, warned.join('\n'));
  });
});
