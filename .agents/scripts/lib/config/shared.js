/** Merge primitives shared by two or more config resolvers. */

/**
 * An array replaces the default; `{ append, prepend }` extends it, deduped.
 *
 * @param {readonly string[]} defaultList
 * @param {unknown} userValue
 * @returns {string[]}
 */
export function resolveListValue(defaultList, userValue) {
  if (userValue === undefined) return [...defaultList];
  if (Array.isArray(userValue)) return [...userValue];
  if (userValue !== null && typeof userValue === 'object') {
    const result = [];
    const seen = new Set();
    const push = (item) => {
      if (!seen.has(item)) {
        result.push(item);
        seen.add(item);
      }
    };
    if (Array.isArray(userValue.prepend)) {
      for (const item of userValue.prepend) push(item);
    }
    for (const item of defaultList) push(item);
    if (Array.isArray(userValue.append)) {
      for (const item of userValue.append) push(item);
    }
    return result;
  }
  return [...defaultList];
}
