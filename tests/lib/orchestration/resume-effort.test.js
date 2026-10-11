/**
 * resume-effort.test.js — Story #5608.
 *
 * The prior-block counter reads the Story's local signals stream through the
 * same emitter the ticket transition uses, and the ladder maps the count to
 * the Agent tool's per-call effort: 0 → null, 1 → high, ≥2 → xhigh. Driven
 * through the module's production surface only.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  emitBlockRecoveredFriction,
  emitRuntimeFriction,
  RUNTIME_FRICTION_CATEGORIES,
} from '../../../.agents/scripts/lib/observability/runtime-friction.js';
import {
  parseWorkerEffort,
  resolveResumeEffort,
  resolveRunDispatchInputs,
} from '../../../.agents/scripts/lib/orchestration/resume-effort.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

let tempRoot;
let config;

beforeEach(async () => {
  tempRoot = await makeTempDir('resume-effort-');
  config = { project: { paths: { tempRoot } } };
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

/** One entry to `agent::blocked`, exactly as `transitionTicketState` emits it. */
function block(storyId) {
  return emitRuntimeFriction({
    storyId,
    category: RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED,
    tool: 'transitionTicketState',
    details: { toState: 'agent::blocked' },
    config,
  });
}

/** Leaving `agent::blocked` — the recovered twin. */
function unblock(storyId) {
  return emitBlockRecoveredFriction({
    storyId,
    fromState: 'agent::blocked',
    toState: 'agent::ready',
    config,
  });
}

const BLOCKED = {
  kind: 'friction',
  category: RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED,
  details: { toState: 'agent::blocked' },
};

/** A reader that replays `records` as the Story's signals stream. */
const replay = (records) => async (_epicId, _storyId, cb) => {
  for (const record of records) await cb(record);
};

describe('resolveResumeEffort — the ladder', () => {
  it('0 prior blocks → null: the worker inherits the session', async () => {
    assert.equal(await resolveResumeEffort(1, { readFn: replay([]) }), null);
  });

  it('1 → high, 2 and above → xhigh', async () => {
    const effortFor = (n) =>
      resolveResumeEffort(1, { readFn: replay(Array(n).fill(BLOCKED)) });
    assert.equal(await effortFor(1), 'high');
    assert.equal(await effortFor(2), 'xhigh');
    assert.equal(await effortFor(7), 'xhigh');
  });

  it('counts only un-recovered story-blocked friction records', async () => {
    const noise = [
      { ...BLOCKED, details: { recovered: true } },
      { ...BLOCKED, category: 'close-failed' },
      { ...BLOCKED, kind: 'retry' },
      null,
      'friction',
    ];
    assert.equal(await resolveResumeEffort(1, { readFn: replay(noise) }), null);
    assert.equal(
      await resolveResumeEffort(1, { readFn: replay([...noise, BLOCKED]) }),
      'high',
    );
  });

  it('every rung is a value the --worker-effort parser accepts', async () => {
    for (const n of [1, 2]) {
      const effort = await resolveResumeEffort(1, {
        readFn: replay(Array(n).fill(BLOCKED)),
      });
      assert.equal(parseWorkerEffort(effort).effort, effort);
    }
  });
});

describe('the local signals stream', () => {
  it('a missing signals file counts 0 and resolves no effort', async () => {
    assert.equal(await resolveResumeEffort(9101, { config }), null);
  });

  it('one block, recovered on resume → high', async () => {
    await block(9102);
    await unblock(9102);
    assert.equal(await resolveResumeEffort(9102, { config }), 'high');
  });

  it('two blocks → xhigh; recovered twins never add', async () => {
    await block(9103);
    await unblock(9103);
    await block(9103);
    await unblock(9103);
    assert.equal(await resolveResumeEffort(9103, { config }), 'xhigh');
  });

  it('counts only its own Story', async () => {
    await block(9104);
    assert.equal(await resolveResumeEffort(9105, { config }), null);
  });

  it('an unreadable stream counts 0 rather than throwing', async () => {
    const readFn = async () => {
      throw new Error('EACCES');
    };
    assert.equal(await resolveResumeEffort(9106, { config, readFn }), null);
    const rejectsNonError = async () => {
      throw 'EIO';
    };
    assert.equal(
      await resolveResumeEffort(9106, { config, readFn: rejectsNonError }),
      null,
    );
  });
});

describe('resolveRunDispatchInputs', () => {
  it('a one-Story run reads its prior-block count from the stream', async () => {
    await block(9107);
    await block(9107);
    const inputs = await resolveRunDispatchInputs([{ id: 9107 }], { config });
    assert.deepEqual([...inputs.priorBlocksById], [[9107, 2]]);
    assert.equal(inputs.roleScopedAgents, true);
  });

  it('a multi-Story run reads nothing; config can turn role agents off', async () => {
    let calls = 0;
    const inputs = await resolveRunDispatchInputs([{ id: 1 }, { id: 2 }], {
      config: { delivery: { routing: { roleScopedAgents: false } } },
      countFn: async () => {
        calls += 1;
        return 1;
      },
    });
    assert.equal(calls, 0);
    assert.equal(inputs.priorBlocksById.size, 0);
    assert.equal(inputs.roleScopedAgents, false);
  });
});

describe('parseWorkerEffort', () => {
  it('accepts every Agent tool effort level; absence is silent', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      assert.deepEqual(parseWorkerEffort(level), {
        effort: level,
        warning: null,
      });
    }
    assert.deepEqual(parseWorkerEffort(null), { effort: null, warning: null });
  });
});
