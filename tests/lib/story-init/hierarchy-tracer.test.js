import assert from 'node:assert';
import { test } from 'node:test';
import { traceHierarchy } from '../../../.agents/scripts/lib/story-init/hierarchy-tracer.js';

test('traceHierarchy returns TechSpec from provider.getEpic', async () => {
  const provider = {
    async getEpic(id) {
      assert.strictEqual(id, 42);
      return { linkedIssues: { techSpec: 101 } };
    },
  };
  const out = await traceHierarchy({ provider, input: { epicId: 42 } });
  assert.deepStrictEqual(out, { techSpecId: 101 });
});

test('traceHierarchy returns nulls and warns when Epic fetch fails', async () => {
  const warnings = [];
  const provider = {
    async getEpic() {
      throw new Error('boom');
    },
  };
  const out = await traceHierarchy({
    provider,
    logger: { warn: (m) => warnings.push(m) },
    input: { epicId: 42 },
  });
  assert.deepStrictEqual(out, { techSpecId: null });
  assert.ok(warnings[0].includes('Could not fetch Epic #42'));
});

test('traceHierarchy handles Epics missing linkedIssues', async () => {
  const provider = {
    async getEpic() {
      return {};
    },
  };
  const out = await traceHierarchy({ provider, input: { epicId: 1 } });
  assert.deepStrictEqual(out, { techSpecId: null });
});
