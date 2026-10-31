import { asc, eq } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { entitlementGrants, entitlementTransactions } from '../schema/billing.ts'

export type GrantReconciliation =
  | {
    readonly ok: true
    readonly grantId: string
    readonly remainingQuantity: number
    readonly rebuiltQuantity: number
    readonly transactionCount: number
  }
  | {
    readonly ok: false
    readonly grantId: string
    readonly reason: 'grant_not_found' | 'invalid_grant' | 'missing_initial_grant' | 'broken_chain' | 'balance_mismatch' | 'non_integer_balance'
    readonly remainingQuantity: number | null
    readonly rebuiltQuantity: number | null
  }

/** One read batch observes the grant and its complete ledger at the same database boundary. */
export async function reconcileGrantLedger(database: Database, grantId: string): Promise<GrantReconciliation> {
  const [grantRows, transactions] = await database.batch([
    database.select().from(entitlementGrants).where(eq(entitlementGrants.id, grantId)).limit(1),
    database.select().from(entitlementTransactions)
      .where(eq(entitlementTransactions.grantId, grantId))
      .orderBy(asc(entitlementTransactions.ledgerSequence)),
  ])
  const grant = grantRows[0]
  const fail = (reason: Extract<GrantReconciliation, { ok: false }>['reason'], rebuilt: number | null): GrantReconciliation => ({
    ok: false,
    grantId,
    reason,
    remainingQuantity: grant?.remainingQuantity ?? null,
    rebuiltQuantity: rebuilt,
  })
  if (!grant) return fail('grant_not_found', null)
  if (grant.entitlementKey !== 'credits' || grant.entitlementType !== 'consumable'
    || grant.grantedQuantity === null || !Number.isSafeInteger(grant.grantedQuantity)
    || grant.grantedQuantity < 0 || grant.remainingQuantity === null
    || !Number.isSafeInteger(grant.remainingQuantity) || grant.remainingQuantity < 0
    || grant.remainingQuantity > grant.grantedQuantity) {
    return fail('invalid_grant', null)
  }

  const initial = transactions[0]
  if (!initial || initial.ledgerSequence !== 1 || initial.transactionType !== 'grant'
    || initial.userId !== grant.userId || initial.sourceType !== grant.sourceType
    || initial.sourceId !== grant.sourceId || initial.quantity !== grant.grantedQuantity
    || initial.balanceBefore !== 0 || initial.balanceAfter !== grant.grantedQuantity) {
    return fail('missing_initial_grant', null)
  }

  let rebuilt = 0
  for (const [index, transaction] of transactions.entries()) {
    if (!Number.isSafeInteger(transaction.quantity) || !Number.isSafeInteger(transaction.balanceBefore)
      || !Number.isSafeInteger(transaction.balanceAfter)) return fail('non_integer_balance', rebuilt)
    if (transaction.ledgerSequence !== index + 1 || transaction.userId !== grant.userId
      || transaction.balanceBefore !== rebuilt || (index > 0 && transaction.transactionType === 'grant')) {
      return fail('broken_chain', rebuilt)
    }
    rebuilt += transaction.quantity
    if (!Number.isSafeInteger(rebuilt)) return fail('non_integer_balance', null)
    if (rebuilt < 0 || rebuilt > grant.grantedQuantity || rebuilt !== transaction.balanceAfter) {
      return fail('broken_chain', rebuilt)
    }
  }
  if (rebuilt !== grant.remainingQuantity) return fail('balance_mismatch', rebuilt)
  return {
    ok: true,
    grantId,
    remainingQuantity: grant.remainingQuantity,
    rebuiltQuantity: rebuilt,
    transactionCount: transactions.length,
  }
}
