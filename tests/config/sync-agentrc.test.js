import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getAgentrcDefaults } from '../../.agents/scripts/lib/config/defaults.js';
import {
  collectRedundantAdvisories,
  formatSyncReport,
  syncAgentrc,
} from '../../.agents/scripts/lib/config/sync-agentrc.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { main } from '../../.agents/scripts/sync-agentrc.js';

const STARTER_PATH = fileURLToPath(
  new URL('../../.agents/starter-agentrc.json', import.meta.url),
);
const FULL_PATH = fileURLToPath(
  new URL('../../.agents/docs/agentrc-reference.json', import.meta.url),
);

function makeTmpProject() {
  const root = makeTempDir('sync-agentrc-');
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

  it('emits REDUNDANT advisories for default-equal optional values', () => {
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
    // Optional leaves that equal the default are advisory.
    assert.ok(paths.includes('project.baseBranch'));
  });

  it('never flags schema-required leaves as redundant, even when default-equal', () => {
    // The schema requires `project.paths.{agentRoot,docsRoot,tempRoot}`
    // with `additionalProperties: false`. A consumer that carries the
    // canonical layout cannot remove these keys without invalidating
    // the config, so the [REDUNDANT] advisory must skip them.
    const starter = {
      $schema: './.agents/schemas/agentrc.schema.json',
      project: {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      },
      github: { owner: 'acme', repo: 'demo', operatorHandle: '@octocat' },
    };
    writeConfig(root, starter);
    const result = syncAgentrc({ projectRoot: root });
    const paths = result.changes
      .filter((c) => c.op === 'REDUNDANT')
      .map((c) => c.path);
    assert.ok(!paths.includes('project.paths.agentRoot'));
    assert.ok(!paths.includes('project.paths.docsRoot'));
    assert.ok(!paths.includes('project.paths.tempRoot'));
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
        'No .agentrc.json at /tmp/.agentrc.json. Run `mandrel init` (new project) or `node .agents/scripts/bootstrap.js` to create it.',
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

describe('sync-agentrc CLI main — exit codes (Story #4842)', () => {
  let root;
  beforeEach(() => {
    root = makeTmpProject();
  });

  function writeValidConfig(dir) {
    const starter = JSON.parse(readFileSync(STARTER_PATH, 'utf8'));
    starter.github.owner = 'acme';
    starter.github.repo = 'demo';
    starter.github.operatorHandle = '@octocat';
    return writeConfig(dir, starter);
  }

  it('returns 0 for a valid config named via --cwd', () => {
    writeValidConfig(root);
    assert.equal(main(['--cwd', root]), 0);
  });

  it('returns 0 under --quiet, trimming advisory rows', () => {
    writeValidConfig(root);
    assert.equal(main(['--cwd', root, '--quiet']), 0);
  });

  it('returns 1 for malformed JSON', () => {
    writeConfig(root, '{ not json');
    assert.equal(main(['--cwd', root]), 1);
  });

  it('returns 1 for a missing config, ignoring unknown flags', () => {
    assert.equal(main(['--cwd', root, '--bogus']), 1);
  });
});

describe('syncAgentrc — .agentrc.local.json overlay (Story #5649)', () => {
  let root;
  beforeEach(() => {
    root = makeTmpProject();
  });

  function writeLocal(dir, body) {
    const p = path.join(dir, '.agentrc.local.json');
    writeFileSync(
      p,
      typeof body === 'string' ? body : JSON.stringify(body, null, 2),
    );
    return p;
  }

  function committedWithoutHandle() {
    const starter = JSON.parse(readFileSync(STARTER_PATH, 'utf8'));
    starter.github.owner = 'acme';
    starter.github.repo = 'demo';
    delete starter.github.operatorHandle;
    return starter;
  }

  it('accepts operatorHandle supplied only by the local overlay', () => {
    writeConfig(root, committedWithoutHandle());
    const localPath = writeLocal(root, {
      github: { operatorHandle: '@octocat' },
    });
    const result = syncAgentrc({ projectRoot: root });
    assert.equal(result.status, 'noop');
    assert.deepEqual(result.errors, []);
    assert.equal(result.localPath, localPath);
    assert.match(formatSyncReport(result), /with overlay/);
    assert.equal(main(['--cwd', root]), 0);
  });

  it('fails closed with a remedy when neither file supplies operatorHandle', () => {
    writeConfig(root, committedWithoutHandle());
    const result = syncAgentrc({ projectRoot: root });
    assert.equal(result.status, 'invalid');
    assert.equal(result.localPath, null);
    const joined = result.errors.join('\n');
    assert.match(joined, /operatorHandle/);
    assert.match(joined, /\.agentrc\.local\.json/);
    assert.match(joined, /@\[USERNAME\]/);
    assert.equal(main(['--cwd', root]), 1);
  });

  it('still fails closed when an overlay exists but omits operatorHandle', () => {
    writeConfig(root, committedWithoutHandle());
    writeLocal(root, { project: { baseBranch: 'dev-octocat' } });
    const result = syncAgentrc({ projectRoot: root });
    assert.equal(result.status, 'invalid');
    assert.match(result.errors.join('\n'), /\.agentrc\.local\.json/);
    assert.match(formatSyncReport(result), /with overlay/);
  });

  it('reports a malformed overlay by name', () => {
    writeConfig(root, committedWithoutHandle());
    writeLocal(root, '{ not json');
    const result = syncAgentrc({ projectRoot: root });
    assert.equal(result.status, 'invalid');
    assert.match(result.errors[0], /\.agentrc\.local\.json/);
    assert.equal(main(['--cwd', root]), 1);
  });

  it('rejects an overlay value that fails the schema even when the committed file validates', () => {
    const committed = committedWithoutHandle();
    committed.github.operatorHandle = '@octocat';
    writeConfig(root, committed);
    assert.equal(syncAgentrc({ projectRoot: root }).status, 'noop');
    writeLocal(root, { project: { baseBranch: 42 } });
    const result = syncAgentrc({ projectRoot: root });
    assert.equal(result.status, 'invalid');
    assert.match(result.errors.join('\n'), /baseBranch/);
  });

  it('flags only committed leaves as REDUNDANT, never overlay-only ones', () => {
    const committed = committedWithoutHandle();
    delete committed.project.baseBranch;
    writeConfig(root, committed);
    const before = readFileSync(path.join(root, '.agentrc.json'), 'utf8');
    writeLocal(root, {
      project: { baseBranch: 'main' },
      github: { operatorHandle: '@octocat' },
    });
    const result = syncAgentrc({ projectRoot: root });
    assert.equal(result.status, 'noop');
    assert.ok(
      !result.changes.some((c) => c.path === 'project.baseBranch'),
      'overlay-only default-equal leaf must not be flagged',
    );
    assert.equal(
      readFileSync(path.join(root, '.agentrc.json'), 'utf8'),
      before,
    );
  });
});
