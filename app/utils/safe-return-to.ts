/**
 * Exact allowlist for post-login return destinations used by Checkout entry.
 * Only `/pricing` is accepted; everything else falls back to the home page.
 */

export const PRICING_RETURN_TO = '/pricing' as const

const ALLOWED_RETURN_TO = new Set<string>([PRICING_RETURN_TO])

/**
 * Resolve a framework-parsed `returnTo` query value.
 * Accepts only the exact allowlisted path. Rejects absolute URLs,
 * protocol-relative URLs, backslash-confused values, encoded externals,
 * and any other unapproved path.
 */
export function resolveSafeReturnTo(
  raw: unknown,
  fallback = '/',
): string {
  if (typeof raw !== 'string') {
    return fallback
  }

  // Reject whitespace, empty, absolute, protocol-relative, backslash, query/hash.
  if (
    raw.length === 0
    || raw !== raw.trim()
    || raw.includes('\\')
    || raw.includes('://')
    || raw.startsWith('//')
    || raw.includes('?')
    || raw.includes('#')
    || !raw.startsWith('/')
    || raw.startsWith('//')
  ) {
    return fallback
  }

  // Normalize trailing slash only for root-style; exact match required.
  if (!ALLOWED_RETURN_TO.has(raw)) {
    return fallback
  }

  return raw
}
