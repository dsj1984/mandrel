import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ColumnSync } from '../../.agents/scripts/lib/orchestration/column-sync.js';

/**
 * Tech spec #443 §1.1 regression guard: GitHub's GraphQL server rejects any
 * `$var` declared in the operation signature that is not referenced in the
 * query body ("variableNotUsed"). Prior to the fix, ColumnSync's
 * `#getProjectItemId` query declared `$issueId: Int!` but only used
 * `$projectId` in the body, which made the read fail and masquerade as a
 * missing project item.
 *
 * This test captures every GraphQL string ColumnSync issues and validates
 * that declared variables match referenced variables.
 */

/**
 * Extract variable names declared in the operation signature:
 * `query($a: Int!, $b: ID!)` → ['a', 'b'].
 */
function declaredVariables(query) {
  const match = query.match(/^\s*(?:query|mutation)\s*\(([^)]*)\)/);
  if (!match) return [];
  return [...match[1].matchAll(/\$(\w+)\s*:/g)].map((m) => m[1]);
}

/**
 * Extract variable *references* from the body (everything after the signature
 * paren close). Strips the signature so the declared `$foo:` doesn't count as
 * a reference to itself.
 */
function referencedVariables(query) {
  const sigEnd = query.indexOf(')');
  const body = sigEnd === -1 ? query : query.slice(sigEnd + 1);
  return new Set([...body.matchAll(/\$(\w+)/g)].map((m) => m[1]));
}

function assertAllDeclaredAreUsed(query, label) {
  const declared = declaredVariables(query);
  const referenced = referencedVariables(query);
  for (const name of declared) {
    assert.ok(
      referenced.has(name),
      `${label}: variable $${name} is declared but not referenced in the query body`,
    );
  }
}

function recordingProvider() {
  const calls = [];
  return {
    calls,
    projectNumber: 42,
    async graphql(query, vars) {
      calls.push({ query, vars });
      if (query.includes('viewer {')) {
        return {
          viewer: {
            projectV2: {
              id: 'PROJ',
              field: {
                id: 'FIELD',
                options: [{ id: 'opt-inprog', name: 'In Progress' }],
              },
            },
          },
        };
      }
      if (query.includes('items(first')) {
        return {
          node: {
            items: {
              nodes: [{ id: 'ITEM-1', content: { number: 321 } }],
            },
          },
        };
      }
      return {
        updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM-1' } },
      };
    },
  };
}

describe('shared GraphQL query builders', () => {
  it('ColumnSync emits no variableNotUsed for the loadMeta and getProjectItemId shapes', async () => {
    const provider = recordingProvider();
    const sync = new ColumnSync({ provider });
    await sync.sync(321, ['agent::executing']);

    const loadMeta = provider.calls.find((c) => c.query.includes('viewer {'));
    const getItem = provider.calls.find((c) => c.query.includes('items(first'));
    assert.ok(loadMeta, 'loadMeta query was issued');
    assert.ok(getItem, 'getProjectItemId query was issued');

    assertAllDeclaredAreUsed(loadMeta.query, 'loadMeta');
    assertAllDeclaredAreUsed(getItem.query, 'getProjectItemId');
  });

  it('declaredVariables / referencedVariables detect an unused variable', () => {
    const bad = `
      query($projectId: ID!, $issueId: Int!) {
        node(id: $projectId) { id }
      }`;
    const declared = declaredVariables(bad);
    const referenced = referencedVariables(bad);
    assert.deepEqual(declared.sort(), ['issueId', 'projectId']);
    assert.ok(referenced.has('projectId'));
    assert.ok(!referenced.has('issueId'));
  });
});
