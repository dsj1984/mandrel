// lib/migrations/steps/__tests__/2.2.0-retire-epic-ac-tags.test.js
/**
 * Unit tests for the Story #4604 migration step — strips retired
 * `@epic-<id>-ac-N` Gherkin AC tags from consumer feature files under the
 * canonical feature roots. All tests drive `detect`/`apply` against an
 * in-memory fake fs (testing-standards § Unit) — no real filesystem I/O.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { retireEpicAcTags } from '../2.2.0-retire-epic-ac-tags.js';

const PROJECT_ROOT = '/consumer';

/**
 * Build a ctx over an in-memory file map. Keys are project-root-relative
 * paths; values are file contents. Directories are derived from the keys.
 *
 * @param {Record<string, string>} relFiles
 * @returns {{ ctx: object, read: (rel: string) => string, writes: string[] }}
 */
function makeCtx(relFiles) {
  const files = new Map(
    Object.entries(relFiles).map(([rel, content]) => [
      path.join(PROJECT_ROOT, rel),
      content,
    ]),
  );
  /** @type {string[]} */
  const writes = [];

  const dirChildren = (dir) => {
    const children = new Map();
    for (const filePath of files.keys()) {
      if (!filePath.startsWith(`${dir}${path.sep}`)) continue;
      const rest = filePath.slice(dir.length + 1);
      const [head, ...tail] = rest.split(path.sep);
      const isFile = tail.length === 0;
      if (!children.has(head) || isFile) children.set(head, isFile);
    }
    return children;
  };

  const fs = {
    readdirSync(dir, opts) {
      const children = dirChildren(dir);
      if (children.size === 0) {
        const err = new Error(`ENOENT: ${dir}`);
        err.code = 'ENOENT';
        throw err;
      }
      assert.equal(opts?.withFileTypes, true);
      return [...children.entries()].map(([name, isFile]) => ({
        name,
        isFile: () => isFile,
        isDirectory: () => !isFile,
      }));
    },
    readFileSync(filePath) {
      if (!files.has(filePath)) {
        const err = new Error(`ENOENT: ${filePath}`);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(filePath);
    },
    writeFileSync(filePath, contents) {
      files.set(filePath, contents);
      writes.push(filePath);
    },
  };

  return {
    ctx: { projectRoot: PROJECT_ROOT, fs },
    read: (rel) => files.get(path.join(PROJECT_ROOT, rel)),
    writes,
  };
}

const TAGGED_FEATURE = [
  'Feature: Billing export',
  '',
  '  @domain-billing @epic-4283-ac-1 @skip',
  '  Scenario: export a monthly invoice',
  '    Given a paid invoice',
  '    Then it exports as PDF',
  '',
  '  @epic-4283-ac-2',
  '  Scenario: export refuses an unpaid invoice',
  '    Given an unpaid invoice',
  '    Then export is refused',
  '',
].join('\n');

describe('retireEpicAcTags — detect', () => {
  it('detects a stale tag under each canonical feature root', () => {
    for (const root of ['tests/features', 'features', 'test/features']) {
      const { ctx } = makeCtx({ [`${root}/billing.feature`]: TAGGED_FEATURE });
      assert.equal(retireEpicAcTags.detect(ctx), true, root);
    }
  });

  it('detects tags in nested subdirectories', () => {
    const { ctx } = makeCtx({
      'tests/features/billing/export.feature': TAGGED_FEATURE,
    });
    assert.equal(retireEpicAcTags.detect(ctx), true);
  });

  it('does not detect a tree with only clean feature files', () => {
    const { ctx } = makeCtx({
      'tests/features/clean.feature': '@domain-auth @skip\nScenario: sign in\n',
    });
    assert.equal(retireEpicAcTags.detect(ctx), false);
  });

  it('does not detect stale tags outside the canonical roots', () => {
    const { ctx } = makeCtx({ 'src/other/x.feature': TAGGED_FEATURE });
    assert.equal(retireEpicAcTags.detect(ctx), false);
  });

  it('does not detect when no feature roots exist', () => {
    const { ctx } = makeCtx({});
    assert.equal(retireEpicAcTags.detect(ctx), false);
  });
});

describe('retireEpicAcTags — apply', () => {
  it('strips stale tokens, keeps sibling tags, and drops emptied tag lines', () => {
    const { ctx, read } = makeCtx({
      'tests/features/billing.feature': TAGGED_FEATURE,
    });
    retireEpicAcTags.apply(ctx);
    assert.equal(
      read('tests/features/billing.feature'),
      [
        'Feature: Billing export',
        '',
        '  @domain-billing @skip',
        '  Scenario: export a monthly invoice',
        '    Given a paid invoice',
        '    Then it exports as PDF',
        '',
        '  Scenario: export refuses an unpaid invoice',
        '    Given an unpaid invoice',
        '    Then export is refused',
        '',
      ].join('\n'),
    );
  });

  it('leaves prose mentioning the pattern outside tag lines untouched', () => {
    const content = [
      '@epic-1-ac-1',
      'Feature: docs',
      '  Scenario: mentions @epic-2-ac-3 in a step',
      '    Given the docs mention @epic-2-ac-3 somewhere',
      '',
    ].join('\n');
    const { ctx, read } = makeCtx({ 'features/docs.feature': content });
    retireEpicAcTags.apply(ctx);
    assert.equal(
      read('features/docs.feature'),
      [
        'Feature: docs',
        '  Scenario: mentions @epic-2-ac-3 in a step',
        '    Given the docs mention @epic-2-ac-3 somewhere',
        '',
      ].join('\n'),
    );
  });

  it('never rewrites files with no stale tags', () => {
    const { ctx, writes } = makeCtx({
      'tests/features/dirty.feature': TAGGED_FEATURE,
      'tests/features/clean.feature': '@skip\nScenario: clean\n',
    });
    retireEpicAcTags.apply(ctx);
    assert.deepEqual(writes, [
      path.join(PROJECT_ROOT, 'tests/features/dirty.feature'),
    ]);
  });

  it('is idempotent — detect returns false after apply', () => {
    const { ctx } = makeCtx({
      'tests/features/billing.feature': TAGGED_FEATURE,
    });
    assert.equal(retireEpicAcTags.detect(ctx), true);
    retireEpicAcTags.apply(ctx);
    assert.equal(retireEpicAcTags.detect(ctx), false);
  });

  it('preserves CRLF newlines', () => {
    const crlf = '@epic-9-ac-9 @smoke\r\nScenario: windows\r\n';
    const { ctx, read } = makeCtx({ 'features/win.feature': crlf });
    retireEpicAcTags.apply(ctx);
    assert.equal(
      read('features/win.feature'),
      '@smoke\r\nScenario: windows\r\n',
    );
  });
});
