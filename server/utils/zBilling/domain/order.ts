import type { billingOrders } from '../../../database/schema'
import type {
  BillingOrderStatus,
  BillingPriceCode,
} from '../../../types/billing'
import { CheckoutError } from '../../errors'

export type BillingOrderRow = typeof billingOrders.$inferSelect

/** Paid-order facts needed for local order matching (provider-agnostic shape). */
export interface CheckoutCompletedMatchFacts {
  checkoutId: string
  providerOrderId: string
  orderStatus: string
  amount: number | null
  currency: string | null
  requestId: string | null
}

/**
 * Pure match rules for applying a verified checkout.completed event to a
 * local order row. Database I/O stays in the webhook API route.
 */
export function evaluateCheckoutCompletedAgainstOrder(input: {
  order: {
    id: string
    status: BillingOrderStatus
    amount: number
    currency: string
    providerOrderId: string | null
  }
  checkout: CheckoutCompletedMatchFacts
}): { ok: true } | { ok: false, errorCode: string } {
  const { order, checkout } = input

  if (checkout.requestId && checkout.requestId !== order.id) {
    return { ok: false, errorCode: 'ORDER_REQUEST_ID_MISMATCH' }
  }

  if (checkout.amount !== null && checkout.amount !== order.amount) {
    return { ok: false, errorCode: 'ORDER_AMOUNT_MISMATCH' }
  }

  if (
    checkout.currency !== null
    && checkout.currency !== order.currency.toUpperCase()
  ) {
    return { ok: false, errorCode: 'ORDER_CURRENCY_MISMATCH' }
  }

  if (
    order.status === 'paid'
    && order.providerOrderId === checkout.providerOrderId
  ) {
    return { ok: true }
  }

  // Matching refunded / partially_refunded order: late completion is a no-op
  // match at the pure layer; the route must not regrant or reset status.
  if (
    (order.status === 'refunded' || order.status === 'partially_refunded')
    && order.providerOrderId === checkout.providerOrderId
  ) {
    return { ok: true }
  }

  if (
    (order.status === 'paid'
      || order.status === 'refunded'
      || order.status === 'partially_refunded')
    && order.providerOrderId
    && order.providerOrderId !== checkout.providerOrderId
  ) {
    return { ok: false, errorCode: 'ORDER_ALREADY_TERMINAL' }
  }

  if (order.status !== 'pending' && order.status !== 'paid') {
    return { ok: false, errorCode: 'ORDER_STATUS_NOT_APPLICABLE' }
  }

  return { ok: true }
}

export function resolveExistingCheckoutOrder(
  order: BillingOrderRow,
  priceCode: BillingPriceCode,
): { checkoutUrl: string } {
  if (order.priceCodeSnapshot !== priceCode) {
    throw new CheckoutError('IDEMPOTENCY_KEY_REUSED')
  }

  if (
    typeof order.providerCheckoutUrl === 'string'
    && order.providerCheckoutUrl.trim().length > 0
  ) {
    return { checkoutUrl: order.providerCheckoutUrl }
  }

  if (order.status === 'failed') {
    throw new CheckoutError('CHECKOUT_FAILED')
  }

  if (order.failureCode === 'CHECKOUT_CREATION_UNKNOWN') {
    throw new CheckoutError('CHECKOUT_CREATION_UNKNOWN')
  }

  // Pending without URL and without terminal/unknown code → in progress.
  throw new CheckoutError('CHECKOUT_IN_PROGRESS')
}

export function isUniqueConstraintError(error: unknown): boolean {
  const messages: string[] = []
  let current: unknown = error
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (current instanceof Error) {
      messages.push(current.message)
      current = current.cause
      continue
    }
    if (typeof current === 'object' && current !== null && 'message' in current) {
      const message = (current as { message?: unknown }).message
      if (typeof message === 'string') {
        messages.push(message)
      }
    }
    break
  }

  const joined = messages.join(' ').toLowerCase()
  return (
    joined.includes('unique')
    || joined.includes('constraint failed')
    || joined.includes('billing_orders_user_checkout_idempotency_key_unique')
  )
}
