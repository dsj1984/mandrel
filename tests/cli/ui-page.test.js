// tests/cli/ui-page.test.js — the `mandrel ui` page: no inline script or
// style, same-origin references only, the fixed test ids, and a script that
// builds content from text nodes and never assigns raw HTML.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const UI_DIR = path.join(ROOT, 'lib', 'cli', 'ui');
const read = (name) => fs.readFileSync(path.join(UI_DIR, name), 'utf8');

const html = read('board.html');
const script = read('board.js');
const css = read('board.css');

/** Test ids the Spec lists that are not generated per item. */
const FIXED_TEST_IDS = [
  'board',
  'zone-verdict',
  'tab-board',
  'tab-environments',
  'connections-button',
  'connections-dialog',
  'confirm-stop',
  'toast',
  'theme-toggle',
  'column-backlog',
  'column-planning',
  'column-ready',
  'column-delivering',
  'column-blocked',
  'column-done',
];

/** Per-item ids the script generates. */
const GENERATED_TEST_IDS = ['lane-', 'card-', 'card-move-', 'env-card-'];

describe('AC-8: the served HTML', () => {
  it('has no inline script, inline style or event-handler attribute', () => {
    const scripts = [
      ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g),
    ];
    assert.ok(scripts.length > 0);
    for (const [, attrs, body] of scripts) {
      assert.match(attrs, /\bsrc="/, 'every script is a file');
      assert.equal(body.trim(), '', 'no inline script body');
    }
    assert.doesNotMatch(html, /<style\b/i);
    assert.doesNotMatch(html, /\sstyle\s*=/i);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(html, /javascript:/i);
  });

  it('references only same-origin files', () => {
    const refs = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(refs.sort(), ['/board.css', '/board.js']);
    assert.doesNotMatch(html, /\/\/[a-z0-9.-]+\.[a-z]{2,}/i, 'no absolute URL');
  });

  it('contains each fixed data-testid exactly once', () => {
    for (const id of FIXED_TEST_IDS) {
      const count = html.split(`data-testid="${id}"`).length - 1;
      assert.equal(count, 1, id);
    }
  });

  it('carries the token placeholder the server replaces', () => {
    assert.match(
      html,
      /<meta name="mandrel-token" content="__MANDREL_TOKEN__">/,
    );
  });
});

describe('AC-10: the served script', () => {
  it('never assigns raw HTML', () => {
    for (const sink of [
      /\.innerHTML\b/,
      /\.outerHTML\b/,
      /insertAdjacentHTML/,
      /document\.write/,
      /\beval\s*\(/,
      /new Function\b/,
      /createContextualFragment/,
    ]) {
      assert.doesNotMatch(script, sink);
    }
  });

  it('builds content from text nodes and attributes', () => {
    assert.match(script, /\.textContent = /);
    assert.match(script, /document\.createElement\(tag\)/);
    assert.match(script, /node\.append\(child\)/);
  });

  it('generates the per-item test ids', () => {
    for (const prefix of GENERATED_TEST_IDS) {
      assert.ok(script.includes(`'data-testid': \`${prefix}`), prefix);
    }
  });

  it('imports only the same-origin view model', () => {
    const imports = [...script.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(imports, ['./board-model.js']);
  });

  it('decides no drop itself: every verdict comes from the view model', () => {
    assert.doesNotMatch(script, /agent::/);
    assert.doesNotMatch(script, /\.drops\b/);
  });
});

describe('the stylesheet', () => {
  it('defines the light and dark tokens with a manual override', () => {
    for (const token of [
      '--bg: #f5f6f7',
      '--accent: #2563eb',
      '--red: #c0352d',
    ]) {
      assert.ok(css.includes(token), token);
    }
    assert.match(
      css,
      /@media \(prefers-color-scheme: dark\)\s*{\s*:root:not\(\[data-theme="light"\]\)/,
    );
    assert.match(css, /:root\[data-theme="dark"\]\s*{[^}]*--bg: #111316/);
  });
});

describe('AC-11: no new dependency', () => {
  it('imports only Node built-ins and relative modules in the server code', () => {
    for (const file of [
      'server.js',
      'sources.js',
      'request-guard.js',
      'board-model.js',
    ]) {
      const source = read(file);
      for (const [, spec] of source.matchAll(
        /^import [^;]*? from '([^']+)';$/gms,
      )) {
        assert.ok(
          spec.startsWith('node:') || spec.startsWith('.'),
          `${file}: ${spec}`,
        );
      }
    }
  });
});
