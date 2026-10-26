/**
 * The effective `sensitivePaths` map: the shipped manifest's classes merged
 * with the consumer's `delivery.codeReview.sensitivePaths`. The merge is
 * additive only, so consumer config can make review stricter, never looser.
 */

/**
 * @typedef {{ description?: string, filePatterns: string[] }} SensitivePathClass
 * @typedef {Record<string, { description?: string, filePatterns?: string[] }>} SensitivePathMap
 */

/**
 * @param {{
 *   rules?: { sensitivePaths?: SensitivePathMap }|null,
 *   config?: { delivery?: { codeReview?: { sensitivePaths?: SensitivePathMap } } }|null,
 * }} [params]
 * @returns {Record<string, SensitivePathClass>} Shipped classes in manifest
 *   order (consumer patterns appended, de-duplicated), then consumer-only
 *   classes in config order.
 */
export function resolveSensitivePaths({ rules, config } = {}) {
  const merged = {};
  for (const [name, entry] of Object.entries(rules?.sensitivePaths ?? {})) {
    merged[name] = { ...entry, filePatterns: [...(entry?.filePatterns ?? [])] };
  }
  const consumer = config?.delivery?.codeReview?.sensitivePaths ?? {};
  for (const [name, entry] of Object.entries(consumer)) {
    const patterns = entry?.filePatterns ?? [];
    const shipped = merged[name];
    if (shipped) {
      shipped.filePatterns = [
        ...new Set([...shipped.filePatterns, ...patterns]),
      ];
    } else {
      merged[name] = { ...entry, filePatterns: [...new Set(patterns)] };
    }
  }
  return merged;
}
