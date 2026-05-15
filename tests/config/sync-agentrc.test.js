import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getAgentrcDefaults } from '../../.agents/scripts/lib/config/defaults.js';
import {
  collectRedundantAdvisories,
  formatSyncReport,
  syncAgentrc,
} from '../../.agents/scripts/lib/config/sync-agentrc.js';

const STARTER_PATH = fileURLToPath(
  new URL('../../.agents/starter-agentrc.json', import.meta.url),
);
const FULL_PATH = fileURLToPath(
  new URL('../../.agents/full-agentrc.json', import.meta.url),
);

function makeTmpProject() {
  const root = mkdtempSync(path.join(tmpdir(), 'sync-agentrc-'));
  return root;
}

function writeConfig(root, body) {
  const p = path.join(root, '.agentrc.json');
  writeFileSync(
    p,
    typeof body === 'string' ? body : JSON.stringify(body, null, 2),
  );
  return p;
}

describe('syncAgentrc — starter shape', () => {
  let root;
  beforeEach(() => {
    root = makeTmpProject();
  });

  it('reports no changes for the canonical starter config', () => {
    const starter = JSON.parse(readFileSync(STARTER_PATH, 'utf8'));
    // Starter still carries placeholder identity values — replace them
    // with realistic ones so schema validation passes.
    starter.github.owner = 'acme';
    starter.github.repo = 'demo';
    starter.github.operatorHandle = '@octocat';
    writeConfig(root, starter);
    const result = syncAgentrc({ projectRoot: root });
    assert.equal(result.status, 'noop');
    assert.equal(result.wrote, false);
    assert.deepEqual(result.errors, []);
  });

  it('does not mutate the project file', () => {
    const starter = JSON.parse(readFileSync(STARTER_PATH, 'utf8'));
    starter.github.owner = 'acme';
    starter.github.repo = 'demo';
    starter.github.operatorHandle = '@octocat';
    const p = writeConfig(root, starter);
    syncAgentrc({ projectRoot: root });
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), starter);
  });

  it('emits REDUNDANT advisories for default-equal values', () => {
    const starter = {
      $schema: './.agents/schemas/agentrc.schema.json',
      project: {
        baseBranch: 'main',
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      },
      github: { owner: 'acme', repo: 'demo', operatorHandle: '@octocat' },
    };
    writeConfig(root, starter);
    const result = syncAgentrc({ projectRoot: root });
    const paths = result.changes
      .filter((c) => c.op === 'REDUNDANT')
      .map((c) => c.path);
    assert.ok(paths.includes('project.baseBranch'));
    assert.ok(paths.includes('project.paths.agentRoot'));
    assert.ok(paths.includes('project.paths.docsRoot'));
    assert.ok(paths.includes('project.paths.tempRoot'));
  });
});

describe('syncAgentrc — overrides', () => {
  let root;
  beforeEach(() => {
    root = makeTmpProject();
  });

  it('does not flag values that diverge from defaults', () => {
    writeConfig(root, {
      $schema: './.agents/schemas/agentrc.schema.json',
      project: {
        baseBranch: 'trunk',
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      },
      github: { owner: 'acme', repo: 'demo' },
    });
    const result = syncAgentrc({ projectRoot: root });
    const baseBranch = result.changes.find(
      (c) => c.path === 'project.baseBranch',
    );
    assert.equal(baseBranch, undefined);
  });

  it('never flags identity placeholders as redundant', () => {
    writeConfig(root, {
      $schema: './.agents/schemas/agentrc.schema.json',
      project: {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      },
      github: {
        owner: '[OWNER]',
        repo: '[REPO]',
        operatorHandle: '@[USERNAME]',
      },
    });
    const result = syncAgentrc({ projectRoot: root });
    const identityPaths = result.changes
      .filter((c) => c.op === 'REDUNDANT')
      .map((c) => c.path)
      .filter((p) =>
        ['github.owner', 'github.repo', 'github.operatorHandle'].includes(p),
      );
    assert.deepEqual(identityPaths, []);
  });
});

describe('syncAgentrc — failure modes', () => {
  let root;
  beforeEach(() => {
    root = makeTmpProject();
  });

  it('returns missing-config when .agentrc.json is absent', () => {
    const result = syncAgentrc({ projectRoot: root });
    assert.equal(result.status, 'missing-config');
    assert.equal(result.wrote, false);
    assert.ok(result.errors[0].includes('No .agentrc.json'));
  });

  it('returns invalid on malformed JSON', () => {
    writeConfig(root, '{ "not json,');
    const result = syncAgentrc({ projectRoot: root });
    assert.equal(result.status, 'invalid');
    assert.ok(result.errors[0].includes('Failed to parse'));
  });

  it('returns invalid on schema validation failure', () => {
    writeConfig(root, {
      project: { paths: { agentRoot: '.agents' } },
    });
    const result = syncAgentrc({ projectRoot: root });
    assert.equal(result.status, 'invalid');
    assert.ok(result.errors.length > 0);
  });

  it('never auto-fills missing optional keys from the template', () => {
    const minimal = {
      $schema: './.agents/schemas/agentrc.schema.json',
      project: {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      },
    };
    writeConfig(root, minimal);
    const result = syncAgentrc({ projectRoot: root });
    assert.equal(result.status, 'noop');
    assert.equal(result.wrote, false);
    // Read back the file — no additional keys must have appeared.
    const after = JSON.parse(
      readFileSync(path.join(root, '.agentrc.json'), 'utf8'),
    );
    assert.deepEqual(after, minimal);
  });
});

describe('syncAgentrc — idempotence', () => {
  it('produces identical results on repeated runs', () => {
    const root = makeTmpProject();
    writeConfig(root, {
      $schema: './.agents/schemas/agentrc.schema.json',
      project: {
        baseBranch: 'main',
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      },
      github: { owner: 'acme', repo: 'demo' },
    });
    const a = syncAgentrc({ projectRoot: root });
    const b = syncAgentrc({ projectRoot: root });
    assert.equal(a.status, b.status);
    assert.deepEqual(a.changes, b.changes);
  });
});

describe('collectRedundantAdvisories', () => {
  it('finds every default-equal leaf inside the project', () => {
    const defaults = { a: { b: 1, c: 2 }, d: 'x' };
    const project = { a: { b: 1, c: 9 }, d: 'x', e: 'unrelated' };
    const out = collectRedundantAdvisories(project, defaults);
    const paths = out.map((c) => c.path).sort();
    assert.deepEqual(paths, ['a.b', 'd']);
  });
});

describe('formatSyncReport', () => {
  it('formats noop with no advisories', () => {
    const text = formatSyncReport({
      status: 'noop',
      changes: [],
      errors: [],
      configPath: '/tmp/.agentrc.json',
      wrote: false,
    });
    assert.match(text, /No changes required/);
    assert.doesNotMatch(text, /REDUNDANT/);
  });

  it('formats noop with advisories', () => {
    const text = formatSyncReport({
      status: 'noop',
      changes: [{ op: 'REDUNDANT', path: 'project.baseBranch', value: 'main' }],
      errors: [],
      configPath: '/tmp/.agentrc.json',
      wrote: false,
    });
    assert.match(text, /No changes required/);
    assert.match(text, /\[REDUNDANT\] project\.baseBranch = "main"/);
    assert.match(text, /Advisories: 1/);
  });

  it('formats invalid with errors', () => {
    const text = formatSyncReport({
      status: 'invalid',
      changes: [],
      errors: ['/github required property owner'],
      configPath: '/tmp/.agentrc.json',
      wrote: false,
    });
    assert.match(text, /Validation failed/);
    assert.match(text, /required property owner/);
  });

  it('formats missing-config', () => {
    const text = formatSyncReport({
      status: 'missing-config',
      changes: [],
      errors: [
        'No .agentrc.json at /tmp/.agentrc.json. Run /agents-bootstrap-project first.',
      ],
      configPath: '/tmp/.agentrc.json',
      wrote: false,
    });
    assert.match(text, /No project config found/);
    assert.match(text, /bootstrap/);
  });
});

describe('full-agentrc runtime parity', () => {
  it('every leaf in full-agentrc.json is reachable via the schema', () => {
    // If the schema rejects the full template, the defaults source has
    // drifted from the validator. Catch that here so a bump that adds
    // a key to one without the other fails CI loudly.
    const root = makeTmpProject();
    const full = JSON.parse(readFileSync(FULL_PATH, 'utf8'));
    // Replace identity placeholders with valid strings so the schema's
    // minLength/pattern constraints pass — we're testing structural
    // acceptance, not identity-field rules.
    full.github.owner = 'acme';
    full.github.repo = 'demo';
    full.github.operatorHandle = '@octocat';
    writeConfig(root, full);
    const result = syncAgentrc({ projectRoot: root });
    assert.equal(
      result.status,
      'noop',
      `full-agentrc.json must validate cleanly; errors: ${result.errors.join(' | ')}`,
    );
  });

  it('getAgentrcDefaults() matches full-agentrc.json (minus $schema)', () => {
    const defaults = getAgentrcDefaults();
    const raw = JSON.parse(readFileSync(FULL_PATH, 'utf8'));
    delete raw.$schema;
    assert.deepEqual(defaults, raw);
  });
});
