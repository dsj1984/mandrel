/**
 * Integration tests for `.agents/scripts/lib/spec/loader.js` — Story #1491 /
 * Task #1509. Covers every public export of the loader against fresh
 * sandbox directories so the tests never touch the real
 * `.agents/epics/` tree.
 *
 * Contract under test:
 *   - `loadSpec` parses YAML (and JSON-as-YAML), validates against the
 *     schema, and throws structured errors that name the offending JSON
 *     pointer.
 *   - `loadState` returns `{ epicId, mapping: {} }` when the file is
 *     missing, and the parsed JSON otherwise.
 *   - `writeState` writes deterministic JSON; rewriting an equivalent
 *     state is byte-identical (covered here at the loader's API
 *     boundary; the canonicalisation primitive is also tested directly
 *     in `spec-state.test.js`).
 *   - `specPath` / `statePath` produce the expected on-disk paths.
 *   - The error classes (`SpecNotFoundError`, `SpecValidationError`,
 *     `SpecParseError`) are distinguishable via `instanceof`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  loadSpec,
  loadState,
  SpecNotFoundError,
  SpecParseError,
  SpecValidationError,
  specPath,
  statePath,
  writeState,
} from '../../.agents/scripts/lib/spec/index.js';

const FIXTURES = path.resolve(process.cwd(), 'tests', 'fixtures', 'epic-specs');

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'spec-loader-'));
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function plantSpec(epicId, content) {
  const target = path.join(sandbox, `${epicId}.yaml`);
  writeFileSync(target, content, 'utf8');
  return target;
}

function plantFixture(epicId, fixtureName) {
  const raw = readFileSync(path.join(FIXTURES, `${fixtureName}.json`), 'utf8');
  return plantSpec(epicId, raw);
}

describe('lib/spec/loader.js — path resolution', () => {
  it('builds spec paths under the configured epicsDir', () => {
    assert.equal(
      specPath(1182, { epicsDir: sandbox }),
      path.join(sandbox, '1182.yaml'),
    );
  });

  it('builds state paths under the configured epicsDir', () => {
    assert.equal(
      statePath(1182, { epicsDir: sandbox }),
      path.join(sandbox, '1182.state.json'),
    );
  });

  it('accepts string epicIds (used by CLI argv passthrough)', () => {
    assert.equal(
      specPath('1182', { epicsDir: sandbox }),
      path.join(sandbox, '1182.yaml'),
    );
  });
});

describe('lib/spec/loader.js — loadSpec', () => {
  it('parses + validates a JSON fixture (the parser accepts JSON-as-YAML)', () => {
    plantFixture(1182, 'full');
    const spec = loadSpec(1182, { epicsDir: sandbox });
    assert.equal(spec.epic.id, 1182);
    assert.equal(spec.features.length, 2);
  });

  it('parses + validates a real YAML spec authored by hand (3-tier shape)', () => {
    plantSpec(
      8888,
      [
        'epic:',
        '  id: 8888',
        '  title: Hand-authored YAML',
        '  labels:',
        '    - type::epic',
        'features:',
        '  - slug: feat-a',
        '    title: Feature A',
        '    stories:',
        '      - slug: story-a',
        '        title: Story A',
        '        wave: 0',
        '        acceptance:',
        '          - Story A delivers feature A',
        '        verify:',
        '          - node --test',
        '',
      ].join('\n'),
    );
    const spec = loadSpec(8888, { epicsDir: sandbox });
    assert.equal(spec.epic.id, 8888);
    assert.equal(spec.features[0].stories[0].slug, 'story-a');
    assert.deepEqual(spec.features[0].stories[0].acceptance, [
      'Story A delivers feature A',
    ]);
  });

  it('throws SpecNotFoundError with the resolved path when the file is missing', () => {
    assert.throws(
      () => loadSpec(7777, { epicsDir: sandbox }),
      (err) => {
        assert.ok(err instanceof SpecNotFoundError);
        assert.equal(err.epicId, '7777');
        assert.equal(err.filePath, path.join(sandbox, '7777.yaml'));
        return true;
      },
    );
  });

  it('throws SpecParseError when the YAML is malformed (preserves cause)', () => {
    // Unclosed bracket → YAML parser raises
    plantSpec(6666, 'epic: { id: 6666, title: "broken\n');
    assert.throws(
      () => loadSpec(6666, { epicsDir: sandbox }),
      (err) => {
        assert.ok(err instanceof SpecParseError);
        assert.equal(err.epicId, '6666');
        assert.ok(err.cause, 'parse error should retain underlying cause');
        return true;
      },
    );
  });

  it('throws SpecValidationError naming the offending JSON path on missing-features', () => {
    plantFixture(5555, 'invalid-missing-features');
    assert.throws(
      () => loadSpec(5555, { epicsDir: sandbox }),
      (err) => {
        assert.ok(err instanceof SpecValidationError);
        assert.equal(err.epicId, '5555');
        const featureErr = err.issues.find((i) => i.path === '/features');
        assert.ok(
          featureErr,
          `expected an issue at /features, got: ${JSON.stringify(err.issues)}`,
        );
        return true;
      },
    );
  });

  it('throws SpecValidationError naming the offending JSON path on bad-slug', () => {
    plantFixture(4444, 'invalid-bad-slug');
    assert.throws(
      () => loadSpec(4444, { epicsDir: sandbox }),
      (err) => {
        assert.ok(err instanceof SpecValidationError);
        const slugErr = err.issues.find((i) =>
          i.path.startsWith('/features/0/slug'),
        );
        assert.ok(
          slugErr,
          `expected a /features/0/slug issue, got: ${JSON.stringify(err.issues)}`,
        );
        return true;
      },
    );
  });

  it('throws SpecValidationError when the YAML parses to a non-object', () => {
    plantSpec(3333, '"just a string"\n');
    assert.throws(
      () => loadSpec(3333, { epicsDir: sandbox }),
      (err) => {
        assert.ok(err instanceof SpecValidationError);
        return true;
      },
    );
  });

  it('exposes Ajv params on validation issues so callers can render context', () => {
    plantFixture(2222, 'invalid-unknown-property');
    try {
      loadSpec(2222, { epicsDir: sandbox });
      assert.fail('expected loadSpec to throw');
    } catch (err) {
      assert.ok(err instanceof SpecValidationError);
      const additional = err.issues.find(
        (i) => i.params?.additionalProperty === 'owner',
      );
      assert.ok(
        additional,
        `expected an additionalProperty issue, got: ${JSON.stringify(err.issues)}`,
      );
    }
  });
});

describe('lib/spec/loader.js — loadState', () => {
  it('returns an empty mapping when the state file is missing', () => {
    const state = loadState(1182, { epicsDir: sandbox });
    assert.deepEqual(state, { epicId: 1182, mapping: {} });
  });

  it('returns the parsed JSON when the state file exists', () => {
    writeFileSync(
      path.join(sandbox, '1182.state.json'),
      JSON.stringify({
        epicId: 1182,
        lastReconciledAt: '2026-05-12T00:00:00.000Z',
        mapping: {
          'schema-author': {
            issueNumber: 1190,
            contentHash: 'sha256:abc',
            lastObservedAgentState: 'agent::done',
          },
        },
      }),
    );
    const state = loadState(1182, { epicsDir: sandbox });
    assert.equal(state.epicId, 1182);
    assert.equal(state.mapping['schema-author'].issueNumber, 1190);
  });

  it('coerces numeric epicIds in the empty default', () => {
    const state = loadState('999', { epicsDir: sandbox });
    assert.equal(state.epicId, 999);
    assert.deepEqual(state.mapping, {});
  });
});

describe('lib/spec/loader.js — writeState', () => {
  it('writes pretty-printed JSON with a trailing newline', () => {
    const result = writeState(
      1182,
      {
        epicId: 1182,
        lastReconciledAt: '2026-05-12T00:00:00.000Z',
        mapping: {},
      },
      { epicsDir: sandbox },
    );
    const raw = readFileSync(result, 'utf8');
    assert.ok(raw.endsWith('\n'), 'expected a trailing newline');
    assert.match(raw, /^\{\n {2}/, 'expected pretty-printed JSON');
  });

  it('writes deterministically-sorted keys at every depth', () => {
    writeState(
      1182,
      {
        mapping: {
          'z-last': { lastObservedAgentState: 'agent::ready', issueNumber: 9 },
          'a-first': { issueNumber: 1, contentHash: 'sha256:x' },
        },
        epicId: 1182,
        lastReconciledAt: '2026-05-12T00:00:00.000Z',
      },
      { epicsDir: sandbox },
    );
    const raw = readFileSync(path.join(sandbox, '1182.state.json'), 'utf8');
    const epicIdAt = raw.indexOf('"epicId"');
    const lastAt = raw.indexOf('"lastReconciledAt"');
    const mappingAt = raw.indexOf('"mapping"');
    assert.ok(epicIdAt < lastAt && lastAt < mappingAt, 'top keys sorted');
    const aFirstAt = raw.indexOf('"a-first"');
    const zLastAt = raw.indexOf('"z-last"');
    assert.ok(aFirstAt < zLastAt, 'nested mapping keys sorted');
    const issueAt = raw.indexOf('"issueNumber"', aFirstAt);
    const contentAt = raw.indexOf('"contentHash"', aFirstAt);
    assert.ok(contentAt < issueAt, 'nested entry keys sorted');
  });

  it('produces a byte-identical file when called twice with the same state', () => {
    const state = {
      epicId: 1182,
      lastReconciledAt: '2026-05-12T00:00:00.000Z',
      mapping: {
        'schema-author': {
          issueNumber: 1190,
          contentHash: 'sha256:abc',
          lastObservedAgentState: 'agent::done',
        },
      },
    };
    writeState(1182, state, { epicsDir: sandbox });
    const first = readFileSync(path.join(sandbox, '1182.state.json'));
    writeState(1182, state, { epicsDir: sandbox });
    const second = readFileSync(path.join(sandbox, '1182.state.json'));
    assert.ok(first.equals(second), 'expected byte-identical re-write');
  });

  it('produces a byte-identical file regardless of input key order', () => {
    writeState(
      1182,
      {
        epicId: 1182,
        mapping: { a: { issueNumber: 1, contentHash: 'sha256:x' } },
        lastReconciledAt: '2026-05-12T00:00:00.000Z',
      },
      { epicsDir: sandbox },
    );
    const first = readFileSync(path.join(sandbox, '1182.state.json'));
    writeState(
      1182,
      {
        mapping: { a: { contentHash: 'sha256:x', issueNumber: 1 } },
        lastReconciledAt: '2026-05-12T00:00:00.000Z',
        epicId: 1182,
      },
      { epicsDir: sandbox },
    );
    const second = readFileSync(path.join(sandbox, '1182.state.json'));
    assert.ok(first.equals(second), 'order should not affect the file bytes');
  });

  it('creates the epics directory if it does not exist', () => {
    const nested = path.join(sandbox, 'deep', 'epics');
    writeState(1182, { epicId: 1182, mapping: {} }, { epicsDir: nested });
    const written = readFileSync(path.join(nested, '1182.state.json'), 'utf8');
    assert.match(written, /"epicId": 1182/);
  });

  it('round-trips through loadState', () => {
    const original = {
      epicId: 1182,
      lastReconciledAt: '2026-05-12T00:00:00.000Z',
      mapping: {
        'schema-author': {
          issueNumber: 1190,
          contentHash: 'sha256:abc',
          lastObservedAgentState: 'agent::done',
        },
      },
    };
    writeState(1182, original, { epicsDir: sandbox });
    const reloaded = loadState(1182, { epicsDir: sandbox });
    assert.deepEqual(reloaded, original);
  });
});
