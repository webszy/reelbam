/**
 * Owner-scoped local order status for the billing return page.
 *
 * - Authenticated local user only (Clerk session via ensureLocalUser).
 * - Returns only local order id + local lifecycle status.
 * - Never contacts Creem; never derives state from URL query values.
 */
import { and, eq } from 'drizzle-orm'
import type { BillingOrderStatusResponse } from '../../../types/api'
import { runDatabaseOperation } from '../../../database/client'
import { billingOrders } from '../../../database/schema'
import { ensureLocalUser } from '../../../services/users'
import {
  handleApiEnvelopeError,
  sendApiEnvelopeError,
} from '../../../utils/errors'

const ORDER_ID_PATTERN
  = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export default defineEventHandler(
  async (event): Promise<BillingOrderStatusResponse> => {
    setResponseHeader(event, 'cache-control', 'no-store')

    try {
      const localUser = await ensureLocalUser(event)
      const orderId = getRouterParam(event, 'id')

      if (
        typeof orderId !== 'string'
        || !ORDER_ID_PATTERN.test(orderId.trim())
      ) {
        // Same surface as non-owner / missing: do not leak existence details.
        setResponseStatus(event, 404)
        return {
          success: false,
          data: null,
          code: 'ORDER_NOT_FOUND',
        }
      }

      const normalizedId = orderId.trim()

      const order = await runDatabaseOperation(event, async (database) => {
        const rows = await database
          .select({
            id: billingOrders.id,
            status: billingOrders.status,
          })
          .from(billingOrders)
          .where(
            and(
              eq(billingOrders.id, normalizedId),
              eq(billingOrders.userId, localUser.id),
            ),
          )
          .limit(1)
        return rows[0] ?? null
      })

      if (!order) {
        setResponseStatus(event, 404)
        return {
          success: false,
          data: null,
          code: 'ORDER_NOT_FOUND',
        }
      }

      return {
        success: true,
        data: {
          orderId: order.id,
          status: order.status,
        },
      }
    }
    catch (error) {
      // Map UNAUTHORIZED / infrastructure through the shared envelope helper.
      // Non-owner and missing orders already returned ORDER_NOT_FOUND above.
      if (
        error
        && typeof error === 'object'
        && 'code' in error
        && (error as { code?: unknown }).code === 'UNAUTHORIZED'
      ) {
        return sendApiEnvelopeError(event, 'UNAUTHORIZED')
      }
      return handleApiEnvelopeError(event, error)
    }
  },
)
