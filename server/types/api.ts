import type { BillingOrderStatus } from './billing'
export type InfrastructureErrorCode = 'SERVICE_UNAVAILABLE' | 'INTERNAL_ERROR'
export type AuthorizationErrorCode = 'UNAUTHORIZED'
export type EnvelopeErrorCode = AuthorizationErrorCode | InfrastructureErrorCode
export type ApiResponse<TData, TCode extends string = EnvelopeErrorCode> =
  | { success: true, data: TData }
  | { success: false, data: null, code: TCode }
export interface PublicUserDto {
  id: string
  email: string | null
  emailVerified: boolean
  firstName: string | null
  lastName: string | null
  displayName: string | null
  username: string | null
  avatarUrl: string | null
  createdAt: string
  lastSeenAt: string
  lastLoginAt: string | null
}

export type MeResponse = ApiResponse<PublicUserDto & { credits: number }>
export type CheckoutErrorCode
  = | 'INVALID_IDEMPOTENCY_KEY'
    | 'CHECKOUT_EMAIL_REQUIRED'
    | 'IDEMPOTENCY_KEY_REUSED'
    | 'CHECKOUT_IN_PROGRESS'
    | 'CHECKOUT_FAILED'
    | 'CHECKOUT_CREATION_UNKNOWN'
    | EnvelopeErrorCode

export interface CheckoutSuccessData {
  checkoutUrl: string
}

export type CheckoutProviderStage
  = | 'create'
    | 'create_validation'
    | 'retrieve'
    | 'retrieve_validation'
    | 'persistence'

export type CheckoutDiagnosticValue = string | number | null

export interface CheckoutProviderFieldDifference {
  field: string
  expected: CheckoutDiagnosticValue
  actual: CheckoutDiagnosticValue
}

/**
 * Provider diagnostics returned only for Checkout failures. This deliberately
 * excludes request headers, API keys, customer data, and raw response bodies.
 */
export interface CheckoutProviderDetails {
  provider: 'creem'
  stage: CheckoutProviderStage
  httpStatus: number | null
  traceId: string | null
  messages: string[]
  fieldDifferences: CheckoutProviderFieldDifference[]
}

export interface CheckoutErrorDebug {
  name?: string
  message?: string
  stack?: string
  type?: string
}

export interface CheckoutErrorResponse<
  TCode extends CheckoutErrorCode = CheckoutErrorCode,
> {
  success: false
  data: null
  code: TCode
  details?: CheckoutProviderDetails
  debug?: CheckoutErrorDebug
}

export type CheckoutResponse
  = | {
    success: true
    data: CheckoutSuccessData
  }
  | CheckoutErrorResponse

// ---------------------------------------------------------------------------
// Local order status (`GET /api/billing/orders/:id`)
// ---------------------------------------------------------------------------

/**
 * Minimal owner-scoped order view for the billing return page.
 * Never includes provider payloads, amounts, or cross-user existence hints.
 */
export interface BillingOrderStatusData {
  orderId: string
  status: BillingOrderStatus
}

export type BillingOrderStatusErrorCode
  = EnvelopeErrorCode
    | 'ORDER_NOT_FOUND'

export type BillingOrderStatusResponse
  = ApiResponse<BillingOrderStatusData, BillingOrderStatusErrorCode>

// ---------------------------------------------------------------------------
// Billing account summary (`GET /api/billing/summary`)
// ---------------------------------------------------------------------------

/**
 * Owner-display next-expiry fact. Credits are remaining quantity at the
 * earliest eligible grant expiry. expiresAt is an ISO timestamp.
 */
export interface BillingAccountSummaryNextExpiry {
  credits: number
  expiresAt: string
}

/**
 * Owner-display latest paid Credit Pack fact.
 * amountCents is the local order amount; currency is ISO 4217; paidAt is ISO.
 */
export interface BillingAccountSummaryLatestPurchase {
  credits: number
  amountCents: number
  currency: string
  paidAt: string
}

/**
 * Billing-only Account Summary details. Balance stays on /api/me.
 * Never includes order IDs, provider fields, customer data, or snapshots.
 */
export interface BillingAccountSummaryData {
  nextExpiry: BillingAccountSummaryNextExpiry | null
  latestPurchase: BillingAccountSummaryLatestPurchase | null
}

export type BillingAccountSummaryErrorCode = EnvelopeErrorCode

export type BillingAccountSummaryResponse
  = ApiResponse<BillingAccountSummaryData, BillingAccountSummaryErrorCode>

// ---------------------------------------------------------------------------
// Billing history (`GET /api/billing/history`)
// ---------------------------------------------------------------------------

/**
 * Recorded order-linked credits grant facts. Quantities come from the
 * local grant row; expiresAt is omitted as null when the grant has none.
 */
export interface BillingHistoryPaymentCreditRecorded {
  state: 'recorded'
  added: number
  remaining: number
  expiresAt: string | null
}

/** Paid order with no valid order-linked credits grant. */
export interface BillingHistoryPaymentCreditVerifying {
  state: 'verifying'
}

/** Non-paid (or refunded) states that must not display a credited quantity. */
export interface BillingHistoryPaymentCreditNone {
  state: 'none'
}

export type BillingHistoryPaymentCredits
  = | BillingHistoryPaymentCreditRecorded
    | BillingHistoryPaymentCreditVerifying
    | BillingHistoryPaymentCreditNone

/**
 * Successful local refund facts. reversedCredits is the sum of recorded
 * appliedQuantity values, or null when no adjustment rows exist.
 */
export interface BillingHistoryPaymentRefundFacts {
  amountCents: number
  currency: string
  refundedAt: string
  reversedCredits: number | null
}

/**
 * Presentation-safe modal payload. reference is an opaque DC- display value.
 * processorName is the fixed local label. Never includes raw identifiers.
 */
export interface BillingHistoryPaymentDetails {
  reference: string
  product: string
  amountCents: number
  currency: string
  status: BillingOrderStatus
  orderedAt: string
  paidAt: string | null
  processorName: 'Creem'
  credits: BillingHistoryPaymentCredits
  refund: BillingHistoryPaymentRefundFacts | null
}

/**
 * Owner-display payment row. Date is the local order createdAt.
 * Product and amount come from immutable local order snapshots.
 */
export interface BillingHistoryPaymentItem {
  date: string
  product: string
  amountCents: number
  currency: string
  status: BillingOrderStatus
  details: BillingHistoryPaymentDetails
}

/**
 * Owner-display credit-activity row. change is the signed ledger quantity.
 * expiresAt is the linked grant expiry, or null when the grant has none.
 */
export interface BillingHistoryActivityItem {
  date: string
  activity: string
  change: number
  balanceAfter: number
  expiresAt: string | null
}

/**
 * Billing-only recent history. Never includes order, grant, transaction,
 * provider, customer, checkout, snapshot, or idempotency identifiers.
 */
export interface BillingHistoryData {
  paymentHistory: BillingHistoryPaymentItem[]
  creditActivity: BillingHistoryActivityItem[]
}

export type BillingHistoryPageKind = 'payments' | 'credit-activity'

export interface BillingHistoryPagination {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface BillingHistoryPaymentsPage {
  kind: 'payments'
  items: BillingHistoryPaymentItem[]
  pagination: BillingHistoryPagination
}

export interface BillingHistoryCreditActivityPage {
  kind: 'credit-activity'
  items: BillingHistoryActivityItem[]
  pagination: BillingHistoryPagination
}

export type BillingHistoryPageData
  = BillingHistoryPaymentsPage
    | BillingHistoryCreditActivityPage

export type BillingHistorySuccessData
  = BillingHistoryData
    | BillingHistoryPageData

export type BillingHistoryErrorCode
  = EnvelopeErrorCode
    | 'INVALID_HISTORY_QUERY'

export type BillingHistoryResponse
  = ApiResponse<BillingHistorySuccessData, BillingHistoryErrorCode>

