/**
 * SaaS Starter boundary for Creem webhooks.
 *
 * - Trust: creem-signature only (no Clerk session).
 * - Persistence / idempotency / order mutation: this route.
 * - Signature + payload normalization: handle-webhook.ts.
 * - Paid-order credit fulfillment: grant + ledger from local entitlementSnapshot only.
 * - Refund/dispute Phase 1: original-order money state + proportional credit revoke.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Database } from '../../database/client'
import { runDatabaseOperation } from '../../database/client'
import {
  billingDisputes,
  billingOrders,
  billingRefundCreditAdjustments,
  billingRefunds,
  billingWebhookEvents,
  entitlementGrants,
  entitlementTransactions,
} from '../../database/schema'
import type {
  EntitlementSnapshot,
  EntitlementSnapshotItem,
} from '../../types/billing'
import {
  verifyAndNormalizeCreemWebhook,
  type NormalizedCreemWebhookEvent,
} from '../../utils/zBilling/application/handle-webhook'
import {
  evaluateCheckoutCompletedAgainstOrder,
  isUniqueConstraintError,
} from '../../utils/zBilling/domain/order'
import {
  buildLocalDisputeId,
  buildLocalRefundId,
  buildRefundCreditAdjustmentId,
  buildRefundRevokeTransactionIds,
  planGrantRefundReversal,
  resolveOrderRefundStatus,
} from '../../utils/zBilling/domain/refund'
import { ensureImmutableOrderCreditGrant } from '../../../packages/data/src/credits/fulfillment.ts'

type ServerEvent = Parameters<typeof getRequestURL>[0]

interface CloudflareWebhookEnv {
  cloudflare?: {
    env?: {
      CREEM_WEBHOOK_SECRET?: unknown
    }
  }
}

type WebhookEventRow = typeof billingWebhookEvents.$inferSelect
type BillingOrderRow = typeof billingOrders.$inferSelect

const PURCHASE_PERIOD_KEY = 'purchase'
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * D1/SQLite integer timestamps store whole seconds. Normalize before writing or
 * comparing so fulfillment verification does not fail on millisecond noise.
 */
export function toSqliteTimestamp(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000)
}

/** Expected grant row derived from a paid local order (deterministic identity). */
export interface ExpectedCreditGrant {
  id: string
  userId: string
  entitlementKey: string
  entitlementType: 'consumable'
  sourceType: 'order'
  sourceId: string
  periodKey: typeof PURCHASE_PERIOD_KEY
  grantedQuantity: number
  remainingQuantity: number
  effectiveAt: Date
  expiresAt: Date
  status: 'active'
}

/** Expected positive grant ledger row for the order-derived grant. */
export interface ExpectedCreditGrantTransaction {
  id: string
  userId: string
  grantId: string
  transactionType: 'grant'
  quantity: number
  sourceType: 'order'
  sourceId: string
  balanceBefore: 0
  balanceAfter: number
  idempotencyKey: string
}

export interface ExpectedOrderCreditFulfillment {
  grant: ExpectedCreditGrant
  transaction: ExpectedCreditGrantTransaction
}

function getCreemWebhookSecret(event: ServerEvent): string | null {
  const context = event.context as typeof event.context & CloudflareWebhookEnv
  const secret = context.cloudflare?.env?.CREEM_WEBHOOK_SECRET
  if (typeof secret !== 'string' || secret.trim().length === 0) {
    return null
  }
  return secret.trim()
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Guarded refund writes deliberately violate a check constraint if the order
 * version or grant balance changed after the read. D1 rolls the whole batch
 * back; report that expected race as retryable rather than accepting stale math.
 */
function isRefundConcurrencyConflict(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (current instanceof Error) {
      const message = current.message.toLowerCase()
      if (
        message.includes('billing_orders_refund_version_check')
        || message.includes('entitlement_grants_quantity_check')
      ) {
        return true
      }
      current = current.cause
      continue
    }
    if (typeof current === 'object' && current !== null && 'message' in current) {
      const message = (current as { message?: unknown }).message
      if (
        typeof message === 'string'
        && (
          message.toLowerCase().includes('billing_orders_refund_version_check')
          || message.toLowerCase().includes('entitlement_grants_quantity_check')
        )
      ) {
        return true
      }
    }
    break
  }
  return false
}

/**
 * Stable grant primary key from the grant source tuple.
 * Must never be regenerated randomly across retries.
 */
export function buildOrderCreditGrantId(
  orderId: string,
  entitlementKey: string,
  periodKey: string = PURCHASE_PERIOD_KEY,
): string {
  return `eg:order:${orderId}:${entitlementKey}:${periodKey}`
}

/**
 * Stable grant-transaction identity + ledger idempotency key.
 */
export function buildOrderCreditGrantTransactionIds(
  orderId: string,
  entitlementKey: string,
  periodKey: string = PURCHASE_PERIOD_KEY,
): { id: string, idempotencyKey: string } {
  const base = `order:${orderId}:${entitlementKey}:${periodKey}:grant`
  return {
    id: `et:${base}`,
    idempotencyKey: `entitlement:${base}`,
  }
}

function parseSupportedCreditSnapshotItem(
  snapshot: unknown,
):
  | { ok: true, item: EntitlementSnapshotItem & {
    entitlement_key: 'credits'
    entitlement_type: 'consumable'
    quantity: number
    grant_cadence: 'purchase'
    expiration_policy: 'fixed_duration'
    duration_days: number
  } }
  | { ok: false, errorCode: string } {
  if (!Array.isArray(snapshot) || snapshot.length !== 1) {
    return { ok: false, errorCode: 'ENTITLEMENT_SNAPSHOT_INVALID' }
  }

  const raw = snapshot[0]
  if (!isRecord(raw)) {
    return { ok: false, errorCode: 'ENTITLEMENT_SNAPSHOT_INVALID' }
  }

  if (raw.entitlement_key !== 'credits') {
    return { ok: false, errorCode: 'ENTITLEMENT_SNAPSHOT_UNSUPPORTED' }
  }
  if (raw.entitlement_type !== 'consumable') {
    return { ok: false, errorCode: 'ENTITLEMENT_SNAPSHOT_UNSUPPORTED' }
  }
  if (raw.grant_cadence !== 'purchase') {
    return { ok: false, errorCode: 'ENTITLEMENT_SNAPSHOT_UNSUPPORTED' }
  }
  if (raw.expiration_policy !== 'fixed_duration') {
    return { ok: false, errorCode: 'ENTITLEMENT_SNAPSHOT_UNSUPPORTED' }
  }
  if (!isPositiveInteger(raw.quantity)) {
    return { ok: false, errorCode: 'ENTITLEMENT_SNAPSHOT_INVALID' }
  }
  if (!isPositiveInteger(raw.duration_days)) {
    return { ok: false, errorCode: 'ENTITLEMENT_SNAPSHOT_INVALID' }
  }

  return {
    ok: true,
    item: {
      entitlement_key: 'credits',
      entitlement_type: 'consumable',
      quantity: raw.quantity,
      grant_cadence: 'purchase',
      expiration_policy: 'fixed_duration',
      duration_days: raw.duration_days,
    },
  }
}

/**
 * Convert a paid local order's immutable snapshot into expected grant + ledger
 * descriptors. Provider payload fields must never control quantity or expiry.
 */
export function buildExpectedOrderCreditFulfillment(input: {
  orderId: string
  userId: string
  entitlementSnapshot: EntitlementSnapshot | unknown
  paidAt: Date
}):
  | { ok: true, fulfillment: ExpectedOrderCreditFulfillment }
  | { ok: false, errorCode: string } {
  const parsed = parseSupportedCreditSnapshotItem(input.entitlementSnapshot)
  if (!parsed.ok) {
    return parsed
  }

  if (!(input.paidAt instanceof Date) || Number.isNaN(input.paidAt.getTime())) {
    return { ok: false, errorCode: 'ENTITLEMENT_PAID_AT_INVALID' }
  }

  const paidAt = toSqliteTimestamp(input.paidAt)
  const { item } = parsed
  const quantity = item.quantity
  const grantId = buildOrderCreditGrantId(input.orderId, item.entitlement_key)
  const txIds = buildOrderCreditGrantTransactionIds(
    input.orderId,
    item.entitlement_key,
  )
  const expiresAt = toSqliteTimestamp(
    new Date(paidAt.getTime() + item.duration_days * MS_PER_DAY),
  )

  if (Number.isNaN(expiresAt.getTime())) {
    return { ok: false, errorCode: 'ENTITLEMENT_SNAPSHOT_INVALID' }
  }

  const grant: ExpectedCreditGrant = {
    id: grantId,
    userId: input.userId,
    entitlementKey: item.entitlement_key,
    entitlementType: 'consumable',
    sourceType: 'order',
    sourceId: input.orderId,
    periodKey: PURCHASE_PERIOD_KEY,
    grantedQuantity: quantity,
    remainingQuantity: quantity,
    effectiveAt: paidAt,
    expiresAt,
    status: 'active',
  }

  const transaction: ExpectedCreditGrantTransaction = {
    id: txIds.id,
    userId: input.userId,
    grantId,
    transactionType: 'grant',
    quantity,
    sourceType: 'order',
    sourceId: input.orderId,
    balanceBefore: 0,
    balanceAfter: quantity,
    idempotencyKey: txIds.idempotencyKey,
  }

  return {
    ok: true,
    fulfillment: { grant, transaction },
  }
}

async function findWebhookEvent(
  database: Database,
  providerEventId: string,
): Promise<WebhookEventRow | null> {
  const rows = await database
    .select()
    .from(billingWebhookEvents)
    .where(
      and(
        eq(billingWebhookEvents.provider, 'creem'),
        eq(billingWebhookEvents.providerEventId, providerEventId),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

async function registerWebhookEvent(
  database: Database,
  event: NormalizedCreemWebhookEvent,
): Promise<{ row: WebhookEventRow, isNew: boolean }> {
  const existing = await findWebhookEvent(database, event.providerEventId)
  if (existing) {
    return { row: existing, isNew: false }
  }

  const now = new Date()
  const id = crypto.randomUUID()

  try {
    const [inserted] = await database
      .insert(billingWebhookEvents)
      .values({
        id,
        provider: 'creem',
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        status: 'received',
        payloadHash: event.payloadHash,
        attemptCount: 0,
        errorCode: null,
        createdAt: now,
        processedAt: null,
        updatedAt: now,
      })
      .returning()

    if (!inserted) {
      throw new Error('WEBHOOK_EVENT_INSERT_FAILED')
    }
    return { row: inserted, isNew: true }
  }
  catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error
    }
    const winner = await findWebhookEvent(database, event.providerEventId)
    if (!winner) {
      throw new Error('WEBHOOK_EVENT_RACE_LOST', { cause: error })
    }
    return { row: winner, isNew: false }
  }
}

async function markWebhookEvent(
  database: Database,
  eventId: string,
  update: {
    status: 'processing' | 'processed' | 'failed'
    attemptCount: number
    errorCode?: string | null
  },
): Promise<void> {
  const now = new Date()
  await database
    .update(billingWebhookEvents)
    .set({
      status: update.status,
      attemptCount: update.attemptCount,
      errorCode: update.errorCode ?? null,
      processedAt: update.status === 'processed' ? now : null,
      updatedAt: now,
    })
    .where(eq(billingWebhookEvents.id, eventId))
}

async function findOrderByProviderCheckoutId(
  database: Database,
  checkoutId: string,
): Promise<BillingOrderRow | null> {
  const rows = await database
    .select()
    .from(billingOrders)
    .where(
      and(
        eq(billingOrders.provider, 'creem'),
        eq(billingOrders.providerCheckoutId, checkoutId),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

async function findOrderByProviderOrderId(
  database: Database,
  providerOrderId: string,
): Promise<BillingOrderRow | null> {
  const rows = await database
    .select()
    .from(billingOrders)
    .where(
      and(
        eq(billingOrders.provider, 'creem'),
        eq(billingOrders.providerOrderId, providerOrderId),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

function grantInsertValues(expected: ExpectedCreditGrant, now: Date) {
  return {
    id: expected.id,
    userId: expected.userId,
    entitlementKey: expected.entitlementKey,
    entitlementType: expected.entitlementType,
    sourceType: expected.sourceType,
    sourceId: expected.sourceId,
    periodKey: expected.periodKey,
    grantedQuantity: expected.grantedQuantity,
    remainingQuantity: expected.remainingQuantity,
    effectiveAt: expected.effectiveAt,
    expiresAt: expected.expiresAt,
    status: expected.status,
    createdAt: now,
    updatedAt: now,
  }
}

function transactionInsertValues(
  expected: ExpectedCreditGrantTransaction,
  now: Date,
) {
  return {
    id: expected.id,
    userId: expected.userId,
    grantId: expected.grantId,
    transactionType: expected.transactionType,
    quantity: expected.quantity,
    sourceType: expected.sourceType,
    sourceId: expected.sourceId,
    balanceBefore: expected.balanceBefore,
    balanceAfter: expected.balanceAfter,
    idempotencyKey: expected.idempotencyKey,
    createdAt: now,
  }
}

/**
 * Confirm the immutable grant identity and original grant transaction.
 * Remaining and status may already have changed after consume, expiry, or refund.
 * A consumed grant with a missing original transaction is left for review.
 */
export async function ensureOrderCreditFulfillment(
  database: Database,
  fulfillment: ExpectedOrderCreditFulfillment,
): Promise<{ ok: true } | { ok: false, errorCode: string }> {
  const assessment = await ensureImmutableOrderCreditGrant(database, fulfillment)
  if (!assessment.ok) {
    return { ok: false, errorCode: assessment.errorCode }
  }
  return { ok: true }
}

/**
 * Apply a verified checkout.completed event to the matching local order and
 * ensure its purchase credits + ledger entry exist before success.
 * Returns an error code when the event cannot safely be applied.
 */
export async function applyCheckoutCompleted(
  database: Database,
  event: Extract<NormalizedCreemWebhookEvent, { kind: 'checkout.completed' }>,
): Promise<{ ok: true } | { ok: false, errorCode: string }> {
  const { checkout } = event
  const order = await findOrderByProviderCheckoutId(database, checkout.checkoutId)

  if (!order) {
    return { ok: false, errorCode: 'ORDER_NOT_FOUND' }
  }

  const match = evaluateCheckoutCompletedAgainstOrder({
    order: {
      id: order.id,
      status: order.status,
      amount: order.amount,
      currency: order.currency,
      providerOrderId: order.providerOrderId,
    },
    checkout,
  })
  if (!match.ok) {
    return match
  }

  // Late completion after refund: verified no-op. Never reset status or regrant.
  if (
    (order.status === 'refunded' || order.status === 'partially_refunded')
    && order.providerOrderId === checkout.providerOrderId
  ) {
    return { ok: true }
  }

  // Already paid with the same provider order — repair missing entitlements.
  if (
    order.status === 'paid'
    && order.providerOrderId === checkout.providerOrderId
  ) {
    if (!(order.paidAt instanceof Date) || Number.isNaN(order.paidAt.getTime())) {
      return { ok: false, errorCode: 'ENTITLEMENT_PAID_AT_INVALID' }
    }

    const expected = buildExpectedOrderCreditFulfillment({
      orderId: order.id,
      userId: order.userId,
      entitlementSnapshot: order.entitlementSnapshot,
      paidAt: order.paidAt,
    })
    if (!expected.ok) {
      return expected
    }

    return ensureOrderCreditFulfillment(
      database,
      expected.fulfillment,

    )
  }

  // Validate the snapshot before mutating payment state so unsupported packs
  // never transition the order while leaving no grant path.
  const now = new Date()
  const candidatePaidAt = toSqliteTimestamp(order.paidAt ?? now)
  const expected = buildExpectedOrderCreditFulfillment({
    orderId: order.id,
    userId: order.userId,
    entitlementSnapshot: order.entitlementSnapshot,
    paidAt: candidatePaidAt,
  })
  if (!expected.ok) {
    return expected
  }

  const { grant, transaction } = expected.fulfillment

  // One D1 batch transaction: conditional pending -> paid, grant, then ledger.
  // Grant before transaction preserves the FK order. On statement failure D1
  // rolls the batch back so paid is never committed without the credit rows.
  // Do not treat batch return as success — always re-read final state.
  await database.batch([
    database
      .update(billingOrders)
      .set({
        status: 'paid',
        providerOrderId: checkout.providerOrderId,
        failureCode: null,
        paidAt: candidatePaidAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(billingOrders.id, order.id),
          eq(billingOrders.provider, 'creem'),
          eq(billingOrders.providerCheckoutId, checkout.checkoutId),
          // Conditional update: only pending rows transition to paid.
          eq(billingOrders.status, 'pending'),
        ),
      )
      .returning({ id: billingOrders.id }),
    database
      .insert(entitlementGrants)
      .values(grantInsertValues(grant, now))
      .onConflictDoNothing(),
    database
      .insert(entitlementTransactions)
      .values(transactionInsertValues(transaction, now))
      .onConflictDoNothing(),
  ])

  // Re-read by provider Checkout ID. Rebuild expectations from the persisted
  // paidAt so a concurrent losing delivery cannot validate its speculative time.
  const latest = await findOrderByProviderCheckoutId(database, checkout.checkoutId)
  if (
    latest
    && latest.status === 'paid'
    && latest.providerOrderId === checkout.providerOrderId
  ) {
    if (
      !(latest.paidAt instanceof Date)
      || Number.isNaN(latest.paidAt.getTime())
    ) {
      return { ok: false, errorCode: 'ENTITLEMENT_PAID_AT_INVALID' }
    }

    const repaired = buildExpectedOrderCreditFulfillment({
      orderId: latest.id,
      userId: latest.userId,
      entitlementSnapshot: latest.entitlementSnapshot,
      paidAt: latest.paidAt,
    })
    if (!repaired.ok) {
      return repaired
    }

    // ensure is conflict-safe repair for concurrent/partial rows, then verify.
    return ensureOrderCreditFulfillment(
      database,
      repaired.fulfillment,

    )
  }

  return { ok: false, errorCode: 'ORDER_UPDATE_FAILED' }
}

/**
 * Apply a verified refund.created event to the original paid order:
 * upsert refund, proportional revoke (clamped), shortfall audit, order status.
 */
export async function applyRefundCreated(
  database: Database,
  event: Extract<NormalizedCreemWebhookEvent, { kind: 'refund.created' }>,
): Promise<{ ok: true } | { ok: false, errorCode: string }> {
  const { refund } = event
  const order = await findOrderByProviderOrderId(database, refund.providerOrderId)
  if (!order) {
    return { ok: false, errorCode: 'ORDER_NOT_FOUND' }
  }

  if (
    order.status !== 'paid'
    && order.status !== 'partially_refunded'
    && order.status !== 'refunded'
  ) {
    return { ok: false, errorCode: 'ORDER_STATUS_NOT_APPLICABLE' }
  }

  if (order.currency.toUpperCase() !== refund.currency) {
    return { ok: false, errorCode: 'ORDER_CURRENCY_MISMATCH' }
  }

  let paidBase = order.providerPaidAmount
  if (paidBase == null) {
    paidBase = refund.providerPaidAmount
  }
  else if (paidBase !== refund.providerPaidAmount) {
    return { ok: false, errorCode: 'PROVIDER_PAID_AMOUNT_MISMATCH' }
  }

  if (refund.refundAmount > paidBase) {
    return { ok: false, errorCode: 'REFUND_EXCEEDS_PAID_BASE' }
  }

  const refundId = buildLocalRefundId('creem', refund.providerRefundId)
  const existingRefundRows = await database
    .select()
    .from(billingRefunds)
    .where(
      and(
        eq(billingRefunds.provider, 'creem'),
        eq(billingRefunds.providerRefundId, refund.providerRefundId),
      ),
    )
    .limit(1)
  const existingRefund = existingRefundRows[0]

  if (existingRefund) {
    if (
      existingRefund.orderId !== order.id
      || existingRefund.amount !== refund.refundAmount
      || existingRefund.currency !== refund.currency
      || existingRefund.status !== 'succeeded'
    ) {
      return { ok: false, errorCode: 'REFUND_RECORD_MISMATCH' }
    }
    // Duplicate delivery: adjustment rows must already exist for this refund.
    const adjustments = await database
      .select()
      .from(billingRefundCreditAdjustments)
      .where(eq(billingRefundCreditAdjustments.refundId, existingRefund.id))
    if (adjustments.length === 0) {
      // Partial prior write — fail for retry rather than double-apply money.
      return { ok: false, errorCode: 'REFUND_ADJUSTMENT_MISSING' }
    }
    return { ok: true }
  }

  const priorSucceeded = await database
    .select()
    .from(billingRefunds)
    .where(
      and(
        eq(billingRefunds.orderId, order.id),
        eq(billingRefunds.status, 'succeeded'),
      ),
    )

  const priorCumulative = priorSucceeded.reduce(
    (sum, row) => sum + row.amount,
    0,
  )
  const cumulativeRefund = priorCumulative + refund.refundAmount
  if (cumulativeRefund > paidBase) {
    return { ok: false, errorCode: 'REFUND_EXCEEDS_PAID_BASE' }
  }

  const grants = await database
    .select()
    .from(entitlementGrants)
    .where(
      and(
        eq(entitlementGrants.sourceType, 'order'),
        eq(entitlementGrants.sourceId, order.id),
      ),
    )

  const now = new Date()
  const plans = grants
    .filter(grant =>
      grant.entitlementType === 'consumable'
      && typeof grant.grantedQuantity === 'number'
      && grant.grantedQuantity > 0
      && typeof grant.remainingQuantity === 'number'
      && grant.remainingQuantity >= 0,
    )
    .map(grant => planGrantRefundReversal({
      grantId: grant.id,
      grantedQuantity: grant.grantedQuantity!,
      remainingQuantity: grant.remainingQuantity!,
      paidBase,
      priorCumulativeRefund: priorCumulative,
      cumulativeRefund,
    }))

  const nextStatus = resolveOrderRefundStatus({
    paidBase,
    cumulativeSucceededRefund: cumulativeRefund,
  })

  const statements: BatchItem<'sqlite'>[] = []

  // This must execute first. Each refund increments the local revision, so a
  // second delivery calculated from the same cumulative snapshot aborts the
  // whole D1 batch and retries from current rows.
  statements.push(
    database
      .update(billingOrders)
      .set({
        status: nextStatus,
        providerPaidAmount: paidBase,
        refundVersion: sql`case
          when ${billingOrders.refundVersion} = ${order.refundVersion}
          then ${billingOrders.refundVersion} + 1
          else -1
        end`,
        refundedAt: nextStatus === 'refunded'
          ? (order.refundedAt ?? now)
          : order.refundedAt,
        updatedAt: now,
      })
      .where(eq(billingOrders.id, order.id)),
  )

  statements.push(
    database.insert(billingRefunds).values({
      id: refundId,
      orderId: order.id,
      provider: 'creem',
      providerRefundId: refund.providerRefundId,
      status: 'succeeded',
      amount: refund.refundAmount,
      currency: refund.currency,
      reasonCode: refund.reasonCode,
      createdAt: now,
      updatedAt: now,
      succeededAt: now,
      failedAt: null,
    }).onConflictDoNothing(),
  )

  for (const plan of plans) {
    const adjustmentId = buildRefundCreditAdjustmentId(refundId, plan.grantId)
    let transactionId: string | null = null
    const grant = grants.find(row => row.id === plan.grantId)!
    const balanceBefore = grant.remainingQuantity!
    const nextRemaining = balanceBefore - plan.appliedQuantity
    const nextGrantStatus = plan.appliedQuantity > 0 && nextRemaining === 0
      ? 'revoked' as const
      : grant.status

    statements.push(
      database
        .update(entitlementGrants)
        .set({
          // Applied 0 still writes. A WHERE remaining = expected would update
          // zero rows and let the rest of the batch commit.
          remainingQuantity: sql`case
            when ${entitlementGrants.remainingQuantity} = ${balanceBefore}
             and ${entitlementGrants.status} = ${grant.status}
            then ${nextRemaining}
            else -1
          end`,
          status: sql`case
            when ${entitlementGrants.remainingQuantity} = ${balanceBefore}
             and ${entitlementGrants.status} = ${grant.status}
            then ${nextGrantStatus}
            else ${entitlementGrants.status}
          end`,
          updatedAt: now,
        })
        .where(eq(entitlementGrants.id, plan.grantId)),
    )

    if (plan.appliedQuantity > 0) {
      const txIds = buildRefundRevokeTransactionIds(refundId, plan.grantId)
      transactionId = txIds.id
      statements.push(
        database.insert(entitlementTransactions).values({
          id: txIds.id,
          userId: order.userId,
          grantId: plan.grantId,
          transactionType: 'revoke',
          quantity: -plan.appliedQuantity,
          sourceType: 'refund',
          sourceId: refundId,
          balanceBefore,
          balanceAfter: nextRemaining,
          idempotencyKey: txIds.idempotencyKey,
          createdAt: now,
        }).onConflictDoNothing(),
      )
    }

    statements.push(
      database.insert(billingRefundCreditAdjustments).values({
        id: adjustmentId,
        refundId,
        grantId: plan.grantId,
        targetQuantity: plan.targetQuantity,
        appliedQuantity: plan.appliedQuantity,
        shortfallQuantity: plan.shortfallQuantity,
        entitlementTransactionId: transactionId,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing(),
    )
  }

  // Dynamic batch: always at least guarded order update + refund insert.
  try {
    await database.batch(
      statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]],
    )
  }
  catch (error) {
    if (isRefundConcurrencyConflict(error)) {
      return { ok: false, errorCode: 'REFUND_CONCURRENT_MODIFICATION' }
    }
    throw error
  }

  // Post-write verification
  const refundRow = (await database
    .select()
    .from(billingRefunds)
    .where(eq(billingRefunds.id, refundId))
    .limit(1))[0]
  if (
    !refundRow
    || refundRow.amount !== refund.refundAmount
    || refundRow.status !== 'succeeded'
    || refundRow.orderId !== order.id
  ) {
    return { ok: false, errorCode: 'REFUND_RECORD_MISMATCH' }
  }

  const orderAfter = (await database
    .select()
    .from(billingOrders)
    .where(eq(billingOrders.id, order.id))
    .limit(1))[0]
  if (
    !orderAfter
    || orderAfter.providerPaidAmount !== paidBase
    || orderAfter.status !== nextStatus
    || orderAfter.refundVersion !== order.refundVersion + 1
  ) {
    return { ok: false, errorCode: 'ORDER_UPDATE_FAILED' }
  }

  for (const plan of plans) {
    const adjustment = (await database
      .select()
      .from(billingRefundCreditAdjustments)
      .where(
        and(
          eq(billingRefundCreditAdjustments.refundId, refundId),
          eq(billingRefundCreditAdjustments.grantId, plan.grantId),
        ),
      )
      .limit(1))[0]
    if (
      !adjustment
      || adjustment.targetQuantity !== plan.targetQuantity
      || adjustment.appliedQuantity !== plan.appliedQuantity
      || adjustment.shortfallQuantity !== plan.shortfallQuantity
    ) {
      return { ok: false, errorCode: 'REFUND_ADJUSTMENT_MISMATCH' }
    }

    if (plan.appliedQuantity > 0) {
      const txIds = buildRefundRevokeTransactionIds(refundId, plan.grantId)
      const tx = (await database
        .select()
        .from(entitlementTransactions)
        .where(eq(entitlementTransactions.idempotencyKey, txIds.idempotencyKey))
        .limit(1))[0]
      if (
        !tx
        || tx.transactionType !== 'revoke'
        || tx.quantity !== -plan.appliedQuantity
        || tx.sourceType !== 'refund'
        || tx.sourceId !== refundId
        || tx.balanceBefore !== plan.remainingQuantity
        || tx.balanceAfter !== plan.remainingQuantity - plan.appliedQuantity
      ) {
        return { ok: false, errorCode: 'ENTITLEMENT_TRANSACTION_MISMATCH' }
      }
    }
  }

  return { ok: true }
}

/**
 * Persist an opened dispute audit row only — no order/credit mutation.
 */
export async function applyDisputeCreated(
  database: Database,
  event: Extract<NormalizedCreemWebhookEvent, { kind: 'dispute.created' }>,
): Promise<{ ok: true } | { ok: false, errorCode: string }> {
  const { dispute } = event
  const order = await findOrderByProviderOrderId(database, dispute.providerOrderId)
  if (!order) {
    return { ok: false, errorCode: 'ORDER_NOT_FOUND' }
  }

  if (
    dispute.currency
    && dispute.currency !== order.currency.toUpperCase()
  ) {
    return { ok: false, errorCode: 'ORDER_CURRENCY_MISMATCH' }
  }

  const disputeId = buildLocalDisputeId('creem', dispute.providerDisputeId)
  const now = new Date()

  await database
    .insert(billingDisputes)
    .values({
      id: disputeId,
      orderId: order.id,
      provider: 'creem',
      providerDisputeId: dispute.providerDisputeId,
      providerTransactionId: dispute.providerTransactionId,
      status: 'opened',
      amount: dispute.amount,
      currency: dispute.currency,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()

  const row = (await database
    .select()
    .from(billingDisputes)
    .where(
      and(
        eq(billingDisputes.provider, 'creem'),
        eq(billingDisputes.providerDisputeId, dispute.providerDisputeId),
      ),
    )
    .limit(1))[0]

  if (
    !row
    || row.orderId !== order.id
    || row.status !== 'opened'
  ) {
    return { ok: false, errorCode: 'DISPUTE_RECORD_MISMATCH' }
  }

  return { ok: true }
}

async function processNormalizedEvent(
  database: Database,
  event: NormalizedCreemWebhookEvent,
  webhookRow: WebhookEventRow,
): Promise<{ httpStatus: number }> {
  // Already processed — acknowledge without re-applying.
  if (webhookRow.status === 'processed') {
    return { httpStatus: 200 }
  }

  const nextAttempt = webhookRow.attemptCount + 1
  await markWebhookEvent(database, webhookRow.id, {
    status: 'processing',
    attemptCount: nextAttempt,
  })

  if (event.kind === 'unsupported') {
    await markWebhookEvent(database, webhookRow.id, {
      status: 'processed',
      attemptCount: nextAttempt,
      errorCode: null,
    })
    return { httpStatus: 200 }
  }

  let applied: { ok: true } | { ok: false, errorCode: string }
  if (event.kind === 'checkout.completed') {
    applied = await applyCheckoutCompleted(database, event)
  }
  else if (event.kind === 'refund.created') {
    applied = await applyRefundCreated(database, event)
  }
  else {
    applied = await applyDisputeCreated(database, event)
  }

  if (!applied.ok) {
    await markWebhookEvent(database, webhookRow.id, {
      status: 'failed',
      attemptCount: nextAttempt,
      errorCode: applied.errorCode,
    })
    // Non-2xx so Creem retries when safe application was not possible.
    return { httpStatus: 409 }
  }

  await markWebhookEvent(database, webhookRow.id, {
    status: 'processed',
    attemptCount: nextAttempt,
    errorCode: null,
  })
  return { httpStatus: 200 }
}

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')

  const secret = getCreemWebhookSecret(event)
  if (!secret) {
    console.error('[webhooks/creem] CREEM_WEBHOOK_SECRET is not configured')
    setResponseStatus(event, 503)
    return { ok: false }
  }

  const rawBody = await readRawBody(event, 'utf8')
  if (typeof rawBody !== 'string' || rawBody.length === 0) {
    setResponseStatus(event, 400)
    return { ok: false }
  }

  const signatureHeader = getHeader(event, 'creem-signature')
    ?? getHeader(event, 'Creem-Signature')

  const verified = await verifyAndNormalizeCreemWebhook({
    rawBody,
    signatureHeader: typeof signatureHeader === 'string' ? signatureHeader : undefined,
    webhookSecret: secret,
  })

  if (!verified.ok) {
    // Invalid signatures must not create events or alter orders.
    const status = verified.reason === 'invalid_signature' ? 401 : 400
    setResponseStatus(event, status)
    return { ok: false }
  }

  try {
    const result = await runDatabaseOperation(event, async (database) => {
      const registered = await registerWebhookEvent(database, verified.event)
      return processNormalizedEvent(database, verified.event, registered.row)
    })

    setResponseStatus(event, result.httpStatus)
    return { ok: result.httpStatus >= 200 && result.httpStatus < 300 }
  }
  catch (error) {
    console.error('[webhooks/creem] processing failed', {
      name: error instanceof Error ? error.name : typeof error,
    })
    setResponseStatus(event, 500)
    return { ok: false }
  }
})
