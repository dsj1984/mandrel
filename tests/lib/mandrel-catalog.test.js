import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  buildCatalog,
  extractDescription,
  isVagueDescription,
  renderCatalog,
} from '../../.agents/scripts/lib/mandrel-catalog.js';

/**
 * Tests for `lib/mandrel-catalog.js` — the generator behind `/mandrel`.
 *
 * Covers: inline and folded-block YAML description parsing,
 * vague-description heuristic, top-level-only directory walk (helpers/
 * subdirectory must be excluded), README.md skip, and markdown render
 * shape.
 */

describe('extractDescription', () => {
  it('parses inline form', () => {
    const src =
      '---\ndescription: A clear single-line description\n---\n\n# body\n';
    assert.equal(extractDescription(src), 'A clear single-line description');
  });

  it('parses folded-block form (>-)', () => {
    const src =
      '---\n' +
      'description: >-\n' +
      '  Render the signals span-tree for an Epic to the\n' +
      '  terminal. Read-only viewer over `lib/signals/`.\n' +
      'recommendedModel: haiku\n' +
      '---\n';
    const desc = extractDescription(src);
    assert.match(desc, /^Render the signals span-tree/);
    assert.match(desc, /Read-only viewer/);
    // No leading/trailing whitespace, no double-spaces.
    assert.equal(desc, desc.trim());
    assert.ok(!/ {2}/.test(desc), 'expected collapsed whitespace');
  });

  it('returns null when frontmatter is missing', () => {
    assert.equal(extractDescription('# just a body\n'), null);
  });

  it('returns null when description key is missing', () => {
    const src = '---\nrecommendedModel: opus\n---\n';
    assert.equal(extractDescription(src), null);
  });

  it('handles a BOM at the file start', () => {
    const src = '﻿---\ndescription: With a BOM\n---\n';
    assert.equal(extractDescription(src), 'With a BOM');
  });
});

describe('isVagueDescription', () => {
  it('flags null', () => {
    assert.equal(isVagueDescription(null), true);
  });

  it('flags very short strings', () => {
    assert.equal(isVagueDescription('Run audit'), true);
  });

  it('passes substantive descriptions', () => {
    assert.equal(
      isVagueDescription(
        'Drive an Epic from agent::ready to a merged PR against main.',
      ),
      false,
    );
  });
});

describe('buildCatalog', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandrel-catalog-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('walks top-level .md files, sorted, with descriptions', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'alpha.md'),
      '---\ndescription: First workflow in the catalog under test\n---\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'beta.md'),
      '---\ndescription: >-\n  Second workflow — uses the folded form deliberately for coverage.\n---\n',
    );
    const catalog = buildCatalog(tmpDir);
    assert.equal(catalog.length, 2);
    assert.equal(catalog[0].name, 'alpha');
    assert.equal(catalog[1].name, 'beta');
    assert.match(catalog[0].description, /First workflow/);
    assert.match(catalog[1].description, /Second workflow/);
    assert.equal(catalog[0].vague, false);
    assert.equal(catalog[1].vague, false);
  });

  it('skips README.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'README.md'),
      '---\ndescription: should-not-appear\n---\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'real.md'),
      '---\ndescription: A genuine entry that should appear in the catalog\n---\n',
    );
    const catalog = buildCatalog(tmpDir);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].name, 'real');
  });

  it('skips subdirectories (helpers/ is path-included, not runnable)', () => {
    fs.mkdirSync(path.join(tmpDir, 'helpers'));
    fs.writeFileSync(
      path.join(tmpDir, 'helpers', 'task-execute.md'),
      '---\ndescription: should-not-appear-in-mandrel-menu\n---\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'top.md'),
      '---\ndescription: A genuine top-level workflow entry to verify scoping\n---\n',
    );
    const catalog = buildCatalog(tmpDir);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].name, 'top');
  });

  it('flags vague descriptions but still includes them', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'thin.md'),
      '---\ndescription: Run audit\n---\n',
    );
    const catalog = buildCatalog(tmpDir);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].vague, true);
  });

  it('throws when the workflows directory does not exist', () => {
    assert.throws(
      () => buildCatalog(path.join(tmpDir, 'does-not-exist')),
      /workflows directory not found/,
    );
  });
});

describe('renderCatalog', () => {
  it('renders a markdown bullet list with the catalog count', () => {
    const out = renderCatalog([
      { name: 'one', description: 'First workflow', vague: false },
      { name: 'two', description: null, vague: true },
    ]);
    assert.match(out, /# Mandrel command catalog/);
    assert.match(out, /2 commands/);
    assert.match(out, /\*\*\/one\*\* — First workflow/);
    assert.match(out, /\*\*\/two\*\* — _\(no description\)_/);
    assert.match(out, /⚠️ vague/);
  });

  it('handles an empty catalog gracefully', () => {
    const out = renderCatalog([]);
    assert.match(out, /no workflows found/);
  });
});
