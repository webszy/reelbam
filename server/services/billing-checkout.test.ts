import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertCreemPaymentEnabled,
  parseCheckoutPriceCode,
  parseIdempotencyKey,
} from './billing-checkout.ts'
import {
  buildCheckoutSuccessUrl,
  resolveTrustedAppOrigin,
} from '../utils/zBilling/application/create-checkout.ts'
import {
  resolveExistingCheckoutOrder,
  type BillingOrderRow,
} from '../utils/zBilling/domain/order.ts'
import { CheckoutError, AppError } from '../utils/errors.ts'

function assertCheckoutError(fn: () => void, code: string) {
  try {
    fn()
    assert.fail(`expected CheckoutError ${code}`)
  }
  catch (error) {
    assert.ok(error instanceof CheckoutError)
    assert.equal(error.code, code)
  }
}

function assertServiceUnavailable(fn: () => void) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof AppError)
    assert.equal(error.code, 'SERVICE_UNAVAILABLE')
    return true
  })
}

describe('assertCreemPaymentEnabled', () => {
  it('allows only the derived boolean true', () => {
    assert.doesNotThrow(() => assertCreemPaymentEnabled(true))

    for (const value of [undefined, null, false, '', 'true', 1]) {
      assertServiceUnavailable(() => assertCreemPaymentEnabled(value))
    }
  })
})

describe('parseIdempotencyKey', () => {
  it('accepts 1–128 visible safe ASCII characters', () => {
    assert.equal(parseIdempotencyKey('a'), 'a')
    assert.equal(parseIdempotencyKey('A'.repeat(128)), 'A'.repeat(128))
    assert.equal(
      parseIdempotencyKey('550e8400-e29b-41d4-a716-446655440000'),
      '550e8400-e29b-41d4-a716-446655440000',
    )
  })

  it('rejects missing, empty, whitespace, control, and overlong keys', () => {
    assertCheckoutError(() => parseIdempotencyKey(undefined), 'INVALID_IDEMPOTENCY_KEY')
    assertCheckoutError(() => parseIdempotencyKey(''), 'INVALID_IDEMPOTENCY_KEY')
    assertCheckoutError(() => parseIdempotencyKey('has space'), 'INVALID_IDEMPOTENCY_KEY')
    assertCheckoutError(() => parseIdempotencyKey('tab\there'), 'INVALID_IDEMPOTENCY_KEY')
    assertCheckoutError(() => parseIdempotencyKey('A'.repeat(129)), 'INVALID_IDEMPOTENCY_KEY')
  })
})

describe('parseCheckoutPriceCode', () => {
  it('accepts the three enabled one-time credit packs', () => {
    const priceCodes = [
      'credit_pack_5_usd',
      'credit_pack_10_usd',
      'credit_pack_30_usd',
    ]

    for (const priceCode of priceCodes) {
      assert.equal(
        parseCheckoutPriceCode({ priceCode }),
        priceCode,
      )
    }
  })

  it('rejects recurring and unknown price codes', () => {
    assert.throws(() => parseCheckoutPriceCode({ priceCode: 'plus_monthly_usd' }))
    assert.throws(() => parseCheckoutPriceCode({ priceCode: 'plus_yearly_usd' }))
    assert.throws(() => parseCheckoutPriceCode({ priceCode: 'credit_pack_20_usd' }))
    assert.throws(() => parseCheckoutPriceCode({ priceCode: 'credit_pack_50_usd' }))
    assert.throws(() => parseCheckoutPriceCode({ priceCode: 'unknown' }))
    assert.throws(() => parseCheckoutPriceCode({}))
    assert.throws(() => parseCheckoutPriceCode(null))
  })
})

describe('resolveTrustedAppOrigin', () => {
  function makeEvent(env: Record<string, unknown>) {
    return {
      context: {
        cloudflare: { env },
      },
    } as unknown as Parameters<typeof resolveTrustedAppOrigin>[0]
  }

  it('defaults to localhost only in development when app URL is missing', () => {
    assert.equal(
      resolveTrustedAppOrigin(makeEvent({ APP_ENVIRONMENT: 'development' })),
      'http://localhost:3000',
    )
  })

  it('accepts an explicit HTTPS pure origin outside development', () => {
    assert.equal(
      resolveTrustedAppOrigin(makeEvent({
        APP_ENVIRONMENT: 'production',
        APP_URL: 'https://example.com',
      })),
      'https://example.com',
    )
  })

  it('rejects missing/non-https/path/query/fragment/userinfo outside development', () => {
    const cases = [
      { APP_ENVIRONMENT: 'production' },
      { APP_ENVIRONMENT: 'production', APP_URL: 'http://example.com' },
      { APP_ENVIRONMENT: 'production', APP_URL: 'https://example.com/path' },
      { APP_ENVIRONMENT: 'production', APP_URL: 'https://example.com?x=1' },
      { APP_ENVIRONMENT: 'production', APP_URL: 'https://example.com#frag' },
      { APP_ENVIRONMENT: 'production', APP_URL: 'https://user:pass@example.com' },
      { APP_ENVIRONMENT: 'staging', APP_URL: '' },
    ]

    for (const env of cases) {
      assert.throws(() => resolveTrustedAppOrigin(makeEvent(env)))
    }
  })
})

describe('buildCheckoutSuccessUrl', () => {
  it('builds a server-owned success URL with the local order id', () => {
    assert.equal(
      buildCheckoutSuccessUrl('https://example.com', 'order-1'),
      'https://example.com/pricing?order=order-1',
    )
  })
})

describe('resolveExistingCheckoutOrder', () => {
  function baseOrder(overrides: Partial<BillingOrderRow>): BillingOrderRow {
    return {
      id: 'order-1',
      userId: 'user-1',
      productId: 'prod-1',
      priceId: 'price-1',
      customerId: null,
      subscriptionId: null,
      status: 'pending',
      amount: 499,
      currency: 'USD',
      providerPaidAmount: null,
      refundVersion: 0,
      productNameSnapshot: '5 Credits',
      priceCodeSnapshot: 'credit_pack_5_usd',
      entitlementSnapshot: [],
      provider: 'creem',
      providerCheckoutId: null,
      providerCheckoutUrl: null,
      providerOrderId: null,
      checkoutIdempotencyKey: 'key-1',
      failureCode: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      paidAt: null,
      failedAt: null,
      expiredAt: null,
      refundedAt: null,
      ...overrides,
    }
  }

  it('replays a stored checkout URL for the same price', () => {
    const result = resolveExistingCheckoutOrder(
      baseOrder({
        providerCheckoutUrl: 'https://checkout.creem.io/ch_1',
        providerCheckoutId: 'ch_1',
      }),
      'credit_pack_5_usd',
    )
    assert.equal(result.checkoutUrl, 'https://checkout.creem.io/ch_1')
  })

  it('returns IDEMPOTENCY_KEY_REUSED for a different price code', () => {
    assertCheckoutError(
      () => resolveExistingCheckoutOrder(
        baseOrder({ priceCodeSnapshot: 'credit_pack_10_usd' }),
        'credit_pack_5_usd',
      ),
      'IDEMPOTENCY_KEY_REUSED',
    )
  })

  it('returns CHECKOUT_FAILED for a failed order', () => {
    assertCheckoutError(
      () => resolveExistingCheckoutOrder(
        baseOrder({ status: 'failed' }),
        'credit_pack_5_usd',
      ),
      'CHECKOUT_FAILED',
    )
  })

  it('returns CHECKOUT_CREATION_UNKNOWN for uncertain pending orders', () => {
    assertCheckoutError(
      () => resolveExistingCheckoutOrder(
        baseOrder({ failureCode: 'CHECKOUT_CREATION_UNKNOWN' }),
        'credit_pack_5_usd',
      ),
      'CHECKOUT_CREATION_UNKNOWN',
    )
  })

  it('returns CHECKOUT_IN_PROGRESS for pending orders without a URL', () => {
    assertCheckoutError(
      () => resolveExistingCheckoutOrder(
        baseOrder({ status: 'pending', failureCode: null }),
        'credit_pack_5_usd',
      ),
      'CHECKOUT_IN_PROGRESS',
    )
  })
})
