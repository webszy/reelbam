import { and, asc, eq, gt, inArray, isNull, lte, or, sql, sum } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { entitlementGrants } from '../schema/billing.ts'
import { VIDEO_SPENDABLE_SOURCE_TYPES } from './contract.ts'
import type { SpendableGrant } from './contract.ts'

/**
 * Timing, status, and remaining filters shared with `/api/me`.
 * `expires_at = now` is already unspendable.
 */
export function creditGrantTimingWhere(userId: string, now: Date) {
  return and(
    eq(entitlementGrants.userId, userId),
    eq(entitlementGrants.entitlementKey, 'credits'),
    eq(entitlementGrants.status, 'active'),
    eq(entitlementGrants.entitlementType, 'consumable'),
    gt(entitlementGrants.remainingQuantity, 0),
    lte(entitlementGrants.effectiveAt, now),
    or(isNull(entitlementGrants.expiresAt), gt(entitlementGrants.expiresAt, now)),
  )
}

/** Balance total. Source allow-list matches the grant CHECK, so this equals the timing filter today. */
export function spendableCreditWhere(userId: string, now: Date) {
  return and(
    creditGrantTimingWhere(userId, now),
    inArray(entitlementGrants.sourceType, [...VIDEO_SPENDABLE_SOURCE_TYPES]),
    sql`${entitlementGrants.grantedQuantity} is not null
      and typeof(${entitlementGrants.grantedQuantity}) = 'integer'
      and typeof(${entitlementGrants.remainingQuantity}) = 'integer'
      and ${entitlementGrants.grantedQuantity} >= 0
      and ${entitlementGrants.remainingQuantity} <= ${entitlementGrants.grantedQuantity}`,
  )
}

export async function getAvailableCredits(
  database: Database,
  userId: string,
  now: Date,
): Promise<number> {
  const rows = await database
    .select({ total: sum(entitlementGrants.remainingQuantity) })
    .from(entitlementGrants)
    .where(spendableCreditWhere(userId, now))
  const total = rows[0]?.total
  const parsed = typeof total === 'number' ? total : Number(total ?? 0)
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0
  return parsed
}

/**
 * Rows the charge planner must see. An unknown source is included so the planner
 * returns `unsupported_source` instead of spending the other grants.
 */
export async function listChargeCandidates(
  database: Database,
  userId: string,
  now: Date,
): Promise<SpendableGrant[]> {
  const rows = await database
    .select()
    .from(entitlementGrants)
    .where(creditGrantTimingWhere(userId, now))
    .orderBy(
      sql`${entitlementGrants.expiresAt} is null`,
      asc(entitlementGrants.expiresAt),
      asc(entitlementGrants.createdAt),
      asc(entitlementGrants.id),
    )
  return rows.map(toSpendableGrant)
}

function toSpendableGrant(row: typeof entitlementGrants.$inferSelect): SpendableGrant {
  return {
    id: row.id,
    userId: row.userId,
    entitlementKey: 'credits',
    entitlementType: 'consumable',
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    granted: row.grantedQuantity,
    remaining: row.remainingQuantity ?? 0,
    status: 'active',
    effectiveAtMs: row.effectiveAt.getTime(),
    expiresAtMs: row.expiresAt ? row.expiresAt.getTime() : null,
    createdAtMs: row.createdAt.getTime(),
  }
}
