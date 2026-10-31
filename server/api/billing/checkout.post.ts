import type { CheckoutResponse } from '../../types/api'
import { runDatabaseOperation } from '../../database/client'
import {
  assertCreemPaymentEnabled,
  parseCheckoutPriceCode,
  parseIdempotencyKey,
} from '../../services/billing-checkout'
import { ensureLocalUser } from '../../services/users'
import { handleCheckoutError } from '../../utils/errors'
import { initiateCheckout } from '../../utils/zBilling/application/create-checkout'

export default defineEventHandler(async (event): Promise<CheckoutResponse> => {
  setResponseHeader(event, 'cache-control', 'no-store')

  try {
    // Server-side guard is authoritative; disabling the button alone is not
    // sufficient because callers can invoke this endpoint directly.
    assertCreemPaymentEnabled(useRuntimeConfig(event).creemPaymentEnabled)

    const localUser = await ensureLocalUser(event)

    const rawKey = getHeader(event, 'idempotency-key')
      ?? getHeader(event, 'Idempotency-Key')
    const idempotencyKey = parseIdempotencyKey(
      typeof rawKey === 'string' ? rawKey : undefined,
    )

    const body = await readBody(event)
    const priceCode = parseCheckoutPriceCode(body)

    const result = await runDatabaseOperation(event, database =>
      initiateCheckout({
        event,
        database,
        localUser,
        priceCode,
        idempotencyKey,
      }),
    )

    return {
      success: true,
      data: {
        checkoutUrl: result.checkoutUrl,
      },
    }
  }
  catch (error) {
    return handleCheckoutError(event, error)
  }
})
