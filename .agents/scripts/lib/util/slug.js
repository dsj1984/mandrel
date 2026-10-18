/**
 * `[a-z0-9]` dash slug, capped at `max`; `fallback` when nothing survives.
 * `git-utils.js` `slugify` keeps a wider charset.
 */
export function slugifyLabel(text, { max, fallback }) {
  let slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (max !== undefined) slug = slug.slice(0, max).replace(/-+$/, '');
  return slug === '' ? fallback : slug;
}
