/**
 * crap-coverage-source.test.js — `delivery.quality.gates.crap.coveragePath`
 * and `delivery.quality.gates.crap.captureScript` (Story #5717).
 *
 * Covers: a populated block passes the runtime validator, malformed values
 * are rejected naming the key, and the published mirror, reference inventory
 * and configuration docs list both keys.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { getAgentrcValidator } from '../../.agents/scripts/lib/config-schema.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const PATHS = { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' };

function withCrap(crap) {
  return {
    project: { paths: PATHS },
    delivery: { quality: { gates: { crap } } },
  };
}

function findNode(node, match) {
  if (node === null || typeof node !== 'object') return null;
  if (match(node)) return node;
  for (const child of Object.values(node)) {
    const hit = findNode(child, match);
    if (hit) return hit;
  }
  return null;
}

function readRepoFile(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('crap coverage source — runtime validator (AC-1)', () => {
  it('accepts a populated crap.coveragePath + crap.captureScript block', () => {
    const validate = getAgentrcValidator();
    const config = withCrap({
      enabled: true,
      targetDirs: ['src'],
      coveragePath: 'coverage-py/coverage-final.json',
      captureScript: 'test:coverage:py',
    });
    assert.equal(validate(config), true, JSON.stringify(validate.errors));
  });

  it('accepts a null coveragePath (falls back to the coverage gate)', () => {
    const validate = getAgentrcValidator();
    assert.equal(
      validate(withCrap({ coveragePath: null })),
      true,
      JSON.stringify(validate.errors),
    );
  });

  it('rejects a shell command or empty value as captureScript, naming the key', () => {
    const validate = getAgentrcValidator();
    for (const captureScript of ['', 'npm test && rm -rf /', 'a b', 7]) {
      assert.equal(
        validate(withCrap({ captureScript })),
        false,
        `captureScript=${JSON.stringify(captureScript)} must be rejected`,
      );
      assert.ok(
        validate.errors.some((e) => e.instancePath.endsWith('/captureScript')),
        JSON.stringify(validate.errors),
      );
    }
  });

  it('rejects an empty or non-string coveragePath', () => {
    const validate = getAgentrcValidator();
    for (const coveragePath of ['', 42]) {
      assert.equal(validate(withCrap({ coveragePath })), false);
    }
  });
});

describe('crap coverage source — published surfaces (AC-1)', () => {
  it('the schema mirror declares both keys on the crap gate', () => {
    const schema = JSON.parse(
      readRepoFile('.agents/schemas/agentrc.schema.json'),
    );
    const crapGate = findNode(
      schema,
      (n) => n?.properties?.newMethodCeiling && n?.properties?.targetDirs,
    );
    assert.ok(crapGate, 'crap gate node not found in the mirror');
    assert.ok(crapGate.properties.coveragePath);
    assert.equal(crapGate.properties.captureScript.default, 'test:coverage');
  });

  it('the reference inventory lists both keys under the crap gate', () => {
    const ref = JSON.parse(readRepoFile('.agents/docs/agentrc-reference.json'));
    const crap = ref.delivery.quality.gates.crap;
    assert.ok(Object.hasOwn(crap, 'coveragePath'));
    assert.equal(crap.coveragePath, null);
    assert.equal(crap.captureScript, 'test:coverage');
  });

  it('the configuration docs list both keys', () => {
    const doc = readRepoFile('.agents/docs/configuration.md');
    assert.match(doc, /`quality\.gates\.crap\.coveragePath`/);
    assert.match(doc, /`quality\.gates\.crap\.captureScript`/);
  });
});
