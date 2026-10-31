/**
 * Checkout HTTP input validation.
 *
 * Payment orchestration lives in server/utils/zBilling/application.
 */

import {
  CHECKOUT_ENABLED_PRICE_CODES,
  type CheckoutEnabledPriceCode,
} from '../types/billing'
import { CheckoutError, AppError } from '../utils/errors'

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,128}$/

/** Missing/blank/non-true deployment configuration must fail closed. */
export function assertCreemPaymentEnabled(value: unknown): asserts value is true {
  if (value !== true) {
    throw new AppError('SERVICE_UNAVAILABLE')
  }
}

/**
 * Required Idempotency-Key: 1–128 visible safe ASCII, no whitespace/control.
 */
export function parseIdempotencyKey(raw: string | undefined): string {
  if (typeof raw !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(raw)) {
    throw new CheckoutError('INVALID_IDEMPOTENCY_KEY')
  }
  return raw
}

function isCheckoutEnabledPriceCode(
  value: unknown,
): value is CheckoutEnabledPriceCode {
  return typeof value === 'string'
    && CHECKOUT_ENABLED_PRICE_CODES.some(priceCode => priceCode === value)
}

export function parseCheckoutPriceCode(body: unknown): CheckoutEnabledPriceCode {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('INTERNAL_ERROR')
  }

  const priceCode = (body as { priceCode?: unknown }).priceCode
  if (!isCheckoutEnabledPriceCode(priceCode)) {
    // Unsupported / inactive price — fail closed without creating an order.
    throw new AppError('SERVICE_UNAVAILABLE')
  }

  return priceCode
}
