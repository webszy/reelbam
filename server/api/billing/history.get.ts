/**
 * Owner-scoped Payment History and Credit Activity.
 *
 * - Authenticated local user only (Clerk session via ensureLocalUser).
 * - No-query preview: two lists, at most five rows each.
 * - Explicit `kind` + `page` mode: one resource, 20 rows, pagination metadata.
 * - Related grant/refund/name rows are loaded only for the selected owner rows.
 * - Never contacts Creem; never writes billing data; never returns raw
 *   order/grant/transaction/provider/customer identifiers.
 */
import { and, count, desc, eq, inArray } from 'drizzle-orm'
import type { BillingHistoryResponse } from '../../types/api'
import { runDatabaseOperation, type Database } from '../../database/client'
import {
  billingOrders,
  billingRefundCreditAdjustments,
  billingRefunds,
  entitlementGrants,
  entitlementTransactions,
} from '../../database/schema'
import { ensureLocalUser } from '../../services/users'
import { AppError, handleApiEnvelopeError } from '../../utils/errors'
import {
  BILLING_HISTORY_LIMIT,
  BILLING_HISTORY_PAGE_SIZE,
  buildBillingHistoryCreditActivityPage,
  buildBillingHistoryFromLocalRows,
  buildBillingHistoryPaymentsPage,
  parseBillingHistoryQuery,
} from '../../utils/zBilling/domain/billing-history'

function sendInvalidHistoryQuery(event: Parameters<typeof getQuery>[0]): BillingHistoryResponse {
  setResponseStatus(event, 400)
  return {
    success: false,
    data: null,
    code: 'INVALID_HISTORY_QUERY',
  }
}

function readCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value
  }
  if (
    typeof value === 'bigint'
    && value >= 0n
    && value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value)
  }
  return null
}

export default defineEventHandler(
  async (event): Promise<BillingHistoryResponse> => {
    setResponseHeader(event, 'cache-control', 'no-store')

    try {
      const parsedQuery = parseBillingHistoryQuery(getQuery(event))
      if (parsedQuery.mode === 'invalid') {
        return sendInvalidHistoryQuery(event)
      }

      const localUser = await ensureLocalUser(event)

      if (parsedQuery.mode === 'page') {
        return await loadHistoryPage(event, localUser.id, parsedQuery.kind, parsedQuery.page)
      }

      return await loadHistoryPreview(event, localUser.id)
    }
    catch (error) {
      return handleApiEnvelopeError(event, error)
    }
  },
)

async function loadHistoryPreview(
  event: Parameters<typeof getQuery>[0],
  ownerUserId: string,
): Promise<BillingHistoryResponse> {
  const { payments, activities, grants, refunds, adjustments } = await runDatabaseOperation(
    event,
    async (database) => {
      const orderRows = await database
        .select({
          id: billingOrders.id,
          userId: billingOrders.userId,
          productName: billingOrders.productNameSnapshot,
          amount: billingOrders.amount,
          currency: billingOrders.currency,
          status: billingOrders.status,
          createdAt: billingOrders.createdAt,
          paidAt: billingOrders.paidAt,
        })
        .from(billingOrders)
        .where(eq(billingOrders.userId, ownerUserId))
        .orderBy(desc(billingOrders.createdAt), desc(billingOrders.id))
        .limit(BILLING_HISTORY_LIMIT)

      const activityRows = await database
        .select({
          id: entitlementTransactions.id,
          userId: entitlementTransactions.userId,
          grantUserId: entitlementGrants.userId,
          transactionType: entitlementTransactions.transactionType,
          quantity: entitlementTransactions.quantity,
          balanceAfter: entitlementTransactions.balanceAfter,
          createdAt: entitlementTransactions.createdAt,
          grantSourceType: entitlementGrants.sourceType,
          grantSourceId: entitlementGrants.sourceId,
          grantExpiresAt: entitlementGrants.expiresAt,
        })
        .from(entitlementTransactions)
        .innerJoin(
          entitlementGrants,
          eq(entitlementTransactions.grantId, entitlementGrants.id),
        )
        .where(
          and(
            eq(entitlementTransactions.userId, ownerUserId),
            eq(entitlementGrants.userId, ownerUserId),
          ),
        )
        .orderBy(desc(entitlementTransactions.createdAt), desc(entitlementTransactions.id))
        .limit(BILLING_HISTORY_LIMIT)

      const related = await loadSelectedPaymentFacts(database, ownerUserId, orderRows)
      const productNameByOrderId = await loadActivityProductNames(
        database,
        ownerUserId,
        activityRows,
      )

      return {
        payments: orderRows,
        activities: activityRows.map(row => ({
          id: row.id,
          userId: row.userId,
          grantUserId: row.grantUserId,
          transactionType: row.transactionType,
          quantity: row.quantity,
          balanceAfter: row.balanceAfter,
          createdAt: row.createdAt,
          grantSourceType: row.grantSourceType,
          grantExpiresAt: row.grantExpiresAt,
          productName: row.grantSourceType === 'order'
            ? productNameByOrderId.get(row.grantSourceId) ?? null
            : null,
        })),
        ...related,
      }
    },
  )

  const history = buildBillingHistoryFromLocalRows({
    payments,
    activities,
    grants,
    refunds,
    adjustments,
    ownerUserId,
  })

  if (!history.ok) {
    throw new AppError('INTERNAL_ERROR')
  }

  return {
    success: true,
    data: history.data,
  }
}

async function loadHistoryPage(
  event: Parameters<typeof getQuery>[0],
  ownerUserId: string,
  kind: 'payments' | 'credit-activity',
  page: number,
): Promise<BillingHistoryResponse> {
  const offset = (page - 1) * BILLING_HISTORY_PAGE_SIZE

  if (kind === 'payments') {
    const { payments, grants, refunds, adjustments, total } = await runDatabaseOperation(
      event,
      async (database) => {
        const [countRow] = await database
          .select({ total: count() })
          .from(billingOrders)
          .where(eq(billingOrders.userId, ownerUserId))

        const totalCount = readCount(countRow?.total)
        if (totalCount === null) {
          throw new AppError('INTERNAL_ERROR')
        }

        const orderRows = await database
          .select({
            id: billingOrders.id,
            userId: billingOrders.userId,
            productName: billingOrders.productNameSnapshot,
            amount: billingOrders.amount,
            currency: billingOrders.currency,
            status: billingOrders.status,
            createdAt: billingOrders.createdAt,
            paidAt: billingOrders.paidAt,
          })
          .from(billingOrders)
          .where(eq(billingOrders.userId, ownerUserId))
          .orderBy(desc(billingOrders.createdAt), desc(billingOrders.id))
          .limit(BILLING_HISTORY_PAGE_SIZE)
          .offset(offset)

        const related = await loadSelectedPaymentFacts(database, ownerUserId, orderRows)
        return {
          payments: orderRows,
          total: totalCount,
          ...related,
        }
      },
    )

    const history = buildBillingHistoryPaymentsPage({
      payments,
      grants,
      refunds,
      adjustments,
      ownerUserId,
      page,
      total,
    })
    if (!history.ok) {
      throw new AppError('INTERNAL_ERROR')
    }
    return {
      success: true,
      data: history.data,
    }
  }

  const { activities, total } = await runDatabaseOperation(
    event,
    async (database) => {
      const ownerActivity = and(
        eq(entitlementTransactions.userId, ownerUserId),
        eq(entitlementGrants.userId, ownerUserId),
      )

      const [countRow] = await database
        .select({ total: count() })
        .from(entitlementTransactions)
        .innerJoin(
          entitlementGrants,
          eq(entitlementTransactions.grantId, entitlementGrants.id),
        )
        .where(ownerActivity)

      const totalCount = readCount(countRow?.total)
      if (totalCount === null) {
        throw new AppError('INTERNAL_ERROR')
      }

      const activityRows = await database
        .select({
          id: entitlementTransactions.id,
          userId: entitlementTransactions.userId,
          grantUserId: entitlementGrants.userId,
          transactionType: entitlementTransactions.transactionType,
          quantity: entitlementTransactions.quantity,
          balanceAfter: entitlementTransactions.balanceAfter,
          createdAt: entitlementTransactions.createdAt,
          grantSourceType: entitlementGrants.sourceType,
          grantSourceId: entitlementGrants.sourceId,
          grantExpiresAt: entitlementGrants.expiresAt,
        })
        .from(entitlementTransactions)
        .innerJoin(
          entitlementGrants,
          eq(entitlementTransactions.grantId, entitlementGrants.id),
        )
        .where(ownerActivity)
        .orderBy(desc(entitlementTransactions.createdAt), desc(entitlementTransactions.id))
        .limit(BILLING_HISTORY_PAGE_SIZE)
        .offset(offset)

      const productNameByOrderId = await loadActivityProductNames(
        database,
        ownerUserId,
        activityRows,
      )

      return {
        total: totalCount,
        activities: activityRows.map(row => ({
          id: row.id,
          userId: row.userId,
          grantUserId: row.grantUserId,
          transactionType: row.transactionType,
          quantity: row.quantity,
          balanceAfter: row.balanceAfter,
          createdAt: row.createdAt,
          grantSourceType: row.grantSourceType,
          grantExpiresAt: row.grantExpiresAt,
          productName: row.grantSourceType === 'order'
            ? productNameByOrderId.get(row.grantSourceId) ?? null
            : null,
        })),
      }
    },
  )

  const history = buildBillingHistoryCreditActivityPage({
    activities,
    ownerUserId,
    page,
    total,
  })
  if (!history.ok) {
    throw new AppError('INTERNAL_ERROR')
  }
  return {
    success: true,
    data: history.data,
  }
}

async function loadSelectedPaymentFacts(
  database: Database,
  ownerUserId: string,
  orderRows: ReadonlyArray<{ id: string }>,
) {
  const selectedOrderIds = orderRows.map(row => row.id)
  const grantRows = selectedOrderIds.length === 0
    ? []
    : await database
      .select({
        userId: entitlementGrants.userId,
        sourceType: entitlementGrants.sourceType,
        sourceId: entitlementGrants.sourceId,
        entitlementKey: entitlementGrants.entitlementKey,
        entitlementType: entitlementGrants.entitlementType,
        grantedQuantity: entitlementGrants.grantedQuantity,
        remainingQuantity: entitlementGrants.remainingQuantity,
        expiresAt: entitlementGrants.expiresAt,
      })
      .from(entitlementGrants)
      .where(
        and(
          eq(entitlementGrants.userId, ownerUserId),
          eq(entitlementGrants.sourceType, 'order'),
          eq(entitlementGrants.entitlementKey, 'credits'),
          eq(entitlementGrants.entitlementType, 'consumable'),
          inArray(entitlementGrants.sourceId, selectedOrderIds),
        ),
      )

  const refundRows = selectedOrderIds.length === 0
    ? []
    : await database
      .select({
        id: billingRefunds.id,
        orderId: billingRefunds.orderId,
        status: billingRefunds.status,
        amount: billingRefunds.amount,
        currency: billingRefunds.currency,
        succeededAt: billingRefunds.succeededAt,
        createdAt: billingRefunds.createdAt,
      })
      .from(billingRefunds)
      .where(
        and(
          eq(billingRefunds.status, 'succeeded'),
          inArray(billingRefunds.orderId, selectedOrderIds),
        ),
      )

  const refundIds = refundRows.map(row => row.id)
  const adjustmentRows = refundIds.length === 0
    ? []
    : await database
      .select({
        refundId: billingRefundCreditAdjustments.refundId,
        appliedQuantity: billingRefundCreditAdjustments.appliedQuantity,
      })
      .from(billingRefundCreditAdjustments)
      .where(inArray(billingRefundCreditAdjustments.refundId, refundIds))

  const orderIdByRefundId = new Map(
    refundRows.map(row => [row.id, row.orderId]),
  )

  return {
    grants: grantRows,
    refunds: refundRows.map(row => ({
      orderId: row.orderId,
      status: row.status,
      amount: row.amount,
      currency: row.currency,
      succeededAt: row.succeededAt,
      createdAt: row.createdAt,
    })),
    adjustments: adjustmentRows.flatMap((row) => {
      const orderId = orderIdByRefundId.get(row.refundId)
      if (!orderId) {
        return []
      }
      return [{
        orderId,
        appliedQuantity: row.appliedQuantity,
      }]
    }),
  }
}

async function loadActivityProductNames(
  database: Database,
  ownerUserId: string,
  activityRows: ReadonlyArray<{
    grantSourceType: string
    grantSourceId: string
  }>,
) {
  const activityOrderIds = [...new Set(
    activityRows
      .filter(row => row.grantSourceType === 'order' && row.grantSourceId.length > 0)
      .map(row => row.grantSourceId),
  )]

  const productNameByOrderId = new Map<string, string>()
  if (activityOrderIds.length === 0) {
    return productNameByOrderId
  }

  const nameRows = await database
    .select({
      id: billingOrders.id,
      productName: billingOrders.productNameSnapshot,
    })
    .from(billingOrders)
    .where(
      and(
        eq(billingOrders.userId, ownerUserId),
        inArray(billingOrders.id, activityOrderIds),
      ),
    )
  for (const row of nameRows) {
    productNameByOrderId.set(row.id, row.productName)
  }
  return productNameByOrderId
}
