import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  buildCheckoutSuccessUrl,
  initiateCheckout,
  resolveTrustedAppOrigin,
} from '../application/create-checkout.ts'
import {
  resolveExistingCheckoutOrder,
  type BillingOrderRow,
} from '../domain/order.ts'
import {
  parseCheckoutPriceCode,
  parseIdempotencyKey,
} from '../../../services/billing-checkout.ts'
import { CheckoutError } from '../../errors.ts'
import type { Database } from '../../../database/client.ts'
import type {
  billingProducts} from '../../../database/schema/index.ts';
import {
  billingOrders,
  billingPrices,
  productEntitlements,
} from '../../../database/schema/index.ts'
import type { LocalUser } from '../../../services/user-profile.ts'

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

type ProductRow = typeof billingProducts.$inferSelect
type PriceRow = typeof billingPrices.$inferSelect
type EntitlementRow = typeof productEntitlements.$inferSelect
interface FetchStub {
  (url: unknown, options?: unknown): Promise<unknown>
  raw: (
    url: unknown,
    options?: unknown,
  ) => Promise<{ status: number, _data: unknown }>
}

interface TestGlobals {
  $fetch?: FetchStub
}

interface FetchCall {
  url: string
  options: {
    method?: string
    body?: Record<string, unknown>
  }
}

const TEST_DATE = new Date('2026-08-07T00:00:00.000Z')
const TEST_PRODUCT: ProductRow = {
  id: 'product-credit-5',
  code: 'credit_pack_5',
  name: '5 Credits',
  description: 'One-time pack of 5 credits',
  productKind: 'credit_pack',
  active: true,
  metadata: null,
  createdAt: TEST_DATE,
  updatedAt: TEST_DATE,
}
const TEST_PRICE: PriceRow = {
  id: 'price-credit-5',
  productId: TEST_PRODUCT.id,
  code: 'credit_pack_5_usd',
  billingType: 'one_time',
  billingInterval: null,
  intervalCount: null,
  amount: 499,
  currency: 'USD',
  provider: 'creem',
  providerProductId: 'creem-product-credit-5',
  providerPriceId: null,
  active: true,
  createdAt: TEST_DATE,
  updatedAt: TEST_DATE,
}
const TEST_ENTITLEMENT: EntitlementRow = {
  id: 'entitlement-credit-5',
  productId: TEST_PRODUCT.id,
  entitlementKey: 'credits',
  entitlementType: 'consumable',
  quantity: 5,
  grantCadence: 'purchase',
  expirationPolicy: 'fixed_duration',
  durationDays: 365,
  createdAt: TEST_DATE,
  updatedAt: TEST_DATE,
}
const TEST_USER: LocalUser = {
  id: 'user-1',
  clerkUserId: 'clerk-user-1',
  primaryEmail: 'buyer@example.com',
  emailVerified: true,
  firstName: null,
  lastName: null,
  displayName: null,
  username: null,
  avatarUrl: null,
  clerkCreatedAt: null,
  clerkUpdatedAt: null,
  createdAt: TEST_DATE,
  updatedAt: TEST_DATE,
  lastSeenAt: TEST_DATE,
  lastLoginAt: null,
}

const testGlobals = globalThis as unknown as TestGlobals
const originalFetch = testGlobals.$fetch

afterEach(() => {
  if (originalFetch) {
    testGlobals.$fetch = originalFetch
  }
  else {
    Reflect.deleteProperty(globalThis, '$fetch')
  }
})

class FakeSelectBuilder {
  private source: unknown = null

  constructor(private readonly database: FakeCheckoutDatabase) {}

  from(source: unknown) {
    this.source = source
    return this
  }

  innerJoin() {
    return this
  }

  where() {
    return this
  }

  limit() {
    return Promise.resolve(this.execute())
  }

  then(
    onFulfilled?: ((value: unknown[]) => unknown) | null,
    onRejected?: ((reason: unknown) => unknown) | null,
  ) {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected)
  }

  private execute(): unknown[] {
    if (this.source === billingOrders) {
      return this.database.orders.slice(0, 1)
    }
    if (this.source === billingPrices) {
      return [{
        price: TEST_PRICE,
        product: TEST_PRODUCT,
      }]
    }
    if (this.source === productEntitlements) {
      return [TEST_ENTITLEMENT]
    }
    throw new Error('Unexpected select source')
  }
}

class FakeInsertBuilder {
  constructor(private readonly database: FakeCheckoutDatabase) {}

  values(value: unknown) {
    return {
      returning: async () => this.database.insertOrder(value),
    }
  }
}

class FakeUpdateWhereBuilder {
  private result: BillingOrderRow[] | null = null

  constructor(
    private readonly database: FakeCheckoutDatabase,
    private readonly patch: Partial<BillingOrderRow>,
  ) {}

  returning() {
    return Promise.resolve(
      this.execute().map(order => ({ id: order.id })),
    )
  }

  then(
    onFulfilled?: ((value: BillingOrderRow[]) => unknown) | null,
    onRejected?: ((reason: unknown) => unknown) | null,
  ) {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected)
  }

  private execute(): BillingOrderRow[] {
    if (this.result !== null) {
      return this.result
    }

    if (
      this.database.skipCheckoutPersistence
      && Object.prototype.hasOwnProperty.call(
        this.patch,
        'providerCheckoutId',
      )
    ) {
      this.result = []
      return this.result
    }

    this.database.orders = this.database.orders.map(order => ({
      ...order,
      ...this.patch,
    }))
    this.result = this.database.orders.slice()
    return this.result
  }
}

class FakeUpdateSetBuilder {
  constructor(
    private readonly database: FakeCheckoutDatabase,
    private readonly patch: Partial<BillingOrderRow>,
  ) {}

  where() {
    return new FakeUpdateWhereBuilder(this.database, this.patch)
  }
}

class FakeUpdateBuilder {
  constructor(private readonly database: FakeCheckoutDatabase) {}

  set(patch: Partial<BillingOrderRow>) {
    return new FakeUpdateSetBuilder(this.database, patch)
  }
}

class FakeCheckoutDatabase {
  orders: BillingOrderRow[] = []
  skipCheckoutPersistence = false

  asDatabase(): Database {
    return this as unknown as Database
  }

  select() {
    return new FakeSelectBuilder(this)
  }

  insert(table: unknown) {
    assert.equal(table, billingOrders)
    return new FakeInsertBuilder(this)
  }

  update(table: unknown) {
    assert.equal(table, billingOrders)
    return new FakeUpdateBuilder(this)
  }

  insertOrder(value: unknown): BillingOrderRow[] {
    const order = value as BillingOrderRow
    const duplicate = this.orders.some(existing =>
      existing.userId === order.userId
      && existing.checkoutIdempotencyKey === order.checkoutIdempotencyKey,
    )
    if (duplicate) {
      throw new Error(
        'UNIQUE constraint failed: billing_orders.user_id, '
        + 'billing_orders.checkout_idempotency_key',
      )
    }

    const stored = { ...order }
    this.orders.push(stored)
    return [stored]
  }
}

function makeCheckoutEvent(environment = 'test') {
  return {
    context: {
      cloudflare: {
        env: {
          CREEM_API_KEY: 'test-api-key',
          APP_ENVIRONMENT: environment,
          APP_URL: 'https://example.com',
        },
      },
    },
  } as unknown as Parameters<typeof initiateCheckout>[0]['event']
}

function installCreemFetch(
  checkoutOutcome:
    | 'validated'
    | 'without-order'
    | 'rejected'
    | 'unknown'
    | 'mismatch' = 'validated',
): FetchCall[] {
  const calls: FetchCall[] = []
  let checkoutRequestBody: Record<string, unknown> | null = null

  const fetchStub = (async (rawUrl, rawOptions) => {
    const url = String(rawUrl)
    const options = (rawOptions ?? {}) as FetchCall['options']
    calls.push({ url, options })

    if (url.endsWith('/products')) {
      return {
        id: TEST_PRICE.providerProductId,
        status: 'active',
        billing_type: 'one_time',
        currency: 'USD',
        tax_mode: 'inclusive',
      }
    }

    if (url.endsWith('/checkouts') && options.method === 'POST') {
      if (checkoutOutcome === 'rejected' || checkoutOutcome === 'unknown') {
        const error = new Error(`Creem ${checkoutOutcome}`) as Error & {
          statusCode: number
          data: {
            trace_id: string
            message: string[]
          }
        }
        error.statusCode = checkoutOutcome === 'rejected' ? 400 : 500
        error.data = {
          trace_id: `trace-${checkoutOutcome}`,
          message: [checkoutOutcome === 'rejected'
            ? 'Creem rejected Checkout creation.'
            : 'Creem temporarily unavailable.'],
        }
        throw error
      }

      const body = options.body ?? {}
      checkoutRequestBody = body
      if (checkoutOutcome === 'without-order') {
        return { id: 'checkout-1' }
      }

      return {
        id: 'checkout-1',
        checkout_url: 'https://checkout.creem.io/checkout-1',
        product_id: body.product_id,
        request_id: body.request_id,
        units: body.units,
        custom_price: body.custom_price,
        order: {
          currency: 'USD',
          amount_due: checkoutOutcome === 'mismatch'
            ? Number(body.custom_price) + 1
            : body.custom_price,
        },
      }
    }

    if (
      url.endsWith('/checkouts')
      && options.method === 'GET'
      && checkoutOutcome === 'without-order'
      && checkoutRequestBody
    ) {
      return {
        id: 'checkout-1',
        checkout_url: 'https://checkout.creem.io/checkout-1',
        product_id: checkoutRequestBody.product_id,
        request_id: checkoutRequestBody.request_id,
        units: checkoutRequestBody.units,
        custom_price: checkoutRequestBody.custom_price,
      }
    }

    throw new Error(`Unexpected Creem request: ${url}`)
  }) as FetchStub

  fetchStub.raw = async (url, options) => ({
    status: 200,
    _data: await fetchStub(url, options),
  })
  testGlobals.$fetch = fetchStub

  return calls
}

async function assertCheckoutErrorAsync(
  operation: Promise<unknown>,
  code: string,
): Promise<CheckoutError> {
  try {
    await operation
    assert.fail(`expected CheckoutError ${code}`)
  }
  catch (error) {
    assert.ok(error instanceof CheckoutError)
    assert.equal(error.code, code)
    return error
  }
}

function startCheckout(
  database: FakeCheckoutDatabase,
  idempotencyKey: string,
  environment?: string,
) {
  return initiateCheckout({
    event: makeCheckoutEvent(environment),
    database: database.asDatabase(),
    localUser: TEST_USER,
    priceCode: 'credit_pack_5_usd',
    idempotencyKey,
  })
}

describe('initiateCheckout', () => {
  it('inserts a pending order, calls Creem once, and persists Checkout facts', async () => {
    const database = new FakeCheckoutDatabase()
    const calls = installCreemFetch()

    const result = await startCheckout(database, 'purchase-1')

    assert.deepEqual(result, {
      checkoutUrl: 'https://checkout.creem.io/checkout-1',
    })
    assert.equal(database.orders.length, 1)

    const order = database.orders[0]!
    assert.equal(order.userId, TEST_USER.id)
    assert.equal(order.productId, TEST_PRODUCT.id)
    assert.equal(order.priceId, TEST_PRICE.id)
    assert.equal(order.status, 'pending')
    assert.equal(order.amount, 499)
    assert.equal(order.currency, 'USD')
    assert.equal(order.provider, 'creem')
    assert.equal(order.checkoutIdempotencyKey, 'purchase-1')
    assert.equal(order.providerCheckoutId, 'checkout-1')
    assert.equal(
      order.providerCheckoutUrl,
      'https://checkout.creem.io/checkout-1',
    )
    assert.deepEqual(order.entitlementSnapshot, [{
      entitlement_key: 'credits',
      entitlement_type: 'consumable',
      quantity: 5,
      grant_cadence: 'purchase',
      expiration_policy: 'fixed_duration',
      duration_days: 365,
    }])

    const checkoutCalls = calls.filter(call =>
      call.url.endsWith('/checkouts') && call.options.method === 'POST',
    )
    assert.equal(checkoutCalls.length, 1)
    assert.equal(checkoutCalls[0]?.options.body?.request_id, order.id)
  })

  it('uses Creem production API URLs only in production', async () => {
    const database = new FakeCheckoutDatabase()
    const calls = installCreemFetch()

    await startCheckout(database, 'purchase-production', 'production')

    assert.deepEqual(
      calls.map(call => call.url),
      [
        'https://api.creem.io/v1/products',
        'https://api.creem.io/v1/checkouts',
      ],
    )
  })

  it('accepts a valid Creem Checkout before order fields are available', async () => {
    const database = new FakeCheckoutDatabase()
    const calls = installCreemFetch('without-order')

    const result = await startCheckout(database, 'purchase-without-order')

    assert.deepEqual(result, {
      checkoutUrl: 'https://checkout.creem.io/checkout-1',
    })
    assert.equal(database.orders[0]?.providerCheckoutId, 'checkout-1')
    assert.equal(
      database.orders[0]?.providerCheckoutUrl,
      'https://checkout.creem.io/checkout-1',
    )
    assert.equal(
      calls.filter(call => call.url.endsWith('/checkouts')).length,
      2,
    )
    assert.deepEqual(
      calls
        .filter(call => call.url.endsWith('/checkouts'))
        .map(call => call.options.method),
      ['POST', 'GET'],
    )
  })

  it('marks an explicitly rejected Checkout order failed', async () => {
    const database = new FakeCheckoutDatabase()
    installCreemFetch('rejected')

    const error = await assertCheckoutErrorAsync(
      startCheckout(database, 'purchase-rejected'),
      'CHECKOUT_FAILED',
    )

    assert.deepEqual(error.details, {
      provider: 'creem',
      stage: 'create',
      httpStatus: 400,
      traceId: 'trace-rejected',
      messages: ['Creem rejected Checkout creation.'],
      fieldDifferences: [],
    })

    assert.equal(database.orders.length, 1)
    assert.equal(database.orders[0]?.status, 'failed')
    assert.equal(
      database.orders[0]?.failureCode,
      'CHECKOUT_PROVIDER_REJECTED',
    )
    assert.ok(database.orders[0]?.failedAt instanceof Date)
  })

  it('keeps an uncertain Provider result pending and marks it unknown', async () => {
    const database = new FakeCheckoutDatabase()
    installCreemFetch('unknown')

    const error = await assertCheckoutErrorAsync(
      startCheckout(database, 'purchase-unknown'),
      'CHECKOUT_CREATION_UNKNOWN',
    )

    assert.deepEqual(error.details, {
      provider: 'creem',
      stage: 'create',
      httpStatus: 500,
      traceId: 'trace-unknown',
      messages: ['Creem temporarily unavailable.'],
      fieldDifferences: [],
    })

    assert.equal(database.orders.length, 1)
    assert.equal(database.orders[0]?.status, 'pending')
    assert.equal(
      database.orders[0]?.failureCode,
      'CHECKOUT_CREATION_UNKNOWN',
    )
    assert.equal(database.orders[0]?.providerCheckoutUrl, null)
  })

  it('reports exact field differences for an invalid successful response', async () => {
    const database = new FakeCheckoutDatabase()
    installCreemFetch('mismatch')

    const error = await assertCheckoutErrorAsync(
      startCheckout(database, 'purchase-mismatch'),
      'CHECKOUT_CREATION_UNKNOWN',
    )

    assert.deepEqual(error.details, {
      provider: 'creem',
      stage: 'create_validation',
      httpStatus: 200,
      traceId: null,
      messages: [
        'Creem Checkout response did not match the requested checkout.',
      ],
      fieldDifferences: [{
        field: 'order.amount_due',
        expected: 499,
        actual: 500,
      }],
    })
  })

  it('does not expose a Checkout URL when the success update affects no row', async () => {
    const database = new FakeCheckoutDatabase()
    database.skipCheckoutPersistence = true
    installCreemFetch()

    await assertCheckoutErrorAsync(
      startCheckout(database, 'purchase-missing-update'),
      'CHECKOUT_CREATION_UNKNOWN',
    )

    assert.equal(database.orders.length, 1)
    assert.equal(database.orders[0]?.providerCheckoutId, null)
    assert.equal(database.orders[0]?.providerCheckoutUrl, null)
    assert.equal(
      database.orders[0]?.failureCode,
      'CHECKOUT_CREATION_UNKNOWN',
    )
  })

  it('allows only one same-key insert owner to POST Checkout', async () => {
    const database = new FakeCheckoutDatabase()
    const calls = installCreemFetch()

    const outcomes = await Promise.allSettled([
      startCheckout(database, 'purchase-concurrent'),
      startCheckout(database, 'purchase-concurrent'),
    ])

    assert.equal(database.orders.length, 1)
    assert.equal(
      calls.filter(call =>
        call.url.endsWith('/checkouts') && call.options.method === 'POST',
      ).length,
      1,
    )

    const fulfilled = outcomes.filter(
      outcome => outcome.status === 'fulfilled',
    )
    assert.ok(fulfilled.length >= 1)

    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        assert.ok(outcome.reason instanceof CheckoutError)
        assert.equal(outcome.reason.code, 'CHECKOUT_IN_PROGRESS')
      }
    }
  })
})
