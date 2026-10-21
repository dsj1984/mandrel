/** Escape every RegExp metacharacter in `text` so it matches literally. */
export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
