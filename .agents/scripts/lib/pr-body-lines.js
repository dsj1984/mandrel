/** pr-body-lines.js — keep a block of owned PR-body lines beneath `Closes #<id>`. */

/** `lines` minus owned lines and the blank line each one follows. */
function withoutOwnedLines(lines, isOwned) {
  const kept = [];
  for (const line of lines) {
    if (!isOwned(line)) kept.push(line);
    else if (kept.at(-1) === '') kept.pop();
  }
  return kept;
}

/** The index just beneath `Closes #<id>`, else the end. */
function closesSlot(lines) {
  const at = lines.findIndex((line) => /^Closes #\d+/.test(line));
  return at === -1 ? lines.length : at + 1;
}

/**
 * `body` with every line `isOwned` claims replaced by `block`, placed beneath
 * `Closes #<id>` (appended when that line is missing).
 *
 * @param {string|null|undefined} body
 * @param {(line: string) => boolean} isOwned
 * @param {string[]} block
 * @returns {string}
 */
export function replaceBeneathCloses(body, isOwned, block) {
  const kept = withoutOwnedLines(String(body ?? '').split(/\r?\n/), isOwned);
  kept.splice(closesSlot(kept), 0, ...block);
  return kept.join('\n');
}
