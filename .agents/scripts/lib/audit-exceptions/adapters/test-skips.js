/**
 * Test exemptions: `.skip` / `.todo` / `.fixme`, `x`-prefixed suites, and the
 * `node:test` `{ skip }` / `{ todo }` option. A skip conditioned on the
 * platform is legitimately forever and carries a `permanentHint`; a string
 * skip value is its own justification.
 *
 * @module lib/audit-exceptions/adapters/test-skips
 */

import { insideString, readText } from '../read.js';
import { makeRecord } from '../record.js';

const TEST_FILE_RE =
  /(?:^|\/)(?:__tests__|tests?|spec|e2e)\/.*\.[cm]?[jt]sx?$|\.(?:test|spec)\.[cm]?[jt]sx?$/;

const CALL_RE =
  /\b(?:(?:it|test|describe|suite)\.(skip|todo|fixme)|(x)(?:it|describe|test))\s*\(\s*(['"`])((?:(?!\3).)*)\3/;
/**
 * The `node:test` options object — as the second argument of a test call, or
 * bound to a constant (`const POSIX_ONLY = { skip: … }`) — never an arbitrary
 * object literal that happens to carry a `skip` key.
 */
const OPTION_RE =
  /(?:\b(?:it|test|describe|suite)\s*\(\s*(['"`])(?:(?!\1).)*\1\s*,\s*|^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*)\{[^{}]*\b(skip|todo)\s*:\s*([^,}]+)/;
const PLATFORM_RE =
  /process\.platform|os\.platform\(\)|\bisWindows\b|\bIS_WINDOWS\b|win32|darwin/;

function optionHit(line) {
  const m = OPTION_RE.exec(line);
  if (!m || insideString(line, m.index)) return null;
  const value = m[3].trim();
  if (/^(?:false|undefined|null)$/.test(value)) return null;
  const literal = /^(['"`])(.*)\1$/.exec(value)?.[2];
  const platform = PLATFORM_RE.test(value);
  // A condition states its own reason: the test cannot run where it holds.
  const conditional = value === 'true' ? null : `conditional: ${value}`;
  return {
    kind: m[2],
    reason: literal ?? conditional,
    permanentHint: platform ? 'platform-conditional' : null,
  };
}

function matchLine(line) {
  const call = CALL_RE.exec(line);
  if (call && insideString(line, call.index)) return null;
  if (call) {
    const kind = call[1] ?? 'skip';
    return {
      kind,
      reason: kind === 'skip' ? null : call[4],
      permanentHint: null,
    };
  }
  return optionHit(line);
}

function fileRecords(ctx, file) {
  const lines = (readText(ctx.root, file) ?? '').split('\n');
  const records = [];
  lines.forEach((line, i) => {
    const hit = matchLine(line);
    if (!hit) return;
    const prev = lines[i - 1]?.trim() ?? '';
    records.push(
      makeRecord({
        adapter: 'test-skips',
        category: 'test',
        surface: 'test-runner',
        file,
        line: i + 1,
        target: hit.kind,
        rule: hit.kind,
        justification:
          hit.reason ??
          (prev.startsWith('//') ? prev.replace(/^\/+\s*/, '') : null),
        permanentHint: hit.permanentHint,
      }),
    );
  });
  return records;
}

export const testSkips = Object.freeze({
  id: 'test-skips',
  category: 'test',
  applies: (ctx) =>
    ctx.scope.files.some((f) => TEST_FILE_RE.test(f))
      ? { applies: true, reason: 'test files present' }
      : { applies: false, reason: 'no test files' },
  extract: (ctx) =>
    ctx.scope.files
      .filter((f) => TEST_FILE_RE.test(f))
      .flatMap((f) => fileRecords(ctx, f)),
});
