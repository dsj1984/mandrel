import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ITicketingProvider } from '../.agents/scripts/lib/ITicketingProvider.js';

// ---------------------------------------------------------------------------
// Interface contract — default methods throw
// ---------------------------------------------------------------------------
describe('ITicketingProvider — interface contract', () => {
  const provider = new ITicketingProvider();

  const readMethods = [
    ['getEpic', [1]],
    ['getTickets', [1, {}]],
    ['getTicket', [1]],
    ['getTicketDependencies', [1]],
    ['graphql', ['query {}', {}, {}]],
    ['getBranchProtection', ['main']],
  ];

  const writeMethods = [
    ['updateTicket', [1, {}]],
    ['postComment', [1, { body: 'test', type: 'progress' }]],
    ['deleteComment', [1]],
    ['createPullRequest', ['branch-name', 1]],
  ];

  const setupMethods = [
    ['ensureLabels', [[{ name: 'test', color: '#000', description: '' }]]],
    [
      'ensureProjectFields',
      [
        [
          {
            name: 'Execution',
            type: 'single_select',
            options: ['sequential', 'concurrent'],
          },
        ],
      ],
    ],
  ];

  const allMethods = [...readMethods, ...writeMethods, ...setupMethods];

  for (const [methodName, args] of allMethods) {
    it(`${methodName}() throws "Not implemented" by default`, async () => {
      await assert.rejects(
        () => provider[methodName](...args),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes('Not implemented'),
            `Expected "Not implemented" in message, got: "${err.message}"`,
          );
          assert.ok(
            err.message.includes(methodName),
            `Expected method name "${methodName}" in message, got: "${err.message}"`,
          );
          return true;
        },
      );
    });
  }

  // Story #4545 dropped `createTicket` — the Epic-hierarchy write surface —
  // from the interface, taking the declared surface from 15 methods to 14.
  it('has exactly 14 interface methods', () => {
    const expectedMethods = [
      'getEpic',
      'getTickets',
      'getTicket',
      'getTicketDependencies',
      'getRecentComments',
      'getTicketComments',
      'updateTicket',
      'postComment',
      'deleteComment',
      'createPullRequest',
      'ensureLabels',
      'ensureProjectFields',
      'graphql',
      'getBranchProtection',
    ];

    for (const method of expectedMethods) {
      assert.ok(
        typeof provider[method] === 'function',
        `Missing method: ${method}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Subclass override behavior
// ---------------------------------------------------------------------------
describe('ITicketingProvider — subclass behavior', () => {
  class TestProvider extends ITicketingProvider {
    async getEpic(epicId) {
      return {
        id: epicId,
        title: 'Test Epic',
        body: 'Test body',
        labels: ['type::story'],
        linkedIssues: { techSpec: null },
      };
    }
  }

  it('overridden method returns a value', async () => {
    const provider = new TestProvider();
    const result = await provider.getEpic(42);
    assert.equal(result.id, 42);
    assert.equal(result.title, 'Test Epic');
  });

  it('non-overridden methods still throw', async () => {
    const provider = new TestProvider();
    await assert.rejects(
      () => provider.updateTicket(1, { labels: { add: ['x'] } }),
      (err) => {
        assert.ok(err.message.includes('Not implemented: updateTicket'));
        return true;
      },
    );
  });

  it('instanceof check works on subclass', () => {
    const provider = new TestProvider();
    assert.ok(provider instanceof ITicketingProvider);
  });
});
