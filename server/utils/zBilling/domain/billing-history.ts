/**
 * Pure Billing History mapping (no database / Clerk / provider / client I/O).
 *
 * Selected local order and entitlement-transaction rows become owner-display
 * lists. Invalid primitives fail the whole mapping; unknown source
 * combinations become a generic activity label.
 */
import type {
  BillingHistoryActivityItem,
  BillingHistoryCreditActivityPage,
  BillingHistoryData,
  BillingHistoryPageKind,
  BillingHistoryPagination,
  BillingHistoryPaymentCredits,
  BillingHistoryPaymentDetails,
  BillingHistoryPaymentItem,
  BillingHistoryPaymentRefundFacts,
  BillingHistoryPaymentsPage,
} from '../../../types/api'
import type { BillingOrderStatus } from '../../../types/billing'
import { billingOrderStatuses } from '../../../types/billing'

export const BILLING_HISTORY_LIMIT = 5
export const BILLING_HISTORY_PAGE_SIZE = 20
export const BILLING_HISTORY_MAX_PAGE = 500
export const BILLING_HISTORY_PROCESSOR_NAME = 'Creem' as const
export const BILLING_HISTORY_PAGE_KINDS = [
  'payments',
  'credit-activity',
] as const satisfies readonly BillingHistoryPageKind[]
const DISPLAY_REFERENCE_PREFIX = 'DC-'
const DISPLAY_REFERENCE_TAIL = 8

export interface BillingHistoryPaymentInput {
  id: string
  userId: string
  productName: string
  amount: number
  currency: string
  status: string
  createdAt: Date | string
  paidAt: Date | string | null
}

export interface BillingHistoryActivityInput {
  id: string
  userId: string
  grantUserId: string
  transactionType: string
  quantity: number
  balanceAfter: number
  createdAt: Date | string
  grantSourceType: string
  grantExpiresAt: Date | string | null
  productName: string | null
}

export interface BillingHistoryGrantInput {
  userId: string
  sourceType: string
  sourceId: string
  entitlementKey: string
  entitlementType: string
  grantedQuantity: number | null
  remainingQuantity: number | null
  expiresAt: Date | string | null
}

export interface BillingHistoryRefundInput {
  orderId: string
  status: string
  amount: number
  currency: string
  succeededAt: Date | string | null
  createdAt: Date | string
}

export interface BillingHistoryAdjustmentInput {
  orderId: string
  appliedQuantity: number
}

export type BillingHistoryBuildResult
  = | {
    ok: true
    data: BillingHistoryData
  }
  | {
    ok: false
    code: 'INTERNAL_ERROR'
  }

export type BillingHistoryPaymentsPageBuildResult
  = | {
    ok: true
    data: BillingHistoryPaymentsPage
  }
  | {
    ok: false
    code: 'INTERNAL_ERROR'
  }

export type BillingHistoryCreditActivityPageBuildResult
  = | {
    ok: true
    data: BillingHistoryCreditActivityPage
  }
  | {
    ok: false
    code: 'INTERNAL_ERROR'
  }

export type BillingHistoryQueryParseResult
  = | {
    mode: 'preview'
  }
  | {
    mode: 'page'
    kind: BillingHistoryPageKind
    page: number
  }
  | {
    mode: 'invalid'
    code: 'INVALID_HISTORY_QUERY'
  }

const ORDER_STATUS_SET = new Set<string>(billingOrderStatuses)

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value > 0
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0
}

function isIsoCurrency(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value)
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

function isBillingOrderStatus(value: string): value is BillingOrderStatus {
  return ORDER_STATUS_SET.has(value)
}

function compareNewestFirst(
  left: Date | string,
  right: Date | string,
): number {
  const leftMs = toValidDate(left)?.getTime() ?? 0
  const rightMs = toValidDate(right)?.getTime() ?? 0
  return rightMs - leftMs
}

function compareNewestFirstWithId(
  left: { id: string, createdAt: Date | string },
  right: { id: string, createdAt: Date | string },
): number {
  const byTime = compareNewestFirst(left.createdAt, right.createdAt)
  if (byTime !== 0) {
    return byTime
  }
  return right.id.localeCompare(left.id)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePageNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1 || value > BILLING_HISTORY_MAX_PAGE) {
      return null
    }
    return value
  }
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed > BILLING_HISTORY_MAX_PAGE) {
      return null
    }
    return parsed
  }
  return null
}

function isHistoryPageKind(value: unknown): value is BillingHistoryPageKind {
  return (BILLING_HISTORY_PAGE_KINDS as readonly string[]).includes(value as string)
}

export function parseBillingHistoryQuery(query: unknown): BillingHistoryQueryParseResult {
  if (query == null) {
    return { mode: 'preview' }
  }
  if (!isRecord(query)) {
    return { mode: 'invalid', code: 'INVALID_HISTORY_QUERY' }
  }

  const hasKind = Object.prototype.hasOwnProperty.call(query, 'kind')
  const hasPage = Object.prototype.hasOwnProperty.call(query, 'page')
  if (!hasKind && !hasPage) {
    return { mode: 'preview' }
  }
  if (!hasKind || !hasPage) {
    return { mode: 'invalid', code: 'INVALID_HISTORY_QUERY' }
  }

  const kind = query.kind
  const page = query.page
  if (Array.isArray(kind) || Array.isArray(page) || !isHistoryPageKind(kind)) {
    return { mode: 'invalid', code: 'INVALID_HISTORY_QUERY' }
  }

  const pageNumber = parsePageNumber(page)
  if (pageNumber === null) {
    return { mode: 'invalid', code: 'INVALID_HISTORY_QUERY' }
  }

  return {
    mode: 'page',
    kind,
    page: pageNumber,
  }
}

export function buildBillingHistoryPagination(
  total: number,
  page: number,
): BillingHistoryPagination | null {
  if (!isNonNegativeInteger(total) || !isPositiveInteger(page)) {
    return null
  }
  return {
    page,
    pageSize: BILLING_HISTORY_PAGE_SIZE,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / BILLING_HISTORY_PAGE_SIZE),
  }
}

function isValidLedgerQuantity(
  transactionType: string,
  quantity: number,
): boolean {
  if (!isInteger(quantity) || quantity === 0) {
    return false
  }
  if (transactionType === 'grant' || transactionType === 'refund') {
    return quantity > 0
  }
  if (
    transactionType === 'consume'
    || transactionType === 'expire'
    || transactionType === 'revoke'
  ) {
    return quantity < 0
  }
  if (transactionType === 'adjustment') {
    return quantity !== 0
  }
  return isInteger(quantity) && quantity !== 0
}

export function creditActivityLabel(input: {
  transactionType: string
  grantSourceType: string
  productName: string | null
}): string {
  if (input.transactionType === 'consume') {
    return 'Credits used'
  }
  if (input.transactionType === 'refund') {
    return 'Credits refunded'
  }
  if (input.transactionType === 'revoke') {
    return 'Credits reversed'
  }
  if (input.transactionType === 'expire') {
    return 'Credits expired'
  }
  if (input.transactionType === 'adjustment') {
    return 'Credit adjustment'
  }
  if (input.transactionType === 'grant') {
    if (input.grantSourceType === 'order') {
      const productName = input.productName?.trim()
      if (productName) {
        return `Purchased ${productName}`
      }
      return 'Purchased credits'
    }
    return 'Credits added'
  }
  return 'Credit activity'
}

export function toPaymentDisplayReference(orderId: string): string | null {
  const trimmed = orderId.trim()
  if (trimmed.length === 0) {
    return null
  }
  return `${DISPLAY_REFERENCE_PREFIX}${trimmed.slice(-DISPLAY_REFERENCE_TAIL)}`
}

function isMatchingCreditGrant(
  grant: BillingHistoryGrantInput,
  ownerUserId: string,
  orderId: string,
): boolean {
  return grant.userId === ownerUserId
    && grant.sourceType === 'order'
    && grant.sourceId === orderId
    && grant.entitlementKey === 'credits'
    && grant.entitlementType === 'consumable'
}

function mapPaymentCredits(
  status: BillingOrderStatus,
  orderId: string,
  ownerUserId: string,
  grants: readonly BillingHistoryGrantInput[],
): BillingHistoryPaymentCredits | false {
  if (status !== 'paid') {
    return { state: 'none' }
  }

  let added = 0
  let remaining = 0
  let matched = 0
  let earliestExpiryMs: number | null = null

  for (const grant of grants) {
    if (!isMatchingCreditGrant(grant, ownerUserId, orderId)) {
      continue
    }
    if (
      !isNonNegativeInteger(grant.grantedQuantity)
      || !isNonNegativeInteger(grant.remainingQuantity)
      || grant.remainingQuantity > grant.grantedQuantity
    ) {
      return false
    }
    if (grant.expiresAt != null) {
      const expiry = toValidDate(grant.expiresAt)
      if (!expiry) {
        return false
      }
      if (earliestExpiryMs === null || expiry.getTime() < earliestExpiryMs) {
        earliestExpiryMs = expiry.getTime()
      }
    }
    added += grant.grantedQuantity
    remaining += grant.remainingQuantity
    matched += 1
  }

  if (matched === 0) {
    return { state: 'verifying' }
  }
  if (remaining > added) {
    return false
  }

  return {
    state: 'recorded',
    added,
    remaining,
    expiresAt: earliestExpiryMs === null
      ? null
      : new Date(earliestExpiryMs).toISOString(),
  }
}

function mapPaymentRefund(
  orderId: string,
  refunds: readonly BillingHistoryRefundInput[],
  adjustments: readonly BillingHistoryAdjustmentInput[],
): BillingHistoryPaymentRefundFacts | null | false {
  const succeeded: Array<{
    amount: number
    currency: string
    refundedAt: Date
  }> = []

  for (const refund of refunds) {
    if (refund.orderId !== orderId) {
      continue
    }
    if (refund.status !== 'succeeded') {
      continue
    }
    const refundedAt = toValidDate(refund.succeededAt) ?? toValidDate(refund.createdAt)
    if (
      !isPositiveInteger(refund.amount)
      || !isIsoCurrency(refund.currency)
      || !refundedAt
    ) {
      return false
    }
    succeeded.push({
      amount: refund.amount,
      currency: refund.currency.toUpperCase(),
      refundedAt,
    })
  }

  if (succeeded.length === 0) {
    return null
  }

  const currency = succeeded[0]!.currency
  let amountCents = 0
  let latestMs = 0
  for (const refund of succeeded) {
    if (refund.currency !== currency) {
      return false
    }
    amountCents += refund.amount
    latestMs = Math.max(latestMs, refund.refundedAt.getTime())
  }

  let reversedCredits: number | null = null
  for (const adjustment of adjustments) {
    if (adjustment.orderId !== orderId) {
      continue
    }
    if (!isNonNegativeInteger(adjustment.appliedQuantity)) {
      return false
    }
    reversedCredits = (reversedCredits ?? 0) + adjustment.appliedQuantity
  }

  return {
    amountCents,
    currency,
    refundedAt: new Date(latestMs).toISOString(),
    reversedCredits,
  }
}

function mapPaymentDetails(
  input: {
    id: string
    product: string
    amountCents: number
    currency: string
    status: BillingOrderStatus
    orderedAt: string
    paidAt: string | null
  },
  credits: BillingHistoryPaymentCredits,
  refund: BillingHistoryPaymentRefundFacts | null,
): BillingHistoryPaymentDetails | false {
  const reference = toPaymentDisplayReference(input.id)
  if (!reference) {
    return false
  }

  return {
    reference,
    product: input.product,
    amountCents: input.amountCents,
    currency: input.currency,
    status: input.status,
    orderedAt: input.orderedAt,
    paidAt: input.paidAt,
    processorName: BILLING_HISTORY_PROCESSOR_NAME,
    credits,
    refund,
  }
}

/**
 * null = other-user exclusion; false = invalid owner row; item = mapped row.
 */
function mapOwnedPaymentRow(
  input: BillingHistoryPaymentInput,
  ownerUserId: string,
  grants: readonly BillingHistoryGrantInput[],
  refunds: readonly BillingHistoryRefundInput[],
  adjustments: readonly BillingHistoryAdjustmentInput[],
): BillingHistoryPaymentItem | null | false {
  if (input.userId !== ownerUserId) {
    return null
  }

  const product = input.productName.trim()
  const createdAt = toValidDate(input.createdAt)
  const paidAt = input.paidAt == null ? null : toValidDate(input.paidAt)
  if (
    typeof input.id !== 'string'
    || input.id.trim().length === 0
    || product.length === 0
    || !isPositiveInteger(input.amount)
    || !isIsoCurrency(input.currency)
    || !isBillingOrderStatus(input.status)
    || !createdAt
    || (input.paidAt != null && !paidAt)
  ) {
    return false
  }

  const currency = input.currency.toUpperCase()
  const orderedAt = createdAt.toISOString()
  const paidAtIso = paidAt ? paidAt.toISOString() : null
  const credits = mapPaymentCredits(input.status, input.id, ownerUserId, grants)
  if (credits === false) {
    return false
  }
  const refund = mapPaymentRefund(input.id, refunds, adjustments)
  if (refund === false) {
    return false
  }
  const details = mapPaymentDetails(
    {
      id: input.id,
      product,
      amountCents: input.amount,
      currency,
      status: input.status,
      orderedAt,
      paidAt: paidAtIso,
    },
    credits,
    refund,
  )
  if (details === false) {
    return false
  }

  return {
    date: orderedAt,
    product,
    amountCents: input.amount,
    currency,
    status: input.status,
    details,
  }
}

function mapOwnedActivityRow(
  input: BillingHistoryActivityInput,
  ownerUserId: string,
): BillingHistoryActivityItem | null | false {
  if (input.userId !== ownerUserId || input.grantUserId !== ownerUserId) {
    return null
  }

  const createdAt = toValidDate(input.createdAt)
  if (
    !createdAt
    || !isValidLedgerQuantity(input.transactionType, input.quantity)
    || !isNonNegativeInteger(input.balanceAfter)
  ) {
    return false
  }

  let expiresAt: string | null = null
  if (input.grantExpiresAt != null) {
    const expiry = toValidDate(input.grantExpiresAt)
    if (!expiry) {
      return false
    }
    expiresAt = expiry.toISOString()
  }

  return {
    date: createdAt.toISOString(),
    activity: creditActivityLabel(input),
    change: input.quantity,
    balanceAfter: input.balanceAfter,
    expiresAt,
  }
}

function mapOwnedPaymentRows(
  rows: readonly BillingHistoryPaymentInput[],
  ownerUserId: string,
  grants: readonly BillingHistoryGrantInput[],
  refunds: readonly BillingHistoryRefundInput[],
  adjustments: readonly BillingHistoryAdjustmentInput[],
  limit: number,
):
  | { ok: true, items: BillingHistoryPaymentItem[] }
  | { ok: false, code: 'INTERNAL_ERROR' } {
  const items: BillingHistoryPaymentItem[] = []
  const sorted = [...rows].sort(compareNewestFirstWithId)
  for (const row of sorted) {
    const mapped = mapOwnedPaymentRow(
      row,
      ownerUserId,
      grants,
      refunds,
      adjustments,
    )
    if (mapped === false) {
      return { ok: false, code: 'INTERNAL_ERROR' }
    }
    if (mapped && items.length < limit) {
      items.push(mapped)
    }
  }
  return { ok: true, items }
}

function mapOwnedActivityRows(
  rows: readonly BillingHistoryActivityInput[],
  ownerUserId: string,
  limit: number,
):
  | { ok: true, items: BillingHistoryActivityItem[] }
  | { ok: false, code: 'INTERNAL_ERROR' } {
  const items: BillingHistoryActivityItem[] = []
  const sorted = [...rows].sort(compareNewestFirstWithId)
  for (const row of sorted) {
    if (typeof row.id !== 'string' || row.id.trim().length === 0) {
      return { ok: false, code: 'INTERNAL_ERROR' }
    }
    const mapped = mapOwnedActivityRow(row, ownerUserId)
    if (mapped === false) {
      return { ok: false, code: 'INTERNAL_ERROR' }
    }
    if (mapped && items.length < limit) {
      items.push(mapped)
    }
  }
  return { ok: true, items }
}

export function buildBillingHistoryFromLocalRows(input: {
  payments: readonly BillingHistoryPaymentInput[]
  activities: readonly BillingHistoryActivityInput[]
  grants?: readonly BillingHistoryGrantInput[]
  refunds?: readonly BillingHistoryRefundInput[]
  adjustments?: readonly BillingHistoryAdjustmentInput[]
  ownerUserId: string
}): BillingHistoryBuildResult {
  const payments = mapOwnedPaymentRows(
    input.payments,
    input.ownerUserId,
    input.grants ?? [],
    input.refunds ?? [],
    input.adjustments ?? [],
    BILLING_HISTORY_LIMIT,
  )
  if (!payments.ok) {
    return payments
  }

  const activities = mapOwnedActivityRows(
    input.activities,
    input.ownerUserId,
    BILLING_HISTORY_LIMIT,
  )
  if (!activities.ok) {
    return activities
  }

  return {
    ok: true,
    data: {
      paymentHistory: payments.items,
      creditActivity: activities.items,
    },
  }
}

export function buildBillingHistoryPaymentsPage(input: {
  payments: readonly BillingHistoryPaymentInput[]
  grants?: readonly BillingHistoryGrantInput[]
  refunds?: readonly BillingHistoryRefundInput[]
  adjustments?: readonly BillingHistoryAdjustmentInput[]
  ownerUserId: string
  page: number
  total: number
}): BillingHistoryPaymentsPageBuildResult {
  const pagination = buildBillingHistoryPagination(input.total, input.page)
  if (!pagination) {
    return { ok: false, code: 'INTERNAL_ERROR' }
  }

  const payments = mapOwnedPaymentRows(
    input.payments,
    input.ownerUserId,
    input.grants ?? [],
    input.refunds ?? [],
    input.adjustments ?? [],
    BILLING_HISTORY_PAGE_SIZE,
  )
  if (!payments.ok) {
    return payments
  }

  return {
    ok: true,
    data: {
      kind: 'payments',
      items: payments.items,
      pagination,
    },
  }
}

export function buildBillingHistoryCreditActivityPage(input: {
  activities: readonly BillingHistoryActivityInput[]
  ownerUserId: string
  page: number
  total: number
}): BillingHistoryCreditActivityPageBuildResult {
  const pagination = buildBillingHistoryPagination(input.total, input.page)
  if (!pagination) {
    return { ok: false, code: 'INTERNAL_ERROR' }
  }

  const activities = mapOwnedActivityRows(
    input.activities,
    input.ownerUserId,
    BILLING_HISTORY_PAGE_SIZE,
  )
  if (!activities.ok) {
    return activities
  }

  return {
    ok: true,
    data: {
      kind: 'credit-activity',
      items: activities.items,
      pagination,
    },
  }
}
