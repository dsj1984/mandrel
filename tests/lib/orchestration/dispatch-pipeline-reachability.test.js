// tests/lib/orchestration/dispatch-pipeline-reachability.test.js
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

const graphModuleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../../../.agents/scripts/lib/Graph.js'),
).href;

// Pull the real Graph implementation so the spy can delegate to it. Each
// imported function below is what dispatch-pipeline.js will resolve once
// we re-mock the module — we wrap `computeReachability` with a counter
// and let everything else fall through unchanged.
const realGraph = await import(graphModuleUrl);

let computeReachabilityCalls = 0;
const computeReachabilitySpy = mock.fn((...args) => {
  computeReachabilityCalls += 1;
  return realGraph.computeReachability(...args);
});

mock.module(graphModuleUrl, {
  namedExports: {
    ...realGraph,
    computeReachability: computeReachabilitySpy,
  },
});

// Import dispatch-pipeline AFTER the module mock so it resolves the spied
// `computeReachability`. dispatch-pipeline also re-exports the real
// `transitiveReduction` etc., which the spy preserves via spread.
const { buildDispatchGraph } = await import(
  '../../../.agents/scripts/lib/orchestration/dispatch-pipeline.js'
);
const { buildGraph: buildGraphReal, computeWaves: computeWavesReal } =
  realGraph;
const { autoSerializeOverlaps: autoSerializeOverlapsReal } = await import(
  '../../../.agents/scripts/lib/orchestration/concurrent-dep-resolver.js'
);

/**
 * Dense 20-node DAG fixture: 4 layers of 5 tasks, every task in layer L
 * depends on every task in layer L+1 (and one extra cross-layer edge to
 * exercise the transitive-reduction branch). Tasks include `focusAreas`
 * so the autoSerializeOverlaps phase has something to chew on.
 */
function buildDenseTasks() {
  const layers = [
    [101, 102, 103, 104, 105],
    [201, 202, 203, 204, 205],
    [301, 302, 303, 304, 305],
    [401, 402, 403, 404, 405],
  ];
  const tasks = [];
  for (let l = 0; l < layers.length; l++) {
    const lower = layers[l + 1] ?? [];
    const lower2 = layers[l + 2] ?? [];
    for (const id of layers[l]) {
      tasks.push({
        id,
        dependsOn: [...lower, ...lower2],
        focusAreas: [`layer-${l}`],
        scope: 'leaf',
      });
    }
  }
  return tasks;
}

test('dispatch-pipeline: computeReachability invoked exactly once per dispatch', () => {
  computeReachabilityCalls = 0;
  computeReachabilitySpy.mock.resetCalls();

  const tasks = buildDenseTasks();
  const { allWaves, taskMap } = buildDispatchGraph(tasks);

  assert.equal(
    computeReachabilityCalls,
    1,
    `expected computeReachability called exactly once, got ${computeReachabilityCalls}`,
  );
  assert.equal(computeReachabilitySpy.mock.callCount(), 1);
  // Sanity: waves and taskMap are well-formed.
  assert.ok(allWaves.length > 0, 'expected at least one wave');
  assert.equal(taskMap.size, tasks.length);
});

test('dispatch-pipeline: wave output is byte-identical to pre-refactor (dense fixture)', () => {
  computeReachabilityCalls = 0;

  // Reference: replicate the *pre-refactor* `buildDispatchGraph` flow
  // exactly — `buildGraph` → `autoSerializeOverlaps` (no opts) →
  // `computeWaves`. `autoSerializeOverlaps` mutates `manifest.tasks`
  // in place, so each path gets a freshly-cloned task list.
  const refTasks = cloneTasks(buildDenseTasks());
  const refGraph = buildGraphReal(refTasks);
  const refSerialized = autoSerializeOverlapsReal(
    { tasks: refTasks },
    refGraph.adjacency,
  );
  const expected = computeWavesReal(
    refSerialized.finalAdjacency,
    refGraph.taskMap,
  );

  const tasks = cloneTasks(buildDenseTasks());
  const { allWaves } = buildDispatchGraph(tasks);

  assert.equal(
    allWaves.length,
    expected.length,
    'wave count diverged from pre-refactor reference',
  );
  for (let i = 0; i < allWaves.length; i++) {
    const actualIds = allWaves[i].map((t) => t.id).sort((a, b) => a - b);
    const expectedIds = expected[i].map((t) => t.id).sort((a, b) => a - b);
    assert.deepStrictEqual(
      actualIds,
      expectedIds,
      `wave ${i} task membership diverged from pre-refactor reference`,
    );
  }
});

function cloneTasks(tasks) {
  return tasks.map((t) => ({
    ...t,
    dependsOn: [...(t.dependsOn ?? [])],
    focusAreas: [...(t.focusAreas ?? [])],
  }));
}

test('dispatch-pipeline: empty task list short-circuits without crashing', () => {
  computeReachabilityCalls = 0;
  const result = buildDispatchGraph([]);
  assert.equal(result.allWaves.length, 0);
  assert.equal(result.taskMap.size, 0);
  // Reachability is still computed once (on the empty graph) per the
  // single-pass contract.
  assert.equal(
    computeReachabilityCalls,
    1,
    'compute-once contract holds for the empty-graph edge case',
  );
});
