import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  calculateForFile,
  calculateReportForFile,
} from '../.agents/scripts/lib/maintainability-engine.js';
import { transpileIfNeeded } from '../.agents/scripts/lib/transpile.js';

/**
 * Acceptance criterion (Story #829, 5.29.0): the maintainability score
 * for a TS source must equal the score for the same logic written in JS.
 * The strip-then-analyze pipeline removes type annotations before feeding
 * source to escomplex; type annotations carry no control flow, so the
 * metric must be invariant under them.
 *
 * The TSX case adds JSX. With `JsxEmit.ReactJSX` the transpiler emits
 * `_jsx(...)` calls escomplex can parse; we don't assert numeric parity
 * with a JS variant (JSX has no plain-JS analogue) but we do assert the
 * file scores cleanly (parseError === false, score > 0).
 */

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mi_ts_fixture_'));
}

function rmTmp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

const JS_SOURCE = `
export function classify(name) {
  if (!name) return 'empty';
  if (name.length > 10) return 'long';
  if (name.length > 5) return 'medium';
  return 'short';
}

export function tally(items) {
  let count = 0;
  for (const item of items) {
    if (item && item.active) {
      count += 1;
    }
  }
  return count;
}
`;

const TS_SOURCE = `
export function classify(name: string | null | undefined): 'empty' | 'long' | 'medium' | 'short' {
  if (!name) return 'empty';
  if (name.length > 10) return 'long';
  if (name.length > 5) return 'medium';
  return 'short';
}

interface Item {
  active: boolean;
}

export function tally(items: ReadonlyArray<Item | null | undefined>): number {
  let count: number = 0;
  for (const item of items) {
    if (item && item.active) {
      count += 1;
    }
  }
  return count;
}
`;

const TSX_SOURCE = `
interface Props {
  name: string;
  count: number;
}

export function Greeting({ name, count }: Props) {
  if (count > 0) {
    return <div className="hi">Hello {name} ({count})</div>;
  }
  return <div>Hello {name}</div>;
}
`;

test('maintainability-engine — JS and equivalent TS produce identical scores', () => {
  const dir = mkTmp();
  try {
    const jsPath = path.join(dir, 'mod.js');
    const tsPath = path.join(dir, 'mod.ts');
    fs.writeFileSync(jsPath, JS_SOURCE);
    fs.writeFileSync(tsPath, TS_SOURCE);

    const jsScore = calculateForFile(jsPath);
    const tsScore = calculateForFile(tsPath);
    assert.ok(typeof jsScore === 'number' && jsScore > 0);
    assert.strictEqual(
      tsScore,
      jsScore,
      `TS score (${tsScore}) must equal JS score (${jsScore}) — type annotations carry no control flow`,
    );
  } finally {
    rmTmp(dir);
  }
});

test('maintainability-engine — equivalent TS report has identical per-method shape to JS', () => {
  const dir = mkTmp();
  try {
    const jsPath = path.join(dir, 'mod.js');
    const tsPath = path.join(dir, 'mod.ts');
    fs.writeFileSync(jsPath, JS_SOURCE);
    fs.writeFileSync(tsPath, TS_SOURCE);

    const jsReport = calculateReportForFile(jsPath);
    const tsReport = calculateReportForFile(tsPath);

    assert.strictEqual(jsReport.parseError, false);
    assert.strictEqual(tsReport.parseError, false);
    assert.strictEqual(tsReport.moduleScore, jsReport.moduleScore);
    assert.strictEqual(tsReport.methods.length, jsReport.methods.length);
    for (let i = 0; i < jsReport.methods.length; i += 1) {
      assert.strictEqual(
        tsReport.methods[i].cyclomatic,
        jsReport.methods[i].cyclomatic,
        `method[${i}].cyclomatic must match (TS strip is control-flow preserving)`,
      );
      assert.strictEqual(
        tsReport.methods[i].maintainability,
        jsReport.methods[i].maintainability,
      );
    }
  } finally {
    rmTmp(dir);
  }
});

test('maintainability-engine — TSX source scores cleanly via JsxEmit.ReactJSX', () => {
  const dir = mkTmp();
  try {
    const tsxPath = path.join(dir, 'Greeting.tsx');
    fs.writeFileSync(tsxPath, TSX_SOURCE);

    const score = calculateForFile(tsxPath);
    assert.ok(typeof score === 'number' && score > 0);

    const report = calculateReportForFile(tsxPath);
    assert.strictEqual(report.parseError, false);
    // The Greeting function has one branch (if count > 0) → cyclomatic ≥ 2.
    const greeting = report.methods.find((m) => m.name === 'Greeting');
    assert.ok(greeting, 'expected Greeting method in escomplex output');
    assert.ok(greeting.cyclomatic >= 2);
  } finally {
    rmTmp(dir);
  }
});

test('transpileIfNeeded — passthrough for .js / .mjs / .cjs', () => {
  const src = 'const x = 1;';
  assert.strictEqual(transpileIfNeeded('foo.js', src), src);
  assert.strictEqual(transpileIfNeeded('foo.mjs', src), src);
  assert.strictEqual(transpileIfNeeded('foo.cjs', src), src);
});

test('transpileIfNeeded — strips type annotations from .ts source', () => {
  const out = transpileIfNeeded('foo.ts', 'const x: number = 1;');
  assert.ok(typeof out === 'string');
  assert.ok(!out.includes(': number'), 'type annotation must be stripped');
  assert.ok(out.includes('const x = 1'));
});
