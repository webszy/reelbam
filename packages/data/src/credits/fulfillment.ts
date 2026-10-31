import { eq } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { entitlementGrants, entitlementTransactions } from '../schema/billing.ts'

export interface ImmutableGrantExpectation {
  readonly id: string
  readonly userId: string
  readonly entitlementKey: string
  readonly entitlementType: 'consumable'
  readonly sourceType: 'order'
  readonly sourceId: string
  readonly periodKey: string
  readonly grantedQuantity: number
  readonly remainingQuantity: number
  readonly effectiveAt: Date
  readonly expiresAt: Date
  readonly status: 'active'
}

export interface ImmutableGrantTransactionExpectation {
  readonly id: string
  readonly userId: string
  readonly grantId: string
  readonly transactionType: 'grant'
  readonly quantity: number
  readonly sourceType: 'order'
  readonly sourceId: string
  readonly balanceBefore: 0
  readonly balanceAfter: number
  readonly idempotencyKey: string
}

export type FulfillmentAssessment =
  | { readonly ok: true }
  | {
    readonly ok: false
    readonly errorCode:
      | 'ENTITLEMENT_GRANT_MISSING'
      | 'ENTITLEMENT_GRANT_MISMATCH'
      | 'ENTITLEMENT_TRANSACTION_MISSING'
      | 'ENTITLEMENT_TRANSACTION_MISMATCH'
  }

interface GrantFact {
  readonly id: string
  readonly userId: string
  readonly entitlementKey: string
  readonly entitlementType: string
  readonly sourceType: string
  readonly sourceId: string
  readonly periodKey: string
  readonly grantedQuantity: number | null
  readonly remainingQuantity: number | null
  readonly effectiveAt: Date
  readonly expiresAt: Date | null
  readonly status: string
}

interface TransactionFact {
  readonly id: string
  readonly userId: string
  readonly grantId: string
  readonly transactionType: string
  readonly quantity: number
  readonly sourceType: string
  readonly sourceId: string
  readonly balanceBefore: number
  readonly balanceAfter: number
  readonly idempotencyKey: string
}

/**
 * Legal fulfillment is the immutable grant identity plus the original grant transaction.
 * Remaining and status may change after consume, expiry, refund, or revoke.
 */
export function assessImmutableCreditFulfillment(input: {
  readonly grant: GrantFact | null
  readonly transaction: TransactionFact | null
  readonly expectedGrant: ImmutableGrantExpectation
  readonly expectedTransaction: ImmutableGrantTransactionExpectation
}): FulfillmentAssessment {
  if (!input.grant) return { ok: false, errorCode: 'ENTITLEMENT_GRANT_MISSING' }
  if (!grantIdentityMatches(input.grant, input.expectedGrant)) {
    return { ok: false, errorCode: 'ENTITLEMENT_GRANT_MISMATCH' }
  }
  if (!input.transaction) return { ok: false, errorCode: 'ENTITLEMENT_TRANSACTION_MISSING' }
  if (!transactionIdentityMatches(input.transaction, input.expectedTransaction)) {
    return { ok: false, errorCode: 'ENTITLEMENT_TRANSACTION_MISMATCH' }
  }
  return { ok: true }
}

export function grantStillAtInitialBalance(
  grant: Pick<GrantFact, 'status' | 'remainingQuantity' | 'grantedQuantity'>,
  expected: ImmutableGrantExpectation,
): boolean {
  return grant.status === 'active'
    && grant.grantedQuantity === expected.grantedQuantity
    && grant.remainingQuantity === expected.grantedQuantity
}

/**
 * Insert the original grant and grant transaction only when that repair is still
 * the initial row. A consumed, expired, or revoked grant with a missing original
 * transaction is left untouched.
 */
export async function ensureImmutableOrderCreditGrant(
  database: Database,
  expected: {
    readonly grant: ImmutableGrantExpectation
    readonly transaction: ImmutableGrantTransactionExpectation
  },
): Promise<FulfillmentAssessment> {
  const current = await readFulfillment(database, expected)
  const assessment = assessImmutableCreditFulfillment({
    grant: current.grant,
    transaction: current.transaction,
    expectedGrant: expected.grant,
    expectedTransaction: expected.transaction,
  })
  if (assessment.ok) return assessment
  if (assessment.errorCode === 'ENTITLEMENT_GRANT_MISMATCH' || assessment.errorCode === 'ENTITLEMENT_TRANSACTION_MISMATCH') {
    return assessment
  }
  if (
    assessment.errorCode === 'ENTITLEMENT_TRANSACTION_MISSING'
    && current.grant
    && !grantStillAtInitialBalance(current.grant, expected.grant)
  ) {
    return assessment
  }

  const now = new Date()
  await database.batch([
    database.insert(entitlementGrants).values({
      id: expected.grant.id,
      userId: expected.grant.userId,
      entitlementKey: expected.grant.entitlementKey,
      entitlementType: expected.grant.entitlementType,
      sourceType: expected.grant.sourceType,
      sourceId: expected.grant.sourceId,
      periodKey: expected.grant.periodKey,
      grantedQuantity: expected.grant.grantedQuantity,
      remainingQuantity: expected.grant.remainingQuantity,
      effectiveAt: expected.grant.effectiveAt,
      expiresAt: expected.grant.expiresAt,
      status: expected.grant.status,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing(),
    database.insert(entitlementTransactions).values({
      id: expected.transaction.id,
      userId: expected.transaction.userId,
      grantId: expected.transaction.grantId,
      transactionType: expected.transaction.transactionType,
      quantity: expected.transaction.quantity,
      sourceType: expected.transaction.sourceType,
      sourceId: expected.transaction.sourceId,
      balanceBefore: expected.transaction.balanceBefore,
      balanceAfter: expected.transaction.balanceAfter,
      idempotencyKey: expected.transaction.idempotencyKey,
      createdAt: now,
    }).onConflictDoNothing(),
  ])

  const repaired = await readFulfillment(database, expected)
  return assessImmutableCreditFulfillment({
    grant: repaired.grant,
    transaction: repaired.transaction,
    expectedGrant: expected.grant,
    expectedTransaction: expected.transaction,
  })
}

async function readFulfillment(
  database: Database,
  expected: {
    readonly grant: ImmutableGrantExpectation
    readonly transaction: ImmutableGrantTransactionExpectation
  },
): Promise<{ grant: GrantFact | null, transaction: TransactionFact | null }> {
  const grantRows = await database
    .select()
    .from(entitlementGrants)
    .where(eq(entitlementGrants.id, expected.grant.id))
    .limit(1)
  const transactionRows = await database
    .select()
    .from(entitlementTransactions)
    .where(eq(entitlementTransactions.idempotencyKey, expected.transaction.idempotencyKey))
    .limit(1)
  const grant = grantRows[0]
  const transaction = transactionRows[0]
  return {
    grant: grant
      ? {
          id: grant.id,
          userId: grant.userId,
          entitlementKey: grant.entitlementKey,
          entitlementType: grant.entitlementType,
          sourceType: grant.sourceType,
          sourceId: grant.sourceId,
          periodKey: grant.periodKey,
          grantedQuantity: grant.grantedQuantity,
          remainingQuantity: grant.remainingQuantity,
          effectiveAt: grant.effectiveAt,
          expiresAt: grant.expiresAt,
          status: grant.status,
        }
      : null,
    transaction: transaction
      ? {
          id: transaction.id,
          userId: transaction.userId,
          grantId: transaction.grantId,
          transactionType: transaction.transactionType,
          quantity: transaction.quantity,
          sourceType: transaction.sourceType,
          sourceId: transaction.sourceId,
          balanceBefore: transaction.balanceBefore,
          balanceAfter: transaction.balanceAfter,
          idempotencyKey: transaction.idempotencyKey,
        }
      : null,
  }
}

function grantIdentityMatches(row: GrantFact, expected: ImmutableGrantExpectation): boolean {
  return row.id === expected.id
    && row.userId === expected.userId
    && row.entitlementKey === expected.entitlementKey
    && row.entitlementType === expected.entitlementType
    && row.sourceType === expected.sourceType
    && row.sourceId === expected.sourceId
    && row.periodKey === expected.periodKey
    && row.grantedQuantity === expected.grantedQuantity
    && sameInstant(row.effectiveAt, expected.effectiveAt)
    && sameInstant(row.expiresAt, expected.expiresAt)
}

function transactionIdentityMatches(
  row: TransactionFact,
  expected: ImmutableGrantTransactionExpectation,
): boolean {
  return row.id === expected.id
    && row.userId === expected.userId
    && row.grantId === expected.grantId
    && row.transactionType === expected.transactionType
    && row.quantity === expected.quantity
    && row.sourceType === expected.sourceType
    && row.sourceId === expected.sourceId
    && row.balanceBefore === expected.balanceBefore
    && row.balanceAfter === expected.balanceAfter
    && row.idempotencyKey === expected.idempotencyKey
}

function sameInstant(left: Date | null, right: Date): boolean {
  return left instanceof Date
    && !Number.isNaN(left.getTime())
    && left.getTime() === right.getTime()
}
