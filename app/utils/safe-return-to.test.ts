import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  PRICING_RETURN_TO,
  resolveSafeReturnTo,
} from './safe-return-to.ts'

describe('resolveSafeReturnTo', () => {
  it('accepts only the exact Pricing allowlist path', () => {
    assert.equal(resolveSafeReturnTo(PRICING_RETURN_TO), PRICING_RETURN_TO)
  })

  it('rejects external, protocol-relative, backslash, malformed, and other paths', () => {
    const rejected = [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/%2f%2fevil.example',
      '/dashboard',
      '/dashboard/billing',
      '/dashboard/billing/success',
      '/dashboard/billing/cancel',
      '/pricing/extra',
      '/pricing?x=1',
      '/pricing#frag',
      'pricing',
      '',
      '   ',
      null,
      undefined,
      42,
      '/login',
    ]

    for (const value of rejected) {
      assert.equal(resolveSafeReturnTo(value), '/')
    }
  })

  it('uses a custom fallback when provided', () => {
    assert.equal(resolveSafeReturnTo('/evil', '/home'), '/home')
  })
})
