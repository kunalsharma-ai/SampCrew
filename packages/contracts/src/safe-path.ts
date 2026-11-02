/**
 * The page to go to after signing in, from a `?next=` value anyone can put in a link. Only a path on this same site
 * is accepted; anything else becomes `fallback`. Browsers read a backslash as a slash, so `/\evil.example` would
 * leave the site just like `//evil.example`; control characters and whitespace are refused too.
 */
export function safeNextPath(value: string | null | undefined, fallback = '/'): string {
  if (!value || value.length > 2000) return fallback;
  if (!value.startsWith('/')) return fallback;
  if (value[1] === '/' || value[1] === '\\') return fallback;
  if (/[\u0000-\u001f\u007f\\\s]/.test(value)) return fallback;
  try {
    const u = new URL(value, 'https://crew.invalid');
    if (u.origin !== 'https://crew.invalid') return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}
