/**
 * resume-effort.test.js — Story #5608.
 *
 * The prior-block counter reads the Story's local signals stream through the
 * same emitter the ticket transition uses, and the ladder maps the count to
 * the Agent tool's per-call effort: 0 → null, 1 → high, ≥2 → xhigh.
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
  AGENT_EFFORT_LEVELS,
  countPriorBlocks,
  isPriorBlockRecord,
  resolveResumeEffort,
  resumeEffortFor,
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

describe('resumeEffortFor — the ladder', () => {
  it('0 prior blocks → null: the worker inherits the session', () => {
    assert.equal(resumeEffortFor(0), null);
  });

  it('1 → high, 2 and above → xhigh', () => {
    assert.equal(resumeEffortFor(1), 'high');
    assert.equal(resumeEffortFor(2), 'xhigh');
    assert.equal(resumeEffortFor(7), 'xhigh');
  });

  it('a non-count is no prior block', () => {
    for (const junk of [undefined, null, -1, 1.5, 'x', Number.NaN]) {
      assert.equal(resumeEffortFor(junk), null);
    }
  });

  it('every rung is a value of the Agent tool effort enum', () => {
    for (const n of [1, 2]) {
      assert.ok(AGENT_EFFORT_LEVELS.includes(resumeEffortFor(n)));
    }
  });
});

describe('isPriorBlockRecord', () => {
  const base = {
    kind: 'friction',
    category: RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED,
    details: { toState: 'agent::blocked' },
  };

  it('counts an un-recovered story-blocked friction record', () => {
    assert.equal(isPriorBlockRecord(base), true);
  });

  it('skips the recovered twin, other categories, other kinds and junk', () => {
    assert.equal(
      isPriorBlockRecord({ ...base, details: { recovered: true } }),
      false,
    );
    assert.equal(
      isPriorBlockRecord({ ...base, category: 'close-failed' }),
      false,
    );
    assert.equal(isPriorBlockRecord({ ...base, kind: 'retry' }), false);
    assert.equal(isPriorBlockRecord(null), false);
    assert.equal(isPriorBlockRecord('friction'), false);
  });
});

describe('countPriorBlocks — the local signals stream', () => {
  it('a missing signals file counts 0 and resolves no effort', async () => {
    assert.equal(await countPriorBlocks(9101, { config }), 0);
    assert.equal(await resolveResumeEffort(9101, { config }), null);
  });

  it('one block, recovered on resume → 1 → high', async () => {
    await block(9102);
    await unblock(9102);
    assert.equal(await countPriorBlocks(9102, { config }), 1);
    assert.equal(await resolveResumeEffort(9102, { config }), 'high');
  });

  it('two blocks → 2 → xhigh; recovered twins never add', async () => {
    await block(9103);
    await unblock(9103);
    await block(9103);
    await unblock(9103);
    assert.equal(await countPriorBlocks(9103, { config }), 2);
    assert.equal(await resolveResumeEffort(9103, { config }), 'xhigh');
  });

  it('counts only its own Story', async () => {
    await block(9104);
    assert.equal(await countPriorBlocks(9105, { config }), 0);
  });

  it('an unreadable stream counts 0 rather than throwing', async () => {
    const readFn = async () => {
      throw new Error('EACCES');
    };
    assert.equal(await countPriorBlocks(9106, { config, readFn }), 0);
    assert.equal(await resolveResumeEffort(9106, { config, readFn }), null);
  });
});
