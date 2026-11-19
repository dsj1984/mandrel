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
  'panel-environments-button',
  'panel-environments-offline-count',
  'panel-connections-button',
  'panel-settings-button',
  'done-count',
  'confirm-stop',
  'toast',
  'column-backlog',
  'column-planning',
  'column-ready',
  'column-delivering',
  'column-blocked',
  'column-done',
  'side-panel',
  'side-panel-close',
  'assignee-filter',
  'assignee-filter-summary',
  'assignee-filter-menu',
  'status-filter',
  'status-filter-summary',
  'status-filter-menu',
  'launch-options-dialog',
  'launch-options-model',
  'launch-options-effort',
  'launch-options-effective',
  'launch-options-save',
];

/** Ids the header tabs and the Connections dialog carried before the panel views. */
const REMOVED_TEST_IDS = [
  'tab-board',
  'tab-environments',
  'connections-button',
  'connections-dialog',
  'theme-toggle',
];

/** The Environments and Connections panel views' ids, set by the script. */
const PANEL_VIEW_TEST_IDS = [
  'environments-view',
  'connections-view',
  'connections-github-login',
  'connections-claude-account',
  'settings-view',
  'settings-theme',
  'settings-done-limit',
  'settings-refresh',
  'settings-reset',
];

/** Per-item ids the script generates. */
const GENERATED_TEST_IDS = [
  'lane-',
  'card-',
  'card-move-',
  'env-card-',
  'card-status-',
  'card-liveness-',
  'card-details-',
  'card-settings-',
];

/** The Story detail view's ids, set once by the script. */
const DETAIL_TEST_IDS = [
  'story-detail',
  'story-detail-log',
  'story-detail-resume-copy',
  'story-detail-issue-link',
];

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

  it('sets the Story detail view test ids', () => {
    for (const id of DETAIL_TEST_IDS) {
      assert.ok(script.includes(`'${id}'`), id);
    }
  });

  it('opens new-tab links without an opener or referrer', () => {
    assert.match(script, /rel: 'noopener noreferrer'/);
    assert.doesNotMatch(script, /rel: 'noreferrer'/);
  });

  it('opens the detail view from double-click, the context menu, Enter or Space, and the details button', () => {
    for (const trigger of [
      /addEventListener\('dblclick'/,
      /addEventListener\('contextmenu'/,
      /event\.key !== 'Enter' && event\.key !== ' '/,
      /details\.addEventListener\('click', \(\) => toggleDetail/,
    ]) {
      assert.match(script, trigger);
    }
  });

  it('closes the side panel on Esc and its close button', () => {
    assert.match(script, /event\.key !== 'Escape'/);
    assert.match(
      script,
      /'side-panel-close'\)\.addEventListener\('click', closePanel\)/,
    );
  });

  it('runs panel actions through perform, so Stop still confirms', () => {
    assert.match(
      script,
      /item\.addEventListener\('click', \(\) => perform\(story, option\)\)/,
    );
    assert.match(script, /\$\('confirm-stop'\)\.showModal\(\)/);
  });

  it('imports only the same-origin view models', () => {
    const imports = [...script.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(imports, [
      './board-filter.js',
      './board-model.js',
      './panel-model.js',
      './preferences.js',
    ]);
  });

  it('decides no drop itself: every verdict comes from the view model', () => {
    assert.doesNotMatch(script, /agent::/);
    assert.doesNotMatch(script, /\.drops\b/);
  });
});

describe('AC-10: the launch-options dialog', () => {
  it('is a modal dialog whose selects each open on "Use default" and save through the endpoint', () => {
    assert.match(
      html,
      /<dialog class="panel" id="launch-options-dialog" data-testid="launch-options-dialog"/,
    );
    for (const id of ['launch-options-model', 'launch-options-effort']) {
      assert.match(html, new RegExp(`<label for="${id}">`));
    }
    assert.match(script, /\$\('launch-options-dialog'\)\.showModal\(\)/);
    assert.match(script, /api\('\/api\/launch-options', body\)/);
    assert.match(script, /'✎'/);
  });
});

describe('AC-9: the side panel', () => {
  it('is a non-modal aside, not a dialog, hidden until opened', () => {
    assert.match(
      html,
      /<aside class="side-panel" id="side-panel" data-testid="side-panel"[^>]* hidden>/,
    );
    assert.doesNotMatch(html, /<dialog[^>]*side-panel/);
    assert.doesNotMatch(script, /'side-panel'\)\.showModal/);
  });
});

describe('AC-4, AC-5: the header and the panel views', () => {
  it('has no tabs, Environments tabpanel or Connections dialog', () => {
    for (const id of REMOVED_TEST_IDS) {
      assert.equal(html.includes(`"${id}"`), false, id);
      assert.equal(script.includes(`'${id}'`), false, id);
    }
    assert.doesNotMatch(html, /role="tab(list|panel)?"/);
    assert.doesNotMatch(html, /id="environments"/);
    assert.doesNotMatch(html, /connections-dialog/);
    assert.match(html, /<dialog class="panel" id="confirm-stop"/);
  });

  it('gives each icon button an aria-label, a title and aria-expanded', () => {
    for (const id of [
      'panel-environments-button',
      'panel-connections-button',
      'panel-settings-button',
    ]) {
      const tag = html.match(new RegExp(`<button [^>]*id="${id}"[^>]*>`))[0];
      assert.match(tag, /aria-label="[^"]+"/, id);
      assert.match(tag, /title="[^"]+"/, id);
      assert.match(tag, /aria-expanded="false"/, id);
      assert.match(tag, /aria-controls="side-panel"/, id);
    }
    assert.equal(html.match(/<svg [^>]*stroke="currentColor"/g).length, 3);
  });

  it('opens each view from its button and reflects it in aria-expanded', () => {
    assert.match(
      script,
      /\$\(id\)\.addEventListener\('click', \(\) => togglePanel\(view\)\)/,
    );
    assert.match(
      script,
      /setAttribute\('aria-expanded', String\(view === name\)\)/,
    );
    assert.match(script, /nextPanelView\(ui\.view, view\)/);
  });

  it('sets the panel view test ids', () => {
    const models = read('panel-model.js') + read('preferences.js');
    for (const id of PANEL_VIEW_TEST_IDS) {
      assert.ok(script.includes(`'${id}'`) || models.includes(`'${id}'`), id);
    }
  });
});

describe('AC-3, AC-6: Settings', () => {
  it('opens Settings from the gear like any other panel view', () => {
    assert.match(script, /settings: 'panel-settings-button'/);
    assert.match(script, /ui\.view === 'settings'\) \{\s*renderSettings\(\)/);
  });

  it('has no More menu and no theme control outside Settings', () => {
    assert.deepEqual(
      [...html.matchAll(/<details\b[^>]*id="([^"]+)"/g)].map((m) => m[1]),
      ['status-filter', 'assignee-filter'],
    );
    assert.doesNotMatch(html, /More options/);
    assert.doesNotMatch(script, /mandrel-ui-theme|nextTheme/);
    assert.doesNotMatch(css, /\.overflow\b/);
  });

  it('labels every control and applies a change with no Save button', () => {
    assert.match(
      script,
      /el\('label', \{ for: field\.testId \}, field\.label\)/,
    );
    assert.match(script, /addEventListener\('change'/);
    assert.doesNotMatch(script, />\s*Save\b|'Save'/);
  });

  it('AC-8: reads the board through the done query and writes nothing but browser storage', () => {
    assert.match(script, /`\/api\/state\?done=\$\{ui\.prefs\.doneLimit\}`/);
    assert.equal(script.match(/api\('\/api\/action'/g).length, 1);
    assert.doesNotMatch(script, /localStorage\.(set|get|remove)Item/);
  });
});

describe('the stylesheet', () => {
  it('AC-8: lets the hidden attribute win over any display rule', () => {
    assert.match(css, /\[hidden\] \{[^}]*display: none !important;\s*\}/);
    assert.doesNotMatch(css, /:not\(\[hidden\]\)/);
  });

  it('AC-11: stops the pulse under prefers-reduced-motion', () => {
    assert.match(css, /\.liveness\.working \.dot \{[^}]*animation: pulse/);
    assert.match(
      css,
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.liveness\.working \.dot,[^{]*\{\s*animation: none;/,
    );
  });

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
      'panel-model.js',
      'preferences.js',
      'accounts.js',
      'story-detail.js',
      'log-tail.js',
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
