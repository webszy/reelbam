/**
 * Checkout orchestration: catalog/entitlement preflight, app URL,
 * pending-order insert ownership, and Creem Test Checkout persistence.
 */

import { and, eq } from 'drizzle-orm'
import {
  billingOrders,
  billingPrices,
  billingProducts,
  productEntitlements,
} from '../../../database/schema'
import type { Database } from '../../../database/client'
import {
  CHECKOUT_CREDIT_PACK_CONTRACTS,
  type CheckoutEnabledPriceCode,
  type EntitlementSnapshot,
  type EntitlementSnapshotItem,
} from '../../../types/billing'
import { CheckoutError, AppError } from '../../errors'
import { matchesCheckoutEntitlement } from '../domain/credit-ledger'
import {
  isUniqueConstraintError,
  resolveExistingCheckoutOrder,
  type BillingOrderRow,
} from '../domain/order'
import {
  createValidatedCreemCheckout,
  validateCreemProduct,
} from '../providers/creem'
import type { LocalUser } from '../../../services/user-profile'

type ServerEvent = Parameters<typeof getRequestURL>[0]

export interface CheckoutCatalogSnapshot {
  productId: string
  productName: string
  priceId: string
  priceCode: CheckoutEnabledPriceCode
  amount: number
  currency: string
  units: number
  provider: 'creem'
  providerProductId: string
  entitlementSnapshot: EntitlementSnapshot
}

interface CloudflareAppEnv {
  cloudflare?: {
    env?: {
      APP_ENVIRONMENT?: unknown
      APP_URL?: unknown
    }
  }
}

/**
 * Resolve trusted success-page origin.
 * Localhost default is allowed only when APP_ENVIRONMENT === 'development'.
 * All other/missing environments require an explicit HTTPS pure origin.
 */
export function resolveTrustedAppOrigin(event: ServerEvent): string {
  const context = event.context as typeof event.context & CloudflareAppEnv
  const environment = context.cloudflare?.env?.APP_ENVIRONMENT
  const configured = context.cloudflare?.env?.APP_URL
  const isDevelopment = environment === 'development'

  if (
    (typeof configured !== 'string' || configured.trim().length === 0)
    && isDevelopment
  ) {
    return 'http://localhost:3000'
  }

  if (typeof configured !== 'string' || configured.trim().length === 0) {
    throw new AppError('SERVICE_UNAVAILABLE')
  }

  let url: URL
  try {
    url = new URL(configured.trim())
  }
  catch {
    throw new AppError('SERVICE_UNAVAILABLE')
  }

  if (url.username || url.password) {
    throw new AppError('SERVICE_UNAVAILABLE')
  }

  if (url.pathname !== '/' && url.pathname !== '') {
    throw new AppError('SERVICE_UNAVAILABLE')
  }

  if (url.search || url.hash) {
    throw new AppError('SERVICE_UNAVAILABLE')
  }

  if (isDevelopment) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AppError('SERVICE_UNAVAILABLE')
    }
  }
  else if (url.protocol !== 'https:') {
    throw new AppError('SERVICE_UNAVAILABLE')
  }

  return url.origin
}

export function buildCheckoutSuccessUrl(
  appOrigin: string,
  orderId: string,
): string {
  return `${appOrigin}/pricing?order=${encodeURIComponent(orderId)}`
}

/**
 * Load an enabled one-time credit pack and freeze its exact entitlement
 * snapshot. Fail closed on every catalog or provider-contract mismatch.
 */
export async function loadCheckoutCatalog(
  database: Database,
  priceCode: CheckoutEnabledPriceCode,
): Promise<CheckoutCatalogSnapshot> {
  const checkoutContract = CHECKOUT_CREDIT_PACK_CONTRACTS[priceCode]
  const rows = await database
    .select({
      price: billingPrices,
      product: billingProducts,
    })
    .from(billingPrices)
    .innerJoin(
      billingProducts,
      eq(billingPrices.productId, billingProducts.id),
    )
    .where(eq(billingPrices.code, priceCode))
    .limit(1)

  const row = rows[0]
  if (!row) {
    throw new AppError('SERVICE_UNAVAILABLE')
  }

  const { price, product } = row

  if (
    !price.active
    || !product.active
    || product.productKind !== 'credit_pack'
    || price.billingType !== 'one_time'
    || price.amount !== checkoutContract.amount
    || price.currency !== checkoutContract.currency
    || price.provider !== 'creem'
  ) {
    throw new AppError('SERVICE_UNAVAILABLE')
  }

  const providerProductId = typeof price.providerProductId === 'string'
    ? price.providerProductId.trim()
    : ''

  if (!providerProductId) {
    throw new AppError('SERVICE_UNAVAILABLE')
  }

  const entitlements = await database
    .select()
    .from(productEntitlements)
    .where(eq(productEntitlements.productId, product.id))

  if (
    entitlements.length !== 1
    || !matchesCheckoutEntitlement(
      entitlements[0]!,
      checkoutContract.entitlement,
    )
  ) {
    throw new AppError('SERVICE_UNAVAILABLE')
  }

  const entitlement = entitlements[0]!
  const snapshotItem: EntitlementSnapshotItem = {
    entitlement_key: entitlement.entitlementKey,
    entitlement_type: entitlement.entitlementType,
    quantity: entitlement.quantity,
    grant_cadence: entitlement.grantCadence,
    expiration_policy: entitlement.expirationPolicy,
    duration_days: entitlement.durationDays,
  }

  return {
    productId: product.id,
    productName: product.name,
    priceId: price.id,
    priceCode,
    amount: price.amount,
    currency: price.currency,
    units: checkoutContract.units,
    provider: 'creem',
    providerProductId,
    entitlementSnapshot: [snapshotItem],
  }
}

export async function findOrderByIdempotencyKey(
  database: Database,
  userId: string,
  idempotencyKey: string,
): Promise<BillingOrderRow | null> {
  const rows = await database
    .select()
    .from(billingOrders)
    .where(
      and(
        eq(billingOrders.userId, userId),
        eq(billingOrders.checkoutIdempotencyKey, idempotencyKey),
      ),
    )
    .limit(1)

  return rows[0] ?? null
}

async function markOrderFailed(
  database: Database,
  orderId: string,
  failureCode: string,
): Promise<void> {
  const now = new Date()
  await database
    .update(billingOrders)
    .set({
      status: 'failed',
      failureCode,
      failedAt: now,
      updatedAt: now,
    })
    .where(eq(billingOrders.id, orderId))
}

async function markOrderUnknown(
  database: Database,
  orderId: string,
): Promise<void> {
  const now = new Date()
  try {
    await database
      .update(billingOrders)
      .set({
        status: 'pending',
        failureCode: 'CHECKOUT_CREATION_UNKNOWN',
        updatedAt: now,
      })
      .where(eq(billingOrders.id, orderId))
  }
  catch {
    // Best-effort only.
  }
}

async function persistCheckoutSuccess(
  database: Database,
  orderId: string,
  checkoutId: string,
  checkoutUrl: string,
): Promise<boolean> {
  const now = new Date()
  try {
    const [updated] = await database
      .update(billingOrders)
      .set({
        providerCheckoutId: checkoutId,
        providerCheckoutUrl: checkoutUrl,
        failureCode: null,
        updatedAt: now,
      })
      .where(eq(billingOrders.id, orderId))
      .returning({
        id: billingOrders.id,
      })
    return updated?.id === orderId
  }
  catch {
    return false
  }
}

/**
 * Full Checkout Initiation path for a new or existing idempotency key.
 *
 * Callers must already have authenticated the local user and validated the
 * request's price code and idempotency key.
 */
export async function initiateCheckout(input: {
  event: ServerEvent
  database: Database
  localUser: LocalUser
  priceCode: CheckoutEnabledPriceCode
  idempotencyKey: string
}): Promise<{ checkoutUrl: string }> {
  const { event, database, localUser, priceCode, idempotencyKey } = input

  const existing = await findOrderByIdempotencyKey(
    database,
    localUser.id,
    idempotencyKey,
  )
  if (existing) {
    const resolved = resolveExistingCheckoutOrder(existing, priceCode)
    // Same order id, so a repeated request keeps the same deterministic event id.

    return resolved
  }

  // Verified primary email before any order or Provider call.
  const email = typeof localUser.primaryEmail === 'string'
    ? localUser.primaryEmail.trim()
    : ''
  if (!email || localUser.emailVerified !== true) {
    throw new CheckoutError('CHECKOUT_EMAIL_REQUIRED')
  }

  // Trusted app origin early so misconfiguration fails before Provider work.
  const appOrigin = resolveTrustedAppOrigin(event)

  const catalog = await loadCheckoutCatalog(database, priceCode)

  const productValidation = await validateCreemProduct(
    event,
    catalog.providerProductId,
    catalog.currency,
  )
  if (productValidation !== 'ok') {
    // No order, no Checkout POST.
    throw new AppError('SERVICE_UNAVAILABLE')
  }

  const orderId = crypto.randomUUID()
  const now = new Date()

  let inserted: BillingOrderRow | null
  try {
    const [row] = await database
      .insert(billingOrders)
      .values({
        id: orderId,
        userId: localUser.id,
        productId: catalog.productId,
        priceId: catalog.priceId,
        customerId: null,
        subscriptionId: null,
        status: 'pending',
        amount: catalog.amount,
        currency: catalog.currency,
        productNameSnapshot: catalog.productName,
        priceCodeSnapshot: catalog.priceCode,
        entitlementSnapshot: catalog.entitlementSnapshot,
        provider: catalog.provider,
        providerCheckoutId: null,
        providerCheckoutUrl: null,
        providerOrderId: null,
        checkoutIdempotencyKey: idempotencyKey,
        failureCode: null,
        createdAt: now,
        updatedAt: now,
        paidAt: null,
        failedAt: null,
        expiredAt: null,
        refundedAt: null,
      })
      .returning()

    inserted = row ?? null
  }
  catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw new AppError('INTERNAL_ERROR', { cause: error })
    }

    // Unique-conflict loser: re-read winner, never call Checkout.
    const winner = await findOrderByIdempotencyKey(
      database,
      localUser.id,
      idempotencyKey,
    )
    if (!winner) {
      throw new AppError('INTERNAL_ERROR')
    }
    const resolved = resolveExistingCheckoutOrder(winner, priceCode)

    return resolved
  }

  if (!inserted) {
    throw new AppError('INTERNAL_ERROR')
  }

  // Only the insert winner reaches this point.
  const successUrl = buildCheckoutSuccessUrl(appOrigin, inserted.id)
  const providerResult = await createValidatedCreemCheckout(event, {
    productId: catalog.providerProductId,
    requestId: inserted.id,
    units: catalog.units,
    customPrice: catalog.amount,
    currency: catalog.currency,
    customerEmail: email,
    successUrl,
  })

  if (providerResult.kind === 'rejected') {
    await markOrderFailed(database, inserted.id, 'CHECKOUT_PROVIDER_REJECTED')
    throw new CheckoutError('CHECKOUT_FAILED', {
      details: providerResult.details,
    })
  }

  if (providerResult.kind === 'unknown') {
    await markOrderUnknown(database, inserted.id)
    throw new CheckoutError('CHECKOUT_CREATION_UNKNOWN', {
      details: providerResult.details,
    })
  }

  const persisted = await persistCheckoutSuccess(
    database,
    inserted.id,
    providerResult.checkoutId,
    providerResult.checkoutUrl,
  )

  if (!persisted) {
    await markOrderUnknown(database, inserted.id)
    throw new CheckoutError('CHECKOUT_CREATION_UNKNOWN', {
      details: {
        provider: 'creem',
        stage: 'persistence',
        httpStatus: providerResult.httpStatus,
        traceId: providerResult.traceId,
        messages: [
          'Creem Checkout was created but its identifiers could not be persisted.',
        ],
        fieldDifferences: [{
          field: 'billing_order.provider_checkout',
          expected: 'persisted',
          actual: 'not_persisted',
        }],
      },
    })
  }

  // Only reached once the local order and the validated Creem URL are persisted.


  return { checkoutUrl: providerResult.checkoutUrl }
}
