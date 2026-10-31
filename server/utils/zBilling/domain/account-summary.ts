/**
 * Pure Account Summary mapping (no database / Clerk / provider / client I/O).
 *
 * Next expiry and latest paid Credit Pack are derived from already-loaded
 * local grant/order rows. Invalid selected snapshots are errors, not a
 * fallback to an older order or the mutable catalog.
 */
import type { BillingAccountSummaryData } from '../../../types/api'
import type { BillingOrderStatus } from '../../../types/billing'

import { CREDIT_PACK_PRICE_CODES } from '../../../../shared/billing-catalog'
export const ACCOUNT_SUMMARY_CREDIT_PACK_PRICE_CODES = CREDIT_PACK_PRICE_CODES
export type AccountSummaryCreditPackPriceCode = (typeof CREDIT_PACK_PRICE_CODES)[number]

export interface AccountSummaryGrantInput {
  userId: string
  entitlementKey: string
  entitlementType: string
  status: string
  remainingQuantity: number | null
  effectiveAt: Date | string
  expiresAt: Date | string | null
}

export interface AccountSummaryOrderInput {
  userId: string
  status: BillingOrderStatus | string
  amount: number
  currency: string
  priceCodeSnapshot: string
  entitlementSnapshot: unknown
  paidAt: Date | string | null
  createdAt: Date | string
}

export type AccountSummaryBuildResult
  = | {
    ok: true
    data: BillingAccountSummaryData
  }
  | {
    ok: false
    code: 'INTERNAL_ERROR'
  }

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value > 0
}

function toValidDate(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value)
    return Number.isFinite(parsed.getTime()) ? parsed : null
  }
  return null
}

function parseSnapshotJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }
  try {
    return JSON.parse(value)
  }
  catch {
    return value
  }
}

export function isAccountSummaryCreditPackPriceCode(
  value: unknown,
): value is AccountSummaryCreditPackPriceCode {
  return typeof value === 'string' && CREDIT_PACK_PRICE_CODES.some(code => code === value)
}

/**
 * Validate an immutable Credit Pack snapshot and return its credited credits.
 * Requires exactly one positive consumable credits purchase item.
 */
export function readCreditPackCreditsFromSnapshot(
  snapshot: unknown,
): { ok: true, credits: number } | { ok: false } {
  const parsed = parseSnapshotJson(snapshot)
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    return { ok: false }
  }

  const item = parsed[0]
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { ok: false }
  }

  const record = item as {
    entitlement_key?: unknown
    entitlement_type?: unknown
    quantity?: unknown
    grant_cadence?: unknown
  }

  if (
    record.entitlement_key !== 'credits'
    || record.entitlement_type !== 'consumable'
    || record.grant_cadence !== 'purchase'
    || !isPositiveInteger(record.quantity)
  ) {
    return { ok: false }
  }

  return { ok: true, credits: record.quantity }
}

export function isEligibleNextExpiryGrant(
  grant: AccountSummaryGrantInput,
  now: Date,
  ownerUserId: string,
): boolean {
  if (grant.userId !== ownerUserId) {
    return false
  }
  if (grant.entitlementKey !== 'credits') {
    return false
  }
  if (grant.entitlementType !== 'consumable') {
    return false
  }
  if (grant.status !== 'active') {
    return false
  }
  if (!isPositiveInteger(grant.remainingQuantity)) {
    return false
  }

  const effectiveAt = toValidDate(grant.effectiveAt)
  const expiresAt = toValidDate(grant.expiresAt)
  if (!effectiveAt || !expiresAt) {
    return false
  }

  return effectiveAt.getTime() <= now.getTime()
    && expiresAt.getTime() > now.getTime()
}

export function selectNextExpiry(
  grants: readonly AccountSummaryGrantInput[],
  now: Date,
  ownerUserId: string,
): BillingAccountSummaryData['nextExpiry'] {
  const eligible = grants.filter(grant =>
    isEligibleNextExpiryGrant(grant, now, ownerUserId),
  )
  if (eligible.length === 0) {
    return null
  }

  let earliestMs = Number.POSITIVE_INFINITY
  for (const grant of eligible) {
    const expiresAt = toValidDate(grant.expiresAt)
    if (!expiresAt) {
      continue
    }
    earliestMs = Math.min(earliestMs, expiresAt.getTime())
  }
  if (!Number.isFinite(earliestMs)) {
    return null
  }

  let credits = 0
  for (const grant of eligible) {
    const expiresAt = toValidDate(grant.expiresAt)
    if (expiresAt && expiresAt.getTime() === earliestMs) {
      credits += grant.remainingQuantity as number
    }
  }
  if (!isPositiveInteger(credits)) {
    return null
  }

  return {
    credits,
    expiresAt: new Date(earliestMs).toISOString(),
  }
}

export function isEligibleLatestPurchaseOrder(
  order: AccountSummaryOrderInput,
  ownerUserId: string,
): boolean {
  if (order.userId !== ownerUserId) {
    return false
  }
  if (order.status !== 'paid') {
    return false
  }
  if (!isAccountSummaryCreditPackPriceCode(order.priceCodeSnapshot)) {
    return false
  }
  return toValidDate(order.paidAt) !== null
}

function compareLatestPurchaseOrder(
  left: AccountSummaryOrderInput,
  right: AccountSummaryOrderInput,
): number {
  const leftPaid = toValidDate(left.paidAt)?.getTime() ?? 0
  const rightPaid = toValidDate(right.paidAt)?.getTime() ?? 0
  if (rightPaid !== leftPaid) {
    return rightPaid - leftPaid
  }

  const leftCreated = toValidDate(left.createdAt)?.getTime() ?? 0
  const rightCreated = toValidDate(right.createdAt)?.getTime() ?? 0
  return rightCreated - leftCreated
}

function isIsoCurrency(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value)
}

/**
 * Select the newest paid Credit Pack and map it. An invalid selected snapshot
 * or amount is a hard failure — never fall back to an older order.
 */
export function selectLatestPurchase(
  orders: readonly AccountSummaryOrderInput[],
  ownerUserId: string,
):
  | { ok: true, purchase: BillingAccountSummaryData['latestPurchase'] }
  | { ok: false } {
  const eligible = orders
    .filter(order => isEligibleLatestPurchaseOrder(order, ownerUserId))
    .sort(compareLatestPurchaseOrder)

  const selected = eligible[0]
  if (!selected) {
    return { ok: true, purchase: null }
  }

  if (!isPositiveInteger(selected.amount) || !isIsoCurrency(selected.currency)) {
    return { ok: false }
  }

  const credits = readCreditPackCreditsFromSnapshot(selected.entitlementSnapshot)
  if (!credits.ok) {
    return { ok: false }
  }

  const paidAt = toValidDate(selected.paidAt)
  if (!paidAt) {
    return { ok: false }
  }

  return {
    ok: true,
    purchase: {
      credits: credits.credits,
      amountCents: selected.amount,
      currency: selected.currency.toUpperCase(),
      paidAt: paidAt.toISOString(),
    },
  }
}

export function buildAccountSummaryFromLocalRows(input: {
  grants: readonly AccountSummaryGrantInput[]
  orders: readonly AccountSummaryOrderInput[]
  now: Date
  ownerUserId: string
}): AccountSummaryBuildResult {
  const nextExpiry = selectNextExpiry(input.grants, input.now, input.ownerUserId)
  const latestPurchase = selectLatestPurchase(input.orders, input.ownerUserId)
  if (!latestPurchase.ok) {
    return { ok: false, code: 'INTERNAL_ERROR' }
  }

  return {
    ok: true,
    data: {
      nextExpiry,
      latestPurchase: latestPurchase.purchase,
    },
  }
}
