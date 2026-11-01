import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import type { Database } from '../../database/client.ts'
import {
  billingDisputes,
  billingOrders,
  billingRefundCreditAdjustments,
  billingRefunds,
  entitlementGrants,
  entitlementTransactions,
} from '../../database/schema/index.ts'
import type {
  EntitlementSnapshot,
  EntitlementSnapshotItem,
} from '../../types/billing.ts'
import {
  computeCreemWebhookSignature,
  verifyAndNormalizeCreemWebhook,
} from '../../utils/zBilling/application/handle-webhook.ts'
import { evaluateCheckoutCompletedAgainstOrder } from '../../utils/zBilling/domain/order.ts'

type ApplyCheckoutCompleted = typeof import('./creem.post.ts').applyCheckoutCompleted
type ApplyRefundCreated = typeof import('./creem.post.ts').applyRefundCreated
type ApplyDisputeCreated = typeof import('./creem.post.ts').applyDisputeCreated
type BuildExpected = typeof import('./creem.post.ts').buildExpectedOrderCreditFulfillment
type BuildGrantId = typeof import('./creem.post.ts').buildOrderCreditGrantId
type BuildTxIds = typeof import('./creem.post.ts').buildOrderCreditGrantTransactionIds
type EnsureFulfillment = typeof import('./creem.post.ts').ensureOrderCreditFulfillment
type ToSqliteTimestamp = typeof import('./creem.post.ts').toSqliteTimestamp
type ExpectedOrderCreditFulfillment
  = import('./creem.post.ts').ExpectedOrderCreditFulfillment

type TestGlobals = {
  defineEventHandler: (handler: unknown) => unknown
  getRequestURL: (event: unknown) => URL
  readRawBody: (event: unknown, encoding?: string) => Promise<string | undefined>
  getHeader: (event: unknown, name: string) => string | undefined
  setResponseHeader: (event: unknown, name: string, value: string) => void
  setResponseStatus: (event: unknown, status: number) => void
}

const globalScope = globalThis as unknown as TestGlobals

function installH3Shims() {
  globalScope.defineEventHandler = handler => handler
  globalScope.getRequestURL = () => new URL('https://example.com/api/webhooks/creem')
  globalScope.readRawBody = async () => undefined
  globalScope.getHeader = () => undefined
  globalScope.setResponseHeader = () => {}
  globalScope.setResponseStatus = () => {}
}

let applyCheckoutCompleted: ApplyCheckoutCompleted
let applyRefundCreated: ApplyRefundCreated
let applyDisputeCreated: ApplyDisputeCreated
let buildExpectedOrderCreditFulfillment: BuildExpected
let buildOrderCreditGrantId: BuildGrantId
let buildOrderCreditGrantTransactionIds: BuildTxIds
let ensureOrderCreditFulfillment: EnsureFulfillment
let toSqliteTimestamp: ToSqliteTimestamp

const SECRET = 'whsec_unit_test'
const MS_PER_DAY = 24 * 60 * 60 * 1000

const PACK_5: EntitlementSnapshotItem = {
  entitlement_key: 'credits',
  entitlement_type: 'consumable',
  quantity: 5,
  grant_cadence: 'purchase',
  expiration_policy: 'fixed_duration',
  duration_days: 365,
}

const PACK_20: EntitlementSnapshotItem = {
  ...PACK_5,
  quantity: 20,
}

const PACK_50: EntitlementSnapshotItem = {
  ...PACK_5,
  quantity: 50,
}

function sampleBody(overrides?: {
  eventId?: string
  checkoutId?: string
  orderId?: string
  amount?: number
  currency?: string
  requestId?: string
}): string {
  return JSON.stringify({
    id: overrides?.eventId ?? 'evt_1',
    eventType: 'checkout.completed',
    object: {
      id: overrides?.checkoutId ?? 'ch_1',
      request_id: overrides?.requestId ?? 'order-local-1',
      order: {
        id: overrides?.orderId ?? 'ord_1',
        amount: overrides?.amount ?? 499,
        currency: overrides?.currency ?? 'USD',
        status: 'paid',
      },
      status: 'completed',
    },
  })
}

function checkoutEvent(overrides?: {
  checkoutId?: string
  providerOrderId?: string
  amount?: number
  currency?: string
  requestId?: string
}) {
  return {
    kind: 'checkout.completed' as const,
    providerEventId: 'evt_1',
    eventType: 'checkout.completed' as const,
    payloadHash: 'a'.repeat(64),
    checkout: {
      checkoutId: overrides?.checkoutId ?? 'ch_1',
      providerOrderId: overrides?.providerOrderId ?? 'ord_1',
      orderStatus: 'paid',
      amount: overrides?.amount ?? 499,
      currency: overrides?.currency ?? 'USD',
      requestId: overrides?.requestId ?? 'order-local-1',
    },
  }
}

type BillingOrderRow = typeof billingOrders.$inferSelect
type GrantRow = typeof entitlementGrants.$inferSelect
type TransactionRow = Omit<typeof entitlementTransactions.$inferSelect, 'ledgerSequence'> & { ledgerSequence?: number | null }
type RefundRow = typeof billingRefunds.$inferSelect
type AdjustmentRow = typeof billingRefundCreditAdjustments.$inferSelect
type DisputeRow = typeof billingDisputes.$inferSelect

function collectStrings(
  value: unknown,
  out: Set<string> = new Set(),
  seen: Set<unknown> = new Set(),
): Set<string> {
  if (value == null) {
    return out
  }
  if (typeof value === 'string') {
    out.add(value)
    return out
  }
  if (typeof value !== 'object') {
    return out
  }
  if (seen.has(value)) {
    return out
  }
  seen.add(value)

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out, seen)
    }
    return out
  }

  for (const key of Object.keys(value as object)) {
    try {
      collectStrings((value as Record<string, unknown>)[key], out, seen)
    }
    catch {
      // Ignore getters that throw on circular drizzle internals.
    }
  }
  return out
}

function pickLookupValue(
  condition: unknown,
  candidates: (value: string) => boolean,
): string | null {
  for (const value of collectStrings(condition)) {
    if (candidates(value)) {
      return value
    }
  }
  return null
}

function sqlNumberParameters(value: unknown): number[] {
  if (typeof value !== 'object' || value === null) {
    return []
  }
  const chunks = (value as { queryChunks?: unknown }).queryChunks
  if (!Array.isArray(chunks)) {
    return []
  }
  return chunks.filter(
    (chunk): chunk is number => typeof chunk === 'number' && Number.isFinite(chunk),
  )
}

const GRANT_STATUS_VALUES = new Set(['active', 'expired', 'revoked'])

function sqlEnumParameters(value: unknown): Array<'active' | 'expired' | 'revoked'> {
  if (typeof value !== 'object' || value === null) {
    return []
  }
  const chunks = (value as { queryChunks?: unknown }).queryChunks
  if (!Array.isArray(chunks)) {
    return []
  }
  return chunks.filter(
    (chunk): chunk is 'active' | 'expired' | 'revoked' =>
      typeof chunk === 'string' && GRANT_STATUS_VALUES.has(chunk),
  )
}

class FakeSelectBuilder {
  private source: unknown = null
  private condition: unknown = null
  private database: FakeFulfillmentDatabase

  constructor(database: FakeFulfillmentDatabase) {
    this.database = database
  }

  from(source: unknown) {
    this.source = source
    return this
  }

  where(condition: unknown) {
    this.condition = condition
    return this
  }

  limit() {
    return Promise.resolve(this.execute())
  }

  then<TResult1 = unknown, TResult2 = never>(
    onFulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected)
  }

  private execute(): unknown[] {
    if (this.source === billingOrders) {
      const checkoutId = pickLookupValue(
        this.condition,
        value => value.startsWith('ch_') || value === 'ch_missing',
      )
      const orderId = pickLookupValue(
        this.condition,
        value => value.startsWith('order-'),
      )
      const providerOrderId = pickLookupValue(
        this.condition,
        value => value.startsWith('ord_'),
      )
      return this.database.orders
        .filter(order =>
          order.provider === 'creem'
          && (checkoutId === null || order.providerCheckoutId === checkoutId)
          && (orderId === null || order.id === orderId)
          && (providerOrderId === null || order.providerOrderId === providerOrderId),
        )
        .slice(0, 1)
    }

    if (this.source === entitlementGrants) {
      const grantId = pickLookupValue(
        this.condition,
        value => value.startsWith('eg:'),
      )
      const sourceId = pickLookupValue(
        this.condition,
        value => value.startsWith('order-'),
      )
      let rows = this.database.grants
      if (grantId) {
        rows = rows.filter(grant => grant.id === grantId)
      }
      if (sourceId) {
        rows = rows.filter(grant => grant.sourceId === sourceId)
      }
      return rows
    }

    if (this.source === entitlementTransactions) {
      const key = pickLookupValue(
        this.condition,
        value => value.startsWith('entitlement:'),
      )
      if (key) {
        return this.database.transactions.filter(
          row => row.idempotencyKey === key,
        )
      }
      return this.database.transactions.slice()
    }

    if (this.source === billingRefunds) {
      const refundId = pickLookupValue(
        this.condition,
        value => value.startsWith('br:'),
      )
      const providerRefundId = pickLookupValue(
        this.condition,
        value => value.startsWith('ref_'),
      )
      const orderId = pickLookupValue(
        this.condition,
        value => value.startsWith('order-'),
      )
      let rows = this.database.refunds
      if (refundId) {
        rows = rows.filter(row => row.id === refundId)
      }
      if (providerRefundId) {
        rows = rows.filter(row => row.providerRefundId === providerRefundId)
      }
      if (orderId) {
        rows = rows.filter(row => row.orderId === orderId)
      }
      return rows
    }

    if (this.source === billingRefundCreditAdjustments) {
      const refundId = pickLookupValue(
        this.condition,
        value => value.startsWith('br:'),
      )
      const grantId = pickLookupValue(
        this.condition,
        value => value.startsWith('eg:'),
      )
      let rows = this.database.adjustments
      if (refundId) {
        rows = rows.filter(row => row.refundId === refundId)
      }
      if (grantId) {
        rows = rows.filter(row => row.grantId === grantId)
      }
      return rows
    }

    if (this.source === billingDisputes) {
      const providerDisputeId = pickLookupValue(
        this.condition,
        value => value.startsWith('disp_'),
      )
      let rows = this.database.disputes
      if (providerDisputeId) {
        rows = rows.filter(row => row.providerDisputeId === providerDisputeId)
      }
      return rows
    }

    throw new Error('Unexpected select source')
  }
}

/**
 * Lazy thenable so writes run only when awaited (inside batch), matching D1
 * statement builders rather than executing during statement construction.
 */
function lazyOp(run: () => unknown): PromiseLike<unknown> {
  return {
    then<TResult1 = unknown, TResult2 = never>(
      onFulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve()
        .then(() => run())
        .then(onFulfilled, onRejected)
    },
  }
}

class FakeUpdateWhereBuilder {
  private database: FakeFulfillmentDatabase
  private table: unknown
  private patch: Record<string, unknown>

  constructor(
    database: FakeFulfillmentDatabase,
    table: unknown,
    patch: Record<string, unknown>,
  ) {
    this.database = database
    this.table = table
    this.patch = patch
  }

  where() {
    return lazyOp(() => this.execute())
  }

  returning() {
    return lazyOp(() => this.execute())
  }

  then<TResult1 = unknown, TResult2 = never>(
    onFulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(onFulfilled, onRejected)
  }

  private execute(): Array<{ id: string }> {
    if (this.table === billingOrders) {
      // Conditional pending -> paid transition used by checkout fulfillment.
      if (this.patch.status === 'paid') {
        const pending = this.database.orders.find(order => order.status === 'pending')
        if (!pending) {
          return []
        }
        const updated: BillingOrderRow = {
          ...pending,
          ...(this.patch as Partial<BillingOrderRow>),
        }
        this.database.orders = this.database.orders.map(order =>
          order.id === pending.id ? updated : order,
        )
        return [{ id: updated.id }]
      }

      // Settlement / providerPaidAmount updates (refund path) — single test order.
      if (this.database.orders.length === 0) {
        return []
      }
      const refundVersionParameters = sqlNumberParameters(this.patch.refundVersion)
      this.database.orders = this.database.orders.map((order, index) => {
        if (index !== 0) {
          return order
        }
        const patch = { ...(this.patch as Partial<BillingOrderRow>) }
        if (refundVersionParameters.length > 0) {
          const expectedVersion = refundVersionParameters[0]!
          if (order.refundVersion !== expectedVersion) {
            throw new Error('CHECK constraint failed: billing_orders_refund_version_check')
          }
          patch.refundVersion = expectedVersion + 1
        }
        return {
          ...order,
          ...patch,
        }
      })
      return [{ id: this.database.orders[0]!.id }]
    }

    if (this.table === entitlementGrants) {
      const guardedParameters = sqlNumberParameters(this.patch.remainingQuantity)
      const remainingStatuses = sqlEnumParameters(this.patch.remainingQuantity)
      const statusParameters = sqlEnumParameters(this.patch.status)
      const nextRemaining = guardedParameters.length >= 2
        ? guardedParameters[1]!
        : this.patch.remainingQuantity
      if (typeof nextRemaining !== 'number') {
        return []
      }
      const expectedStatus = remainingStatuses[0]
      const nextStatus = statusParameters.length >= 2
        ? statusParameters[1]!
        : typeof this.patch.status === 'string'
          ? this.patch.status as GrantRow['status']
          : undefined
      let updatedId: string | null = null
      this.database.grants = this.database.grants.map((grant) => {
        if (updatedId) {
          return grant
        }
        const current = grant.remainingQuantity ?? 0
        if (
          guardedParameters.length >= 2
          && (current !== guardedParameters[0] || (expectedStatus && grant.status !== expectedStatus))
        ) {
          throw new Error('CHECK constraint failed: entitlement_grants_quantity_check')
        }
        const applied = current - nextRemaining
        if (applied >= 0 && current >= applied) {
          updatedId = grant.id
          return {
            ...grant,
            remainingQuantity: nextRemaining,
            status: nextStatus ?? grant.status,
            updatedAt: (this.patch.updatedAt as Date) ?? grant.updatedAt,
          }
        }
        return grant
      })
      return updatedId ? [{ id: updatedId }] : []
    }

    throw new Error('Unexpected update table')
  }
}

class FakeUpdateSetBuilder {
  private database: FakeFulfillmentDatabase
  private table: unknown
  private patch: Record<string, unknown>

  constructor(
    database: FakeFulfillmentDatabase,
    table: unknown,
    patch: Record<string, unknown>,
  ) {
    this.database = database
    this.table = table
    this.patch = patch
  }

  where() {
    return new FakeUpdateWhereBuilder(this.database, this.table, this.patch)
  }
}

class FakeUpdateBuilder {
  private database: FakeFulfillmentDatabase
  private table: unknown

  constructor(database: FakeFulfillmentDatabase, table: unknown) {
    this.database = database
    this.table = table
  }

  set(patch: Record<string, unknown>) {
    return new FakeUpdateSetBuilder(this.database, this.table, patch)
  }
}

class FakeInsertBuilder {
  private database: FakeFulfillmentDatabase
  private table: unknown
  private valuesPayload: Record<string, unknown> | null = null

  constructor(database: FakeFulfillmentDatabase, table: unknown) {
    this.database = database
    this.table = table
  }

  values(payload: Record<string, unknown>) {
    this.valuesPayload = payload
    return this
  }

  onConflictDoNothing() {
    return lazyOp(() => this.execute())
  }

  private execute(): unknown[] {
    if (!this.valuesPayload) {
      throw new Error('Missing insert values')
    }

    if (this.table === entitlementGrants) {
      const row = this.valuesPayload as unknown as GrantRow
      const exists = this.database.grants.some(grant =>
        grant.id === row.id
        || (
          grant.sourceType === row.sourceType
          && grant.sourceId === row.sourceId
          && grant.entitlementKey === row.entitlementKey
          && grant.periodKey === row.periodKey
        ),
      )
      if (!exists) {
        this.database.grants.push({ ...row })
      }
      this.database.insertCalls.push({ table: 'grant', row })
      return []
    }

    if (this.table === entitlementTransactions) {
      if (this.database.failNextTransactionInsert) {
        this.database.failNextTransactionInsert = false
        throw new Error('INJECTED_TRANSACTION_INSERT_FAILURE')
      }
      const row = this.valuesPayload as unknown as TransactionRow
      const exists = this.database.transactions.some(tx =>
        tx.id === row.id || tx.idempotencyKey === row.idempotencyKey,
      )
      if (!exists) {
        this.database.transactions.push({ ...row })
      }
      this.database.insertCalls.push({ table: 'transaction', row })
      return []
    }

    if (this.table === billingRefunds) {
      const row = this.valuesPayload as unknown as RefundRow
      const exists = this.database.refunds.some(existing =>
        existing.id === row.id
        || (
          existing.provider === row.provider
          && existing.providerRefundId === row.providerRefundId
        ),
      )
      if (!exists) {
        this.database.refunds.push({ ...row })
      }
      return []
    }

    if (this.table === billingRefundCreditAdjustments) {
      const row = this.valuesPayload as unknown as AdjustmentRow
      const exists = this.database.adjustments.some(existing =>
        existing.id === row.id
        || (
          existing.refundId === row.refundId
          && existing.grantId === row.grantId
        ),
      )
      if (!exists) {
        this.database.adjustments.push({ ...row })
      }
      return []
    }

    if (this.table === billingDisputes) {
      const row = this.valuesPayload as unknown as DisputeRow
      const exists = this.database.disputes.some(existing =>
        existing.id === row.id
        || (
          existing.provider === row.provider
          && existing.providerDisputeId === row.providerDisputeId
        ),
      )
      if (!exists) {
        this.database.disputes.push({ ...row })
      }
      return []
    }

    throw new Error('Unexpected insert table')
  }
}

class FakeFulfillmentDatabase {
  orders: BillingOrderRow[] = []
  grants: GrantRow[] = []
  transactions: TransactionRow[] = []
  refunds: RefundRow[] = []
  adjustments: AdjustmentRow[] = []
  disputes: DisputeRow[] = []
  insertCalls: Array<{ table: 'grant' | 'transaction', row: unknown }> = []
  batchCalls = 0
  /** Injected mid-batch failure for the next transaction insert. */
  failNextTransactionInsert = false
  /**
   * When set, mutates the order to concurrent paid state at the start of
   * batch() so the conditional update affects zero rows, then reread sees paid.
   */
  concurrentPaidOnBatch: {
    providerOrderId: string
    paidAt: Date
  } | null = null
  /** Simulates a separately committed refund before the guarded batch begins. */
  concurrentRefundVersionOnBatch: number | null = null
  /** Simulates an intervening credit consumption before the guarded batch begins. */
  concurrentGrantRemainingOnBatch: number | null = null

  asDatabase(): Database {
    return this as unknown as Database
  }

  select() {
    return new FakeSelectBuilder(this)
  }

  update(table: unknown) {
    return new FakeUpdateBuilder(this, table)
  }

  insert(table: unknown) {
    return new FakeInsertBuilder(this, table)
  }

  /**
   * Sequential transactional batch: snapshot before statements; restore on
   * failure so no partial paid/grant/tx state is visible.
   */
  batch(statements: Array<PromiseLike<unknown>>) {
    this.batchCalls += 1

    if (this.concurrentPaidOnBatch) {
      const concurrent = this.concurrentPaidOnBatch
      this.orders = this.orders.map(order => ({
        ...order,
        status: 'paid' as const,
        providerOrderId: concurrent.providerOrderId,
        paidAt: concurrent.paidAt,
      }))
    }
    if (this.concurrentRefundVersionOnBatch !== null) {
      const version = this.concurrentRefundVersionOnBatch
      this.concurrentRefundVersionOnBatch = null
      this.orders = this.orders.map(order => ({
        ...order,
        refundVersion: version,
      }))
    }
    if (this.concurrentGrantRemainingOnBatch !== null) {
      const remainingQuantity = this.concurrentGrantRemainingOnBatch
      this.concurrentGrantRemainingOnBatch = null
      this.grants = this.grants.map(grant => ({
        ...grant,
        remainingQuantity,
      }))
    }

    const snapshot = {
      orders: this.orders.map(order => ({ ...order })),
      grants: this.grants.map(grant => ({ ...grant })),
      transactions: this.transactions.map(tx => ({ ...tx })),
      refunds: this.refunds.map(row => ({ ...row })),
      adjustments: this.adjustments.map(row => ({ ...row })),
      disputes: this.disputes.map(row => ({ ...row })),
    }

    return (async () => {
      const results: unknown[] = []
      try {
        for (const statement of statements) {
          results.push(await statement)
        }
        return results
      }
      catch (error) {
        this.orders = snapshot.orders
        this.grants = snapshot.grants
        this.transactions = snapshot.transactions
        this.refunds = snapshot.refunds
        this.adjustments = snapshot.adjustments
        this.disputes = snapshot.disputes
        throw error
      }
    })()
  }
}

let PAID_AT: Date

function baseOrder(overrides: Partial<BillingOrderRow> = {}): BillingOrderRow {
  return {
    id: 'order-local-1',
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
    entitlementSnapshot: [PACK_5],
    provider: 'creem',
    providerCheckoutId: 'ch_1',
    providerCheckoutUrl: 'https://checkout.creem.io/ch_1',
    providerOrderId: null,
    checkoutIdempotencyKey: 'idem-1',
    failureCode: null,
    createdAt: PAID_AT,
    updatedAt: PAID_AT,
    paidAt: null,
    failedAt: null,
    expiredAt: null,
    refundedAt: null,
    ...overrides,
  }
}

function expectedFor(
  order: BillingOrderRow,
  paidAt: Date = PAID_AT,
): ExpectedOrderCreditFulfillment {
  const result = buildExpectedOrderCreditFulfillment({
    orderId: order.id,
    userId: order.userId,
    entitlementSnapshot: order.entitlementSnapshot,
    paidAt,
  })
  // Prefer discriminant check: assert.equal from node:assert/strict is
  // strictEqual and narrows result.ok to true, making the error branch never.
  if (!result.ok) {
    assert.fail(result.errorCode)
  }
  return result.fulfillment
}

before(async () => {
  installH3Shims()
  const mod = await import('./creem.post.ts')
  applyCheckoutCompleted = mod.applyCheckoutCompleted
  applyRefundCreated = mod.applyRefundCreated
  applyDisputeCreated = mod.applyDisputeCreated
  buildExpectedOrderCreditFulfillment = mod.buildExpectedOrderCreditFulfillment
  buildOrderCreditGrantId = mod.buildOrderCreditGrantId
  buildOrderCreditGrantTransactionIds = mod.buildOrderCreditGrantTransactionIds
  ensureOrderCreditFulfillment = mod.ensureOrderCreditFulfillment
  toSqliteTimestamp = mod.toSqliteTimestamp
  PAID_AT = toSqliteTimestamp(new Date('2026-08-10T12:00:00.000Z'))
})

describe('Creem webhook contracts', () => {
  it('rejects invalid signatures without producing a usable event', async () => {
    const rawBody = sampleBody()
    const result = await verifyAndNormalizeCreemWebhook({
      rawBody,
      signatureHeader: '00'.repeat(32),
      webhookSecret: SECRET,
    })
    assert.deepEqual(result, { ok: false, reason: 'invalid_signature' })
  })

  it('accepts a signed completed event and matches a pending local order', async () => {
    const rawBody = sampleBody()
    const signature = await computeCreemWebhookSignature(rawBody, SECRET)
    const verified = await verifyAndNormalizeCreemWebhook({
      rawBody,
      signatureHeader: signature,
      webhookSecret: SECRET,
    })
    assert.equal(verified.ok, true)
    if (!verified.ok || verified.event.kind !== 'checkout.completed') {
      assert.fail('expected checkout.completed')
      return
    }

    const match = evaluateCheckoutCompletedAgainstOrder({
      order: {
        id: 'order-local-1',
        status: 'pending',
        amount: 499,
        currency: 'USD',
        providerOrderId: null,
      },
      checkout: verified.event.checkout,
    })
    assert.deepEqual(match, { ok: true })
  })

  it('treats duplicate paid facts for the same provider order as idempotent success', () => {
    const match = evaluateCheckoutCompletedAgainstOrder({
      order: {
        id: 'order-local-1',
        status: 'paid',
        amount: 499,
        currency: 'USD',
        providerOrderId: 'ord_1',
      },
      checkout: {
        checkoutId: 'ch_1',
        providerOrderId: 'ord_1',
        orderStatus: 'paid',
        amount: 499,
        currency: 'USD',
        requestId: 'order-local-1',
      },
    })
    assert.deepEqual(match, { ok: true })
  })

  it('rejects amount or request-id mismatches so unrelated orders cannot be paid', () => {
    const amountMismatch = evaluateCheckoutCompletedAgainstOrder({
      order: {
        id: 'order-local-1',
        status: 'pending',
        amount: 1499,
        currency: 'USD',
        providerOrderId: null,
      },
      checkout: {
        checkoutId: 'ch_1',
        providerOrderId: 'ord_1',
        orderStatus: 'paid',
        amount: 499,
        currency: 'USD',
        requestId: 'order-local-1',
      },
    })
    assert.deepEqual(amountMismatch, {
      ok: false,
      errorCode: 'ORDER_AMOUNT_MISMATCH',
    })

    const requestMismatch = evaluateCheckoutCompletedAgainstOrder({
      order: {
        id: 'order-local-1',
        status: 'pending',
        amount: 499,
        currency: 'USD',
        providerOrderId: null,
      },
      checkout: {
        checkoutId: 'ch_1',
        providerOrderId: 'ord_1',
        orderStatus: 'paid',
        amount: 499,
        currency: 'USD',
        requestId: 'order-other',
      },
    })
    assert.deepEqual(requestMismatch, {
      ok: false,
      errorCode: 'ORDER_REQUEST_ID_MISMATCH',
    })
  })
})

describe('buildExpectedOrderCreditFulfillment', () => {
  it('builds deterministic grant and ledger descriptors for 5/20/50 packs', () => {
    for (const pack of [PACK_5, PACK_20, PACK_50]) {
      const built = buildExpectedOrderCreditFulfillment({
        orderId: 'order-local-1',
        userId: 'user-1',
        entitlementSnapshot: [pack],
        paidAt: PAID_AT,
      })
      assert.equal(built.ok, true)
      if (!built.ok) {
        continue
      }

      const { grant, transaction } = built.fulfillment
      assert.equal(
        grant.id,
        buildOrderCreditGrantId('order-local-1', 'credits'),
      )
      assert.equal(grant.userId, 'user-1')
      assert.equal(grant.entitlementKey, 'credits')
      assert.equal(grant.entitlementType, 'consumable')
      assert.equal(grant.sourceType, 'order')
      assert.equal(grant.sourceId, 'order-local-1')
      assert.equal(grant.periodKey, 'purchase')
      assert.equal(grant.grantedQuantity, pack.quantity)
      assert.equal(grant.remainingQuantity, pack.quantity)
      assert.equal(grant.status, 'active')
      assert.equal(grant.effectiveAt.getTime(), PAID_AT.getTime())
      assert.equal(
        grant.expiresAt.getTime(),
        PAID_AT.getTime() + 365 * MS_PER_DAY,
      )

      const txIds = buildOrderCreditGrantTransactionIds(
        'order-local-1',
        'credits',
      )
      assert.equal(transaction.id, txIds.id)
      assert.equal(transaction.idempotencyKey, txIds.idempotencyKey)
      assert.equal(transaction.grantId, grant.id)
      assert.equal(transaction.transactionType, 'grant')
      assert.equal(transaction.quantity, pack.quantity)
      assert.equal(transaction.balanceBefore, 0)
      assert.equal(transaction.balanceAfter, pack.quantity)
      assert.equal(transaction.sourceType, 'order')
      assert.equal(transaction.sourceId, 'order-local-1')
    }
  })

  it('uses distinct stable ids across orders and entitlement keys', () => {
    const a = buildOrderCreditGrantId('order-a', 'credits')
    const b = buildOrderCreditGrantId('order-b', 'credits')
    const c = buildOrderCreditGrantId('order-a', 'monitoring')
    assert.notEqual(a, b)
    assert.notEqual(a, c)

    const txA = buildOrderCreditGrantTransactionIds('order-a', 'credits')
    const txB = buildOrderCreditGrantTransactionIds('order-b', 'credits')
    assert.notEqual(txA.id, txB.id)
    assert.notEqual(txA.idempotencyKey, txB.idempotencyKey)
  })

  it('fails closed for empty, multi-item, or unsupported snapshots', () => {
    const cases: Array<{ snapshot: unknown, code: string }> = [
      { snapshot: [], code: 'ENTITLEMENT_SNAPSHOT_INVALID' },
      { snapshot: [PACK_5, PACK_20], code: 'ENTITLEMENT_SNAPSHOT_INVALID' },
      {
        snapshot: [{ ...PACK_5, entitlement_key: 'monitoring' }],
        code: 'ENTITLEMENT_SNAPSHOT_UNSUPPORTED',
      },
      {
        snapshot: [{ ...PACK_5, entitlement_type: 'feature' }],
        code: 'ENTITLEMENT_SNAPSHOT_UNSUPPORTED',
      },
      {
        snapshot: [{ ...PACK_5, grant_cadence: 'subscription' }],
        code: 'ENTITLEMENT_SNAPSHOT_UNSUPPORTED',
      },
      {
        snapshot: [{ ...PACK_5, expiration_policy: 'never' }],
        code: 'ENTITLEMENT_SNAPSHOT_UNSUPPORTED',
      },
      {
        snapshot: [{ ...PACK_5, quantity: 0 }],
        code: 'ENTITLEMENT_SNAPSHOT_INVALID',
      },
      {
        snapshot: [{ ...PACK_5, quantity: 1.5 }],
        code: 'ENTITLEMENT_SNAPSHOT_INVALID',
      },
      {
        snapshot: [{ ...PACK_5, duration_days: null }],
        code: 'ENTITLEMENT_SNAPSHOT_INVALID',
      },
    ]

    for (const testCase of cases) {
      const result = buildExpectedOrderCreditFulfillment({
        orderId: 'order-local-1',
        userId: 'user-1',
        entitlementSnapshot: testCase.snapshot as EntitlementSnapshot,
        paidAt: PAID_AT,
      })
      assert.deepEqual(result, {
        ok: false,
        errorCode: testCase.code,
      })
    }
  })
})

describe('applyCheckoutCompleted credit fulfillment', () => {
  it('pays a pending order and creates exactly one grant and one grant transaction', async () => {
    const db = new FakeFulfillmentDatabase()
    db.orders = [baseOrder()]

    const result = await applyCheckoutCompleted(
      db.asDatabase(),
      checkoutEvent(),
    )
    assert.deepEqual(result, { ok: true })

    assert.equal(db.orders[0]?.status, 'paid')
    assert.equal(db.orders[0]?.providerOrderId, 'ord_1')
    assert.ok(db.orders[0]?.paidAt instanceof Date)
    assert.equal(db.grants.length, 1)
    assert.equal(db.transactions.length, 1)

    const expected = expectedFor(db.orders[0]!, db.orders[0]!.paidAt!)
    assert.equal(db.grants[0]?.id, expected.grant.id)
    assert.equal(db.grants[0]?.grantedQuantity, 5)
    assert.equal(db.grants[0]?.remainingQuantity, 5)
    assert.equal(db.transactions[0]?.quantity, 5)
    assert.equal(db.transactions[0]?.balanceBefore, 0)
    assert.equal(db.transactions[0]?.balanceAfter, 5)
    assert.equal(
      db.transactions[0]?.idempotencyKey,
      expected.transaction.idempotencyKey,
    )
    // The atomic paid+grant+tx batch is complete; immutable verification only reads.
    assert.equal(db.batchCalls, 1)
  })

  it('rolls back paid transition when a mid-batch entitlement write fails', async () => {
    const db = new FakeFulfillmentDatabase()
    db.orders = [baseOrder()]
    db.failNextTransactionInsert = true

    await assert.rejects(
      () => applyCheckoutCompleted(db.asDatabase(), checkoutEvent()),
      /INJECTED_TRANSACTION_INSERT_FAILURE/,
    )

    assert.equal(db.orders[0]?.status, 'pending')
    assert.equal(db.orders[0]?.providerOrderId, null)
    assert.equal(db.orders[0]?.paidAt, null)
    assert.equal(db.grants.length, 0)
    assert.equal(db.transactions.length, 0)
    assert.equal(db.batchCalls, 1)
  })

  it('converges via reread when concurrent delivery already paid the same provider order', async () => {
    const db = new FakeFulfillmentDatabase()
    db.orders = [baseOrder()]
    const concurrentPaidAt = PAID_AT
    const concurrentOrder = baseOrder({
      status: 'paid',
      providerOrderId: 'ord_1',
      paidAt: concurrentPaidAt,
    })
    const concurrentExpected = expectedFor(concurrentOrder, concurrentPaidAt)
    db.grants = [{
      ...concurrentExpected.grant,
      createdAt: concurrentPaidAt,
      updatedAt: concurrentPaidAt,
    }]
    db.transactions = [{
      ...concurrentExpected.transaction,
      createdAt: concurrentPaidAt,
    }]
    // Conditional update sees zero rows; final reread uses persisted paidAt.
    db.concurrentPaidOnBatch = {
      providerOrderId: 'ord_1',
      paidAt: concurrentPaidAt,
    }

    const result = await applyCheckoutCompleted(
      db.asDatabase(),
      checkoutEvent(),
    )
    assert.deepEqual(result, { ok: true })
    assert.equal(db.orders[0]?.status, 'paid')
    assert.equal(db.orders[0]?.providerOrderId, 'ord_1')
    assert.equal(db.orders[0]?.paidAt?.getTime(), concurrentPaidAt.getTime())
    assert.equal(db.grants.length, 1)
    assert.equal(db.transactions.length, 1)
    assert.equal(db.grants[0]?.effectiveAt.getTime(), concurrentPaidAt.getTime())
  })

  it('fails when concurrent paid state has a different provider order id', async () => {
    const db = new FakeFulfillmentDatabase()
    db.orders = [baseOrder()]
    db.concurrentPaidOnBatch = {
      providerOrderId: 'ord_other',
      paidAt: PAID_AT,
    }

    const result = await applyCheckoutCompleted(
      db.asDatabase(),
      checkoutEvent({ providerOrderId: 'ord_1' }),
    )
    assert.deepEqual(result, {
      ok: false,
      errorCode: 'ORDER_UPDATE_FAILED',
    })
    assert.equal(db.orders[0]?.status, 'paid')
    assert.equal(db.orders[0]?.providerOrderId, 'ord_other')
    // Delivery must not succeed for the mismatched provider order id.
  })

  it('is idempotent for exact event replay on an already fulfilled paid order', async () => {
    const db = new FakeFulfillmentDatabase()
    db.orders = [baseOrder({
      status: 'paid',
      providerOrderId: 'ord_1',
      paidAt: PAID_AT,
    })]
    const expected = expectedFor(db.orders[0]!)
    const ensured = await ensureOrderCreditFulfillment(
      db.asDatabase(),
      expected,
    )
    assert.deepEqual(ensured, { ok: true })
    assert.equal(db.grants.length, 1)
    assert.equal(db.transactions.length, 1)

    const replay = await applyCheckoutCompleted(
      db.asDatabase(),
      checkoutEvent(),
    )
    assert.deepEqual(replay, { ok: true })
    assert.equal(db.grants.length, 1)
    assert.equal(db.transactions.length, 1)
    assert.equal(db.orders[0]?.paidAt?.getTime(), PAID_AT.getTime())
  })

  it('repairs a paid order that has no grant or transaction', async () => {
    const db = new FakeFulfillmentDatabase()
    db.orders = [baseOrder({
      status: 'paid',
      providerOrderId: 'ord_1',
      paidAt: PAID_AT,
    })]

    const result = await applyCheckoutCompleted(
      db.asDatabase(),
      checkoutEvent(),
    )
    assert.deepEqual(result, { ok: true })
    assert.equal(db.grants.length, 1)
    assert.equal(db.transactions.length, 1)
    assert.equal(db.orders[0]?.paidAt?.getTime(), PAID_AT.getTime())
  })

  it('repairs a paid order that has a grant but no transaction', async () => {
    const db = new FakeFulfillmentDatabase()
    const order = baseOrder({
      status: 'paid',
      providerOrderId: 'ord_1',
      paidAt: PAID_AT,
    })
    db.orders = [order]
    const expected = expectedFor(order)

    db.grants = [{
      ...expected.grant,
      createdAt: PAID_AT,
      updatedAt: PAID_AT,
    }]

    const result = await applyCheckoutCompleted(
      db.asDatabase(),
      checkoutEvent(),
    )
    assert.deepEqual(result, { ok: true })
    assert.equal(db.grants.length, 1)
    assert.equal(db.transactions.length, 1)
    assert.equal(db.transactions[0]?.grantId, expected.grant.id)
  })

  it('rejects mismatched persisted grant rows instead of silent success', async () => {
    const db = new FakeFulfillmentDatabase()
    const order = baseOrder({
      status: 'paid',
      providerOrderId: 'ord_1',
      paidAt: PAID_AT,
    })
    db.orders = [order]
    const expected = expectedFor(order)

    db.grants = [{
      ...expected.grant,
      grantedQuantity: 99,
      remainingQuantity: 99,
      createdAt: PAID_AT,
      updatedAt: PAID_AT,
    }]
    db.transactions = [{
      ...expected.transaction,
      quantity: 99,
      balanceAfter: 99,
      createdAt: PAID_AT,
    }]

    const result = await applyCheckoutCompleted(
      db.asDatabase(),
      checkoutEvent(),
    )
    assert.deepEqual(result, {
      ok: false,
      errorCode: 'ENTITLEMENT_GRANT_MISMATCH',
    })
  })

  it('rejects mismatched persisted transaction rows', async () => {
    const db = new FakeFulfillmentDatabase()
    const order = baseOrder({
      status: 'paid',
      providerOrderId: 'ord_1',
      paidAt: PAID_AT,
    })
    db.orders = [order]
    const expected = expectedFor(order)

    db.grants = [{
      ...expected.grant,
      createdAt: PAID_AT,
      updatedAt: PAID_AT,
    }]
    db.transactions = [{
      ...expected.transaction,
      quantity: 4,
      balanceAfter: 4,
      createdAt: PAID_AT,
    }]

    const result = await applyCheckoutCompleted(
      db.asDatabase(),
      checkoutEvent(),
    )
    assert.deepEqual(result, {
      ok: false,
      errorCode: 'ENTITLEMENT_TRANSACTION_MISMATCH',
    })
  })

  it('does not refill remaining after a grant has been consumed', async () => {
    const db = new FakeFulfillmentDatabase()
    const order = baseOrder({
      status: 'paid',
      providerOrderId: 'ord_1',
      paidAt: PAID_AT,
    })
    db.orders = [order]
    const expected = expectedFor(order)
    db.grants = [{
      ...expected.grant,
      remainingQuantity: 2,
      createdAt: PAID_AT,
      updatedAt: PAID_AT,
    }]
    db.transactions = [{
      ...expected.transaction,
      createdAt: PAID_AT,
    }]

    const result = await applyCheckoutCompleted(db.asDatabase(), checkoutEvent())
    assert.deepEqual(result, { ok: true })
    assert.equal(db.grants[0]?.remainingQuantity, 2)
    assert.equal(db.grants[0]?.status, 'active')
    assert.equal(db.transactions.length, 1)
  })

  it('does not refill a fully consumed grant', async () => {
    const db = new FakeFulfillmentDatabase()
    const order = baseOrder({
      status: 'paid',
      providerOrderId: 'ord_1',
      paidAt: PAID_AT,
    })
    db.orders = [order]
    const expected = expectedFor(order)
    db.grants = [{
      ...expected.grant,
      remainingQuantity: 0,
      createdAt: PAID_AT,
      updatedAt: PAID_AT,
    }]
    db.transactions = [{
      ...expected.transaction,
      createdAt: PAID_AT,
    }]

    const result = await ensureOrderCreditFulfillment(db.asDatabase(), expected)
    assert.deepEqual(result, { ok: true })
    assert.equal(db.grants[0]?.remainingQuantity, 0)
    assert.equal(db.transactions.length, 1)
  })

  it('does not refill an expired grant', async () => {
    const db = new FakeFulfillmentDatabase()
    const order = baseOrder({
      status: 'paid',
      providerOrderId: 'ord_1',
      paidAt: PAID_AT,
    })
    db.orders = [order]
    const expected = expectedFor(order)
    db.grants = [{
      ...expected.grant,
      remainingQuantity: 5,
      status: 'expired',
      createdAt: PAID_AT,
      updatedAt: PAID_AT,
    }]
    db.transactions = [{
      ...expected.transaction,
      createdAt: PAID_AT,
    }]

    const result = await ensureOrderCreditFulfillment(db.asDatabase(), expected)
    assert.deepEqual(result, { ok: true })
    assert.equal(db.grants[0]?.remainingQuantity, 5)
    assert.equal(db.grants[0]?.status, 'expired')
  })

  it('does not refill a grant after cash-refund reclaim', async () => {
    const db = new FakeFulfillmentDatabase()
    const order = baseOrder({
      status: 'paid',
      providerOrderId: 'ord_1',
      paidAt: PAID_AT,
    })
    db.orders = [order]
    const expected = expectedFor(order)
    db.grants = [{
      ...expected.grant,
      remainingQuantity: 0,
      status: 'revoked',
      createdAt: PAID_AT,
      updatedAt: PAID_AT,
    }]
    db.transactions = [{
      ...expected.transaction,
      createdAt: PAID_AT,
    }]

    const result = await ensureOrderCreditFulfillment(db.asDatabase(), expected)
    assert.deepEqual(result, { ok: true })
    assert.equal(db.grants[0]?.remainingQuantity, 0)
    assert.equal(db.grants[0]?.status, 'revoked')
    assert.equal(db.transactions.length, 1)
  })

  it('refuses to insert a missing original grant transaction after remaining has changed', async () => {
    const db = new FakeFulfillmentDatabase()
    const order = baseOrder({
      status: 'paid',
      providerOrderId: 'ord_1',
      paidAt: PAID_AT,
    })
    db.orders = [order]
    const expected = expectedFor(order)
    db.grants = [{
      ...expected.grant,
      remainingQuantity: 2,
      createdAt: PAID_AT,
      updatedAt: PAID_AT,
    }]

    const result = await ensureOrderCreditFulfillment(db.asDatabase(), expected)
    assert.deepEqual(result, {
      ok: false,
      errorCode: 'ENTITLEMENT_TRANSACTION_MISSING',
    })
    assert.equal(db.transactions.length, 0)
    assert.equal(db.grants[0]?.remainingQuantity, 2)
  })

  it('does not create credits for missing orders', async () => {
    const db = new FakeFulfillmentDatabase()
    const result = await applyCheckoutCompleted(
      db.asDatabase(),
      checkoutEvent({ checkoutId: 'ch_missing' }),
    )
    assert.deepEqual(result, { ok: false, errorCode: 'ORDER_NOT_FOUND' })
    assert.equal(db.grants.length, 0)
    assert.equal(db.transactions.length, 0)
  })

  it('does not create credits on amount mismatch', async () => {
    const db = new FakeFulfillmentDatabase()
    db.orders = [baseOrder({ amount: 1499 })]
    const result = await applyCheckoutCompleted(
      db.asDatabase(),
      checkoutEvent({ amount: 499 }),
    )
    assert.deepEqual(result, {
      ok: false,
      errorCode: 'ORDER_AMOUNT_MISMATCH',
    })
    assert.equal(db.orders[0]?.status, 'pending')
    assert.equal(db.grants.length, 0)
    assert.equal(db.transactions.length, 0)
  })

  it('does not create credits on provider-order conflict for an already terminal order', async () => {
    const db = new FakeFulfillmentDatabase()
    db.orders = [baseOrder({
      status: 'paid',
      providerOrderId: 'ord_other',
      paidAt: PAID_AT,
    })]
    const result = await applyCheckoutCompleted(
      db.asDatabase(),
      checkoutEvent({ providerOrderId: 'ord_1' }),
    )
    assert.deepEqual(result, {
      ok: false,
      errorCode: 'ORDER_ALREADY_TERMINAL',
    })
    assert.equal(db.grants.length, 0)
    assert.equal(db.transactions.length, 0)
  })

  it('fails closed when the local snapshot is unsupported', async () => {
    const db = new FakeFulfillmentDatabase()
    db.orders = [baseOrder({
      entitlementSnapshot: [{
        ...PACK_5,
        entitlement_key: 'monitoring',
      }],
    })]
    const result = await applyCheckoutCompleted(
      db.asDatabase(),
      checkoutEvent(),
    )
    assert.deepEqual(result, {
      ok: false,
      errorCode: 'ENTITLEMENT_SNAPSHOT_UNSUPPORTED',
    })
    assert.equal(db.orders[0]?.status, 'pending')
    assert.equal(db.grants.length, 0)
  })

  it('treats late checkout.completed after refund as a no-op without regrant', async () => {
    const db = new FakeFulfillmentDatabase()
    const order = baseOrder({
      status: 'refunded',
      providerOrderId: 'ord_1',
      paidAt: PAID_AT,
      providerPaidAmount: 499,
      refundedAt: PAID_AT,
    })
    db.orders = [order]
    const expected = expectedFor(order)
    db.grants = [{
      ...expected.grant,
      remainingQuantity: 0,
      status: 'revoked',
      createdAt: PAID_AT,
      updatedAt: PAID_AT,
    }]

    const result = await applyCheckoutCompleted(
      db.asDatabase(),
      checkoutEvent(),
    )
    assert.deepEqual(result, { ok: true })
    assert.equal(db.orders[0]?.status, 'refunded')
    assert.equal(db.grants[0]?.remainingQuantity, 0)
    assert.equal(db.transactions.length, 0)
  })
})

function refundEvent(overrides?: {
  providerRefundId?: string
  refundAmount?: number
  providerPaidAmount?: number
  providerOrderId?: string
  currency?: string
}) {
  return {
    kind: 'refund.created' as const,
    providerEventId: 'evt_ref_1',
    eventType: 'refund.created' as const,
    payloadHash: 'b'.repeat(64),
    refund: {
      providerRefundId: overrides?.providerRefundId ?? 'ref_1',
      status: 'succeeded' as const,
      refundAmount: overrides?.refundAmount ?? 499,
      currency: overrides?.currency ?? 'USD',
      providerTransactionId: 'txn_1',
      providerOrderId: overrides?.providerOrderId ?? 'ord_1',
      providerPaidAmount: overrides?.providerPaidAmount ?? 499,
      reasonCode: null,
    },
  }
}

function seedPaidOrderWithGrant(
  db: FakeFulfillmentDatabase,
  remainingQuantity = 5,
) {
  const order = baseOrder({
    status: 'paid',
    providerOrderId: 'ord_1',
    paidAt: PAID_AT,
  })
  db.orders = [order]
  const expected = expectedFor(order)
  db.grants = [{
    ...expected.grant,
    remainingQuantity,
    createdAt: PAID_AT,
    updatedAt: PAID_AT,
  }]
  db.transactions = [{
    ...expected.transaction,
    createdAt: PAID_AT,
  }]
  return { order, expected }
}

describe('applyRefundCreated and applyDisputeCreated', () => {
  it('full refund revokes remaining credits and marks original order refunded', async () => {
    const db = new FakeFulfillmentDatabase()
    seedPaidOrderWithGrant(db, 5)

    const result = await applyRefundCreated(db.asDatabase(), refundEvent())
    assert.deepEqual(result, { ok: true })
    assert.equal(db.orders[0]?.status, 'refunded')
    assert.equal(db.orders[0]?.providerPaidAmount, 499)
    assert.equal(db.orders[0]?.refundVersion, 1)
    assert.ok(db.orders[0]?.refundedAt instanceof Date)
    assert.equal(db.orders[0]?.amount, 499)
    assert.equal(db.refunds.length, 1)
    assert.equal(db.refunds[0]?.amount, 499)
    assert.equal(db.adjustments.length, 1)
    assert.equal(db.adjustments[0]?.targetQuantity, 5)
    assert.equal(db.adjustments[0]?.appliedQuantity, 5)
    assert.equal(db.adjustments[0]?.shortfallQuantity, 0)
    assert.equal(db.grants[0]?.remainingQuantity, 0)
    assert.equal(db.grants[0]?.status, 'revoked')
    const revoke = db.transactions.find(tx => tx.transactionType === 'revoke')
    assert.ok(revoke)
    assert.equal(revoke!.quantity, -5)
    assert.equal(revoke!.sourceType, 'refund')
  })

  it('partial then completing refund uses cumulative proportional targets', async () => {
    const db = new FakeFulfillmentDatabase()
    seedPaidOrderWithGrant(db, 5)

    const first = await applyRefundCreated(
      db.asDatabase(),
      refundEvent({ providerRefundId: 'ref_partial', refundAmount: 250 }),
    )
    assert.deepEqual(first, { ok: true })
    assert.equal(db.orders[0]?.status, 'partially_refunded')
    assert.equal(db.orders[0]?.refundVersion, 1)
    assert.equal(db.adjustments[0]?.targetQuantity, 2)
    assert.equal(db.grants[0]?.remainingQuantity, 3)

    const second = await applyRefundCreated(
      db.asDatabase(),
      refundEvent({ providerRefundId: 'ref_rest', refundAmount: 249 }),
    )
    assert.deepEqual(second, { ok: true })
    assert.equal(db.orders[0]?.status, 'refunded')
    assert.equal(db.orders[0]?.refundVersion, 2)
    assert.equal(db.refunds.length, 2)
    assert.equal(db.adjustments.length, 2)
    // second target = 5 - 2 = 3
    assert.equal(db.adjustments[1]?.targetQuantity, 3)
    assert.equal(db.grants[0]?.remainingQuantity, 0)
  })

  it('records shortfall without zero-value transaction when grant already consumed', async () => {
    const db = new FakeFulfillmentDatabase()
    seedPaidOrderWithGrant(db, 0)
    db.grants[0]!.status = 'active'

    const result = await applyRefundCreated(db.asDatabase(), refundEvent())
    assert.deepEqual(result, { ok: true })
    assert.equal(db.adjustments.length, 1)
    assert.equal(db.adjustments[0]?.targetQuantity, 5)
    assert.equal(db.adjustments[0]?.appliedQuantity, 0)
    assert.equal(db.adjustments[0]?.shortfallQuantity, 5)
    assert.equal(db.adjustments[0]?.entitlementTransactionId, null)
    assert.equal(
      db.transactions.filter(tx => tx.transactionType === 'revoke').length,
      0,
    )
    assert.equal(db.orders[0]?.status, 'refunded')
    assert.equal(db.grants[0]?.status, 'active')
    assert.equal(db.grants[0]?.remainingQuantity, 0)
  })

  it('is idempotent for the same provider refund id', async () => {
    const db = new FakeFulfillmentDatabase()
    seedPaidOrderWithGrant(db, 5)

    const first = await applyRefundCreated(db.asDatabase(), refundEvent())
    assert.deepEqual(first, { ok: true })
    const second = await applyRefundCreated(db.asDatabase(), refundEvent())
    assert.deepEqual(second, { ok: true })
    assert.equal(db.refunds.length, 1)
    assert.equal(db.adjustments.length, 1)
    assert.equal(
      db.transactions.filter(tx => tx.transactionType === 'revoke').length,
      1,
    )
  })

  it('rolls back and leaves the webhook retryable when refund version changed', async () => {
    const db = new FakeFulfillmentDatabase()
    seedPaidOrderWithGrant(db, 5)
    db.concurrentRefundVersionOnBatch = 1

    const result = await applyRefundCreated(db.asDatabase(), refundEvent())

    assert.deepEqual(result, {
      ok: false,
      errorCode: 'REFUND_CONCURRENT_MODIFICATION',
    })
    assert.equal(db.orders[0]?.status, 'paid')
    assert.equal(db.orders[0]?.refundVersion, 1)
    assert.equal(db.refunds.length, 0)
    assert.equal(db.adjustments.length, 0)
    assert.equal(
      db.transactions.filter(tx => tx.transactionType === 'revoke').length,
      0,
    )
  })

  it('rolls back and leaves the webhook retryable when grant balance changed', async () => {
    const db = new FakeFulfillmentDatabase()
    seedPaidOrderWithGrant(db, 5)
    db.concurrentGrantRemainingOnBatch = 4

    const result = await applyRefundCreated(db.asDatabase(), refundEvent())

    assert.deepEqual(result, {
      ok: false,
      errorCode: 'REFUND_CONCURRENT_MODIFICATION',
    })
    assert.equal(db.orders[0]?.status, 'paid')
    assert.equal(db.orders[0]?.refundVersion, 0)
    assert.equal(db.grants[0]?.remainingQuantity, 4)
    assert.equal(db.refunds.length, 0)
    assert.equal(db.adjustments.length, 0)
    assert.equal(
      db.transactions.filter(tx => tx.transactionType === 'revoke').length,
      0,
    )
  })

  it('rejects refund amounts that exceed the provider paid base', async () => {
    const db = new FakeFulfillmentDatabase()
    seedPaidOrderWithGrant(db, 5)

    const result = await applyRefundCreated(
      db.asDatabase(),
      refundEvent({ refundAmount: 500, providerPaidAmount: 499 }),
    )
    assert.deepEqual(result, {
      ok: false,
      errorCode: 'REFUND_EXCEEDS_PAID_BASE',
    })
    assert.equal(db.refunds.length, 0)
    assert.equal(db.orders[0]?.status, 'paid')
  })

  it('persists dispute.created as opened audit without changing credits', async () => {
    const db = new FakeFulfillmentDatabase()
    seedPaidOrderWithGrant(db, 5)

    const result = await applyDisputeCreated(db.asDatabase(), {
      kind: 'dispute.created',
      providerEventId: 'evt_disp_1',
      eventType: 'dispute.created',
      payloadHash: 'c'.repeat(64),
      dispute: {
        providerDisputeId: 'disp_1',
        providerOrderId: 'ord_1',
        providerTransactionId: 'txn_1',
        amount: 499,
        currency: 'USD',
      },
    })
    assert.deepEqual(result, { ok: true })
    assert.equal(db.disputes.length, 1)
    assert.equal(db.disputes[0]?.status, 'opened')
    assert.equal(db.orders[0]?.status, 'paid')
    assert.equal(db.grants[0]?.remainingQuantity, 5)
    assert.equal(db.refunds.length, 0)
  })
})
