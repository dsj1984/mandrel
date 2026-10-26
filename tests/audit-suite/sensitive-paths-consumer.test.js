// Consumer-declared sensitive paths (`delivery.codeReview.sensitivePaths`),
// merged additively over the SHIPPED manifest on disk.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { selectSensitivePathClasses } from '../../.agents/scripts/lib/audit-suite/selector.js';
import { resolveSensitivePaths } from '../../.agents/scripts/lib/audit-suite/sensitive-paths.js';
import { getAgentrcValidator } from '../../.agents/scripts/lib/config-settings-schema.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const readJson = (rel) =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
const SHIPPED = readJson('.agents/schemas/audit-rules.json');

function withConsumer(sensitivePaths) {
  return { delivery: { codeReview: { sensitivePaths } } };
}

function select(changedFiles, config) {
  return selectSensitivePathClasses({
    changedFiles,
    injectedRules: SHIPPED,
    injectedConfig: config,
  });
}

describe('no consumer block — the shipped manifest is unchanged', () => {
  test('the effective map equals the shipped classes and patterns, in manifest order', () => {
    for (const config of [{}, null, withConsumer({})]) {
      const effective = resolveSensitivePaths({ rules: SHIPPED, config });
      assert.deepEqual(
        Object.keys(effective),
        Object.keys(SHIPPED.sensitivePaths),
      );
      for (const [name, entry] of Object.entries(SHIPPED.sensitivePaths)) {
        assert.deepEqual(effective[name].filePatterns, entry.filePatterns);
      }
    }
  });

  test('each shipped class still matches its own first pattern', () => {
    for (const [name, entry] of Object.entries(SHIPPED.sensitivePaths)) {
      const sample = entry.filePatterns[0]
        .replaceAll('**/', 'a/')
        .replaceAll('*', 'x');
      assert.ok(select([sample], {}).includes(name), `${name} via ${sample}`);
    }
  });
});

describe('consumer classes merge additively', () => {
  test('a pattern under a shipped class name extends it without dropping a shipped pattern', () => {
    const shipped = SHIPPED.sensitivePaths.security.filePatterns;
    const effective = resolveSensitivePaths({
      rules: SHIPPED,
      config: withConsumer({
        security: { filePatterns: ['apps/web/src/middleware.ts', shipped[0]] },
      }),
    });
    assert.deepEqual(effective.security.filePatterns, [
      ...shipped,
      'apps/web/src/middleware.ts',
    ]);
    assert.equal(
      effective.security.description,
      SHIPPED.sensitivePaths.security.description,
    );
    assert.deepEqual(
      select(
        ['apps/web/src/middleware.ts'],
        withConsumer({
          security: { filePatterns: ['apps/web/src/middleware.ts'] },
        }),
      ),
      ['security'],
    );
  });

  test('consumer-only classes follow the shipped ones, in config order', () => {
    const effective = resolveSensitivePaths({
      rules: SHIPPED,
      config: withConsumer({
        'z-schema': { description: 'DB schema', filePatterns: ['db/*.sql'] },
        'a-edge': { filePatterns: ['edge/**'] },
      }),
    });
    assert.deepEqual(Object.keys(effective), [
      ...Object.keys(SHIPPED.sensitivePaths),
      'z-schema',
      'a-edge',
    ]);
    assert.equal(effective['z-schema'].description, 'DB schema');
  });
});

describe('.agentrc.json validation of the consumer block', () => {
  const validate = getAgentrcValidator();
  const base = readJson('.agentrc.json');
  const agentrc = (sensitivePaths) => ({
    ...base,
    delivery: {
      ...base.delivery,
      codeReview: { ...base.delivery?.codeReview, sensitivePaths },
    },
  });

  test('the base config validates on its own', () => {
    assert.equal(validate(base), true, JSON.stringify(validate.errors));
  });

  test('accepts a populated block', () => {
    const ok = validate(
      agentrc({
        'edge-auth': {
          description: 'Edge auth middleware',
          filePatterns: ['apps/web/src/middleware.ts'],
        },
      }),
    );
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  for (const [label, entry] of [
    ['no patterns', {}],
    ['an empty pattern list', { filePatterns: [] }],
    ['an empty pattern', { filePatterns: [''] }],
    ['an unknown entry key', { filePatterns: ['a/**'], exclude: ['b'] }],
  ]) {
    test(`rejects a class with ${label}`, () => {
      assert.equal(validate(agentrc({ 'edge-auth': entry })), false);
    });
  }

  test('rejects a class name outside the kebab-case vocabulary', () => {
    assert.equal(
      validate(agentrc({ 'Edge Auth': { filePatterns: ['a/**'] } })),
      false,
    );
  });
});
