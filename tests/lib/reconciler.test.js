import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileClosedTasks } from '../../.agents/scripts/lib/orchestration/reconciler.js';
import { MockProvider } from '../fixtures/mock-provider.js';

test('reconcileClosedTasks: does nothing if no tasks match', async () => {
  const provider = new MockProvider();
  let called = false;
  provider.updateTicket = () => {
    called = true;
  };

  await reconcileClosedTasks(
    [{ id: 1, status: 'agent::ready', labels: [] }],
    provider,
    false,
  );
  assert.strictEqual(called, false);
});

test('reconcileClosedTasks: updates ticket if status is agent::done but labels are missing', async () => {
  const provider = new MockProvider();
  let updatedId = null;
  let labelAdded = '';

  provider.updateTicket = async (id, payload) => {
    updatedId = id;
    labelAdded = payload.labels.add[0];
    return { id };
  };

  const tasks = [
    {
      id: 123,
      status: 'agent::done',
      labels: ['type::task'], // missing agent::done
    },
  ];

  await reconcileClosedTasks(tasks, provider, false);

  assert.strictEqual(updatedId, 123);
  assert.strictEqual(labelAdded, 'agent::done');
});

test('reconcileClosedTasks: bounded concurrency — never more than 4 in-flight updateTicket calls', async () => {
  const provider = new MockProvider();
  let inFlight = 0;
  let peak = 0;
  let resolveGate;
  const gate = new Promise((r) => {
    resolveGate = r;
  });

  provider.updateTicket = async () => {
    inFlight += 1;
    if (inFlight > peak) peak = inFlight;
    // Hold the in-flight count high by awaiting a shared gate so concurrentMap
    // saturates its worker pool before any item resolves.
    await gate;
    inFlight -= 1;
    return {};
  };

  const tasks = Array.from({ length: 12 }, (_, i) => ({
    id: 1000 + i,
    status: 'agent::done',
    labels: ['type::task'],
  }));

  const work = reconcileClosedTasks(tasks, provider, false);
  // Yield enough microtasks to let the bounded pool dispatch its initial wave.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  resolveGate();
  await work;

  assert.ok(
    peak <= 4,
    `peak in-flight updateTicket calls must be <= 4, observed ${peak}`,
  );
  assert.ok(peak > 1, 'expected real parallelism (peak > 1)');
});
