/**
 * The shared shell of an adapter that scans source files line by line for an
 * inline comment shape: it applies when any scoped file matches `extRe`, and
 * extracts `fileRecords(ctx, file)` over each matching file.
 *
 * @module lib/audit-exceptions/adapters/source-scan
 */

/**
 * @param {{ id: string, extRe: RegExp, fileRecords: (ctx: object, file: string) => object[] }} spec
 * @returns {Readonly<object>}
 */
export function sourceScanAdapter({ id, extRe, fileRecords }) {
  return Object.freeze({
    id,
    category: 'inline',
    applies: (ctx) =>
      ctx.scope.files.some((f) => extRe.test(f))
        ? { applies: true, reason: 'source files present' }
        : { applies: false, reason: 'no scannable source files' },
    extract: (ctx) =>
      ctx.scope.files
        .filter((f) => extRe.test(f))
        .flatMap((f) => fileRecords(ctx, f)),
  });
}
