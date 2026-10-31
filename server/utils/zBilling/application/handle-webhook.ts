/**
 * Creem-only webhook verification and payload normalization.
 *
 * SaaS Starter persistence, ownership, idempotency, and HTTP responses live in
 * server/api — this module must not import database or Clerk/session code.
 */

export type CreemWebhookVerifyFailureReason
  = | 'invalid_signature'
    | 'malformed_payload'
    | 'incomplete_completed_event'
    | 'incomplete_refund_event'
    | 'incomplete_dispute_event'

/** Paid-order facts extracted from a verified checkout.completed event. */
export interface CreemCheckoutCompletedFacts {
  checkoutId: string
  providerOrderId: string
  orderStatus: string
  amount: number | null
  currency: string | null
  /** Creem request_id — SaaS Starter local order id when checkout was created. */
  requestId: string | null
}

/**
 * Succeeded refund facts for original-order money + proportional credit reversal.
 * providerPaidAmount is the immutable refund-ratio denominator from the provider.
 */
export interface CreemRefundCreatedFacts {
  providerRefundId: string
  status: 'succeeded'
  refundAmount: number
  currency: string
  providerTransactionId: string
  providerOrderId: string
  /** Gross provider-paid amount in the same unit/currency as refundAmount. */
  providerPaidAmount: number
  reasonCode: string | null
}

/** Opened-dispute audit facts (not a final settlement command). */
export interface CreemDisputeCreatedFacts {
  providerDisputeId: string
  providerOrderId: string
  providerTransactionId: string | null
  amount: number | null
  currency: string | null
}

export type NormalizedCreemWebhookEvent
  = | {
    kind: 'checkout.completed'
    providerEventId: string
    eventType: 'checkout.completed'
    payloadHash: string
    checkout: CreemCheckoutCompletedFacts
  }
  | {
    kind: 'refund.created'
    providerEventId: string
    eventType: 'refund.created'
    payloadHash: string
    refund: CreemRefundCreatedFacts
  }
  | {
    kind: 'dispute.created'
    providerEventId: string
    eventType: 'dispute.created'
    payloadHash: string
    dispute: CreemDisputeCreatedFacts
  }
  | {
    kind: 'unsupported'
    providerEventId: string
    eventType: string
    payloadHash: string
  }

export type VerifyCreemWebhookResult
  = | {
    ok: true
    event: NormalizedCreemWebhookEvent
  }
  | {
    ok: false
    reason: CreemWebhookVerifyFailureReason
  }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value > 0
}

function timingSafeEqualHex(expected: string, provided: string): boolean {
  if (expected.length !== provided.length) {
    return false
  }

  let mismatch = 0
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i)
  }
  return mismatch === 0
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * HMAC-SHA256 hex digest of the raw webhook body using the Creem webhook secret.
 * Must be computed against the unchanged raw payload bytes (as text).
 */
export async function computeCreemWebhookSignature(
  rawBody: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(rawBody),
  )
  return bytesToHex(signature)
}

export async function hashWebhookPayload(rawBody: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(rawBody),
  )
  return bytesToHex(digest)
}

function parseIsoCurrency(value: unknown): string | null {
  if (!isNonEmptyString(value)) {
    return null
  }
  const currency = value.trim().toUpperCase()
  return currency.length === 3 ? currency : null
}

function parseOrderId(value: unknown): string | null {
  if (isNonEmptyString(value)) {
    return value.trim()
  }
  if (isRecord(value) && isNonEmptyString(value.id)) {
    return value.id.trim()
  }
  return null
}

/**
 * Extract refund.created facts from a verified payload object.
 * Requires succeeded status, positive amounts, currency, linked order, and
 * provider gross paid amount for the cumulative ratio denominator.
 */
function normalizeRefundCreatedObject(
  object: Record<string, unknown>,
):
  | { ok: true, refund: CreemRefundCreatedFacts }
  | { ok: false } {
  const providerRefundId = isNonEmptyString(object.id) ? object.id.trim() : null
  const statusRaw = isNonEmptyString(object.status)
    ? object.status.trim().toLowerCase()
    : null
  if (!providerRefundId || statusRaw !== 'succeeded') {
    return { ok: false }
  }

  const refundAmount = isPositiveInteger(object.refund_amount)
    ? object.refund_amount
    : isPositiveInteger(object.amount)
      ? object.amount
      : null
  const currency = parseIsoCurrency(object.refund_currency)
    ?? parseIsoCurrency(object.currency)
  if (refundAmount === null || currency === null) {
    return { ok: false }
  }

  const transaction = isRecord(object.transaction) ? object.transaction : null
  const providerTransactionId = transaction && isNonEmptyString(transaction.id)
    ? transaction.id.trim()
    : isNonEmptyString(object.transaction_id)
      ? object.transaction_id.trim()
      : null
  if (!providerTransactionId) {
    return { ok: false }
  }

  const providerOrderId = parseOrderId(object.order)
    ?? parseOrderId(object.order_id)
    ?? (transaction ? parseOrderId(transaction.order) : null)
    ?? (transaction ? parseOrderId(transaction.order_id) : null)
  if (!providerOrderId) {
    return { ok: false }
  }

  // Creem's refund.created payload carries gross payment in transaction.amount_paid.
  // Keep documented/direct paid fields ahead of net transaction.amount fallbacks.
  const providerPaidAmount = transaction && isPositiveInteger(transaction.amount_paid)
    ? transaction.amount_paid
    : isPositiveInteger(object.paid_amount)
      ? object.paid_amount
      : isPositiveInteger(object.transaction_amount)
        ? object.transaction_amount
        : isPositiveInteger(object.order_amount)
          ? object.order_amount
          : transaction && isPositiveInteger(transaction.amount)
            ? transaction.amount
            : null
  if (providerPaidAmount === null) {
    return { ok: false }
  }
  if (refundAmount > providerPaidAmount) {
    return { ok: false }
  }

  const reasonCode = isNonEmptyString(object.reason)
    ? object.reason.trim()
    : isNonEmptyString(object.reason_code)
      ? object.reason_code.trim()
      : null

  return {
    ok: true,
    refund: {
      providerRefundId,
      status: 'succeeded',
      refundAmount,
      currency,
      providerTransactionId,
      providerOrderId,
      providerPaidAmount,
      reasonCode,
    },
  }
}

function normalizeDisputeCreatedObject(
  object: Record<string, unknown>,
):
  | { ok: true, dispute: CreemDisputeCreatedFacts }
  | { ok: false } {
  const providerDisputeId = isNonEmptyString(object.id) ? object.id.trim() : null
  if (!providerDisputeId) {
    return { ok: false }
  }

  const transaction = isRecord(object.transaction) ? object.transaction : null
  const providerTransactionId = transaction && isNonEmptyString(transaction.id)
    ? transaction.id.trim()
    : isNonEmptyString(object.transaction_id)
      ? object.transaction_id.trim()
      : null

  const providerOrderId = parseOrderId(object.order)
    ?? parseOrderId(object.order_id)
    ?? (transaction ? parseOrderId(transaction.order) : null)
    ?? (transaction ? parseOrderId(transaction.order_id) : null)
  if (!providerOrderId) {
    return { ok: false }
  }

  const amount = isPositiveInteger(object.amount) ? object.amount : null
  const currency = parseIsoCurrency(object.currency)

  return {
    ok: true,
    dispute: {
      providerDisputeId,
      providerOrderId,
      providerTransactionId,
      amount,
      currency,
    },
  }
}

/**
 * Verify creem-signature (HMAC-SHA256 hex) and normalize the payload for the
 * SaaS Starter API layer. Rejects invalid signatures before the payload is trusted.
 */
export async function verifyAndNormalizeCreemWebhook(input: {
  rawBody: string
  signatureHeader: string | undefined
  webhookSecret: string
}): Promise<VerifyCreemWebhookResult> {
  const { rawBody, signatureHeader, webhookSecret } = input

  if (
    !isNonEmptyString(webhookSecret)
    || !isNonEmptyString(signatureHeader)
    || typeof rawBody !== 'string'
  ) {
    return { ok: false, reason: 'invalid_signature' }
  }

  const provided = signatureHeader.trim().toLowerCase()
  if (!/^[0-9a-f]+$/.test(provided) || provided.length !== 64) {
    return { ok: false, reason: 'invalid_signature' }
  }

  const expected = await computeCreemWebhookSignature(rawBody, webhookSecret)
  if (!timingSafeEqualHex(expected, provided)) {
    return { ok: false, reason: 'invalid_signature' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody) as unknown
  }
  catch {
    return { ok: false, reason: 'malformed_payload' }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'malformed_payload' }
  }

  const record = parsed as Record<string, unknown>
  const providerEventId = record.id
  const eventType = record.eventType

  if (!isNonEmptyString(providerEventId) || !isNonEmptyString(eventType)) {
    return { ok: false, reason: 'malformed_payload' }
  }

  const payloadHash = await hashWebhookPayload(rawBody)
  const normalizedType = eventType.trim()

  if (normalizedType === 'refund.created') {
    if (!isRecord(record.object)) {
      return { ok: false, reason: 'incomplete_refund_event' }
    }
    const refund = normalizeRefundCreatedObject(record.object)
    if (!refund.ok) {
      return { ok: false, reason: 'incomplete_refund_event' }
    }
    return {
      ok: true,
      event: {
        kind: 'refund.created',
        providerEventId: providerEventId.trim(),
        eventType: 'refund.created',
        payloadHash,
        refund: refund.refund,
      },
    }
  }

  if (normalizedType === 'dispute.created') {
    if (!isRecord(record.object)) {
      return { ok: false, reason: 'incomplete_dispute_event' }
    }
    const dispute = normalizeDisputeCreatedObject(record.object)
    if (!dispute.ok) {
      return { ok: false, reason: 'incomplete_dispute_event' }
    }
    return {
      ok: true,
      event: {
        kind: 'dispute.created',
        providerEventId: providerEventId.trim(),
        eventType: 'dispute.created',
        payloadHash,
        dispute: dispute.dispute,
      },
    }
  }

  if (normalizedType !== 'checkout.completed') {
    return {
      ok: true,
      event: {
        kind: 'unsupported',
        providerEventId: providerEventId.trim(),
        eventType: normalizedType,
        payloadHash,
      },
    }
  }

  const object = record.object
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    return { ok: false, reason: 'incomplete_completed_event' }
  }

  const checkout = object as Record<string, unknown>
  const checkoutId = checkout.id
  if (!isNonEmptyString(checkoutId)) {
    return { ok: false, reason: 'incomplete_completed_event' }
  }

  const order = checkout.order
  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    return { ok: false, reason: 'incomplete_completed_event' }
  }

  const orderRecord = order as Record<string, unknown>
  const providerOrderId = orderRecord.id
  const orderStatus = orderRecord.status

  if (!isNonEmptyString(providerOrderId) || !isNonEmptyString(orderStatus)) {
    return { ok: false, reason: 'incomplete_completed_event' }
  }

  // Documented completed checkout carries a paid order.
  if (orderStatus.trim().toLowerCase() !== 'paid') {
    return { ok: false, reason: 'incomplete_completed_event' }
  }

  const amount = typeof orderRecord.amount === 'number'
    && Number.isFinite(orderRecord.amount)
    && Number.isInteger(orderRecord.amount)
    && orderRecord.amount > 0
    ? orderRecord.amount
    : null

  const currency = isNonEmptyString(orderRecord.currency)
    ? orderRecord.currency.trim().toUpperCase()
    : null

  const requestId = isNonEmptyString(checkout.request_id)
    ? checkout.request_id.trim()
    : null

  return {
    ok: true,
    event: {
      kind: 'checkout.completed',
      providerEventId: providerEventId.trim(),
      eventType: 'checkout.completed',
      payloadHash,
      checkout: {
        checkoutId: checkoutId.trim(),
        providerOrderId: providerOrderId.trim(),
        orderStatus: orderStatus.trim().toLowerCase(),
        amount,
        currency,
        requestId,
      },
    },
  }
}
