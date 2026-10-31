/**
 * Owner-scoped Billing Account Summary.
 *
 * - Authenticated local user only (Clerk session via ensureLocalUser).
 * - Read-only local grant/order facts: next expiry and latest paid Credit Pack.
 * - Never contacts Creem; never writes billing data; never returns raw
 *   order/provider/customer/snapshot fields.
 */
import { and, desc, eq, gt, isNotNull, lte, inArray } from 'drizzle-orm'
import type { BillingAccountSummaryResponse } from '../../types/api'
import { runDatabaseOperation } from '../../database/client'
import { billingOrders, entitlementGrants } from '../../database/schema'
import { ensureLocalUser } from '../../services/users'
import { AppError, handleApiEnvelopeError } from '../../utils/errors'
import {
  ACCOUNT_SUMMARY_CREDIT_PACK_PRICE_CODES,
  buildAccountSummaryFromLocalRows,
} from '../../utils/zBilling/domain/account-summary'

export default defineEventHandler(
  async (event): Promise<BillingAccountSummaryResponse> => {
    setResponseHeader(event, 'cache-control', 'no-store')

    try {
      const localUser = await ensureLocalUser(event)
      const now = new Date()

      const { grants, orders } = await runDatabaseOperation(event, async (database) => {
        const grantRows = await database
          .select({
            userId: entitlementGrants.userId,
            entitlementKey: entitlementGrants.entitlementKey,
            entitlementType: entitlementGrants.entitlementType,
            status: entitlementGrants.status,
            remainingQuantity: entitlementGrants.remainingQuantity,
            effectiveAt: entitlementGrants.effectiveAt,
            expiresAt: entitlementGrants.expiresAt,
          })
          .from(entitlementGrants)
          .where(
            and(
              eq(entitlementGrants.userId, localUser.id),
              eq(entitlementGrants.entitlementKey, 'credits'),
              eq(entitlementGrants.entitlementType, 'consumable'),
              eq(entitlementGrants.status, 'active'),
              gt(entitlementGrants.remainingQuantity, 0),
              lte(entitlementGrants.effectiveAt, now),
              isNotNull(entitlementGrants.expiresAt),
              gt(entitlementGrants.expiresAt, now),
            ),
          )

        const orderRows = await database
          .select({
            userId: billingOrders.userId,
            status: billingOrders.status,
            amount: billingOrders.amount,
            currency: billingOrders.currency,
            priceCodeSnapshot: billingOrders.priceCodeSnapshot,
            entitlementSnapshot: billingOrders.entitlementSnapshot,
            paidAt: billingOrders.paidAt,
            createdAt: billingOrders.createdAt,
          })
          .from(billingOrders)
          .where(
            and(
              eq(billingOrders.userId, localUser.id),
              eq(billingOrders.status, 'paid'),
              isNotNull(billingOrders.paidAt),
              inArray(billingOrders.priceCodeSnapshot, ACCOUNT_SUMMARY_CREDIT_PACK_PRICE_CODES),
            ),
          )
          .orderBy(desc(billingOrders.paidAt), desc(billingOrders.createdAt))
          .limit(1)

        return {
          grants: grantRows,
          orders: orderRows,
        }
      })

      const summary = buildAccountSummaryFromLocalRows({
        grants,
        orders,
        now,
        ownerUserId: localUser.id,
      })

      if (!summary.ok) {
        throw new AppError('INTERNAL_ERROR')
      }

      return {
        success: true,
        data: summary.data,
      }
    }
    catch (error) {
      return handleApiEnvelopeError(event, error)
    }
  },
)
