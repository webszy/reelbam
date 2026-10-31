import { and, asc, eq, sql, type SQL } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { entitlementGrants, entitlementTransactions } from '../schema/billing.ts'
import { videoCreditOperations, videoGenerations } from '../schema/video.ts'
import {
  VIDEO_CONSUME_SOURCE_TYPE,
  evaluateConsumeGuard,
  parseCreditQuoteSnapshot,
  planCreditConsumption,
  videoConsumeOperationKey,
  videoConsumeTransactionKey,
  type CreditQuoteSnapshot,
  type SpendableGrant,
} from './contract.ts'
import { LedgerAbort, finishLedgerCommit, floorToSqliteMs, sqliteSeconds, videoLedgerRowId } from './runtime.ts'
import { listChargeCandidates } from './spendable.ts'

/**
 * Statements are Drizzle query builders passed to `database.batch`.
 * P2.4 puts the generation insert in `composeBefore` and the outbox insert in `composeAfter`.
 * Charging a generation row that was committed earlier is the test path, not the create path.
 */
export type LedgerBatchStatement = unknown

export interface PreparedConsumeLine {
  readonly grantId: string
  readonly expectedRemaining: number
  readonly grantedQuantity: number
  readonly quantity: number
  readonly sourceType: string
  readonly sourceId: string
  readonly balanceBefore: number
  readonly balanceAfter: number
}

export interface PreparedConsume {
  readonly userId: string
  readonly generationId: string
  readonly operationId: string
  readonly amount: number
  readonly now: Date
  readonly seconds: number
  readonly statusVersion: number
  readonly quote: CreditQuoteSnapshot
  readonly lines: readonly PreparedConsumeLine[]
}

export interface ConsumeLineResult {
  readonly grantId: string
  readonly quantity: number
  readonly balanceBefore: number
  readonly balanceAfter: number
}

export interface ConsumeSuccess {
  readonly ok: true
  readonly replay: boolean
  readonly operationId: string
  readonly generationId: string
  readonly userId: string
  readonly intendedQuantity: number
  readonly lines: readonly ConsumeLineResult[]
}

export type ConsumeRefusalReason =
  | 'quote_mismatch'
  | 'operation_mismatch'
  | 'amount_conflict'
  | 'generation_not_found'
  | 'generation_owner_mismatch'
  | 'generation_not_chargeable'
  | 'insufficient_credits'
  | 'unsupported_source'
  | 'invalid_amount'
  | 'invalid_grant'
  | 'invalid_claim'
  | 'missing_grant'
  | 'stale_grant'
  | 'grant_not_active'
  | 'owner_mismatch'
  | 'entitlement_mismatch'
  | 'outside_validity'
  | 'aborted'

export type ConsumeResult =
  | ConsumeSuccess
  | { readonly ok: false, readonly reason: Exclude<ConsumeRefusalReason, 'aborted'> }
  | { readonly ok: false, readonly reason: 'aborted', readonly failure: 'abort_batch' }

export type ConsumePlanResult =
  | { readonly ok: true, readonly kind: 'replay', readonly result: ConsumeSuccess }
  | { readonly ok: true, readonly kind: 'charge', readonly plan: PreparedConsume }
  | Exclude<ConsumeResult, ConsumeSuccess>

export interface ConsumeRequest {
  readonly userId: string
  readonly generationId: string
  readonly creditAmount: number
  readonly operationId: string
  readonly nowMs: number
  readonly composeBefore?: readonly LedgerBatchStatement[]
  readonly composeAfter?: readonly LedgerBatchStatement[]
}

interface GenerationChargeSnapshot {
  readonly userId: string
  readonly status: string
  readonly statusVersion: number
  readonly quotedCredits: number
  readonly quote: CreditQuoteSnapshot
}

export function prepareConsumeCharge(input: {
  readonly userId: string
  readonly generationId: string
  readonly operationId: string
  readonly creditAmount: number
  readonly nowMs: number
  readonly generation: GenerationChargeSnapshot
  readonly grants: readonly SpendableGrant[]
}): { readonly ok: true, readonly plan: PreparedConsume } | Exclude<ConsumeResult, ConsumeSuccess> {
  const floored = floorToSqliteMs(input.nowMs)
  if (floored === null || !Number.isInteger(input.creditAmount) || input.creditAmount < 0) {
    return { ok: false, reason: 'invalid_amount' }
  }
  if (input.operationId !== videoConsumeOperationKey(input.generationId)) {
    return { ok: false, reason: 'operation_mismatch' }
  }
  if (input.generation.userId !== input.userId) {
    return { ok: false, reason: 'generation_owner_mismatch' }
  }
  if (input.generation.quotedCredits !== input.generation.quote.creditAmount
    || input.creditAmount !== input.generation.quote.creditAmount) {
    return { ok: false, reason: 'quote_mismatch' }
  }
  if (input.generation.status !== 'queued') {
    return { ok: false, reason: 'generation_not_chargeable' }
  }

  const planned = planCreditConsumption({
    generationId: input.generationId,
    userId: input.userId,
    amount: input.creditAmount,
    nowMs: floored,
    grants: input.grants,
  })
  if (!planned.ok) return { ok: false, reason: planned.reason }

  if (planned.lines.length > 0) {
    const guard = evaluateConsumeGuard({
      userId: input.userId,
      nowMs: floored,
      lines: planned.lines.map(line => ({
        grantId: line.grantId,
        expectedRemaining: line.expectedRemaining,
        quantity: line.quantity,
      })),
      grants: input.grants.map(grant => ({
        id: grant.id,
        userId: grant.userId,
        entitlementKey: grant.entitlementKey,
        entitlementType: grant.entitlementType,
        sourceType: grant.sourceType,
        sourceId: grant.sourceId,
        granted: grant.granted,
        status: grant.status,
        remaining: grant.remaining,
        effectiveAtMs: grant.effectiveAtMs,
        expiresAtMs: grant.expiresAtMs,
      })),
    })
    if (!guard.ok) return { ok: false, reason: guard.reason }
  }

  const grantsById = new Map(input.grants.map(grant => [grant.id, grant]))
  const lines: PreparedConsumeLine[] = []
  for (const line of planned.lines) {
    const grant = grantsById.get(line.grantId)
    if (!grant || grant.granted === null) return { ok: false, reason: 'invalid_grant' }
    lines.push({
      grantId: line.grantId,
      expectedRemaining: line.expectedRemaining,
      grantedQuantity: grant.granted,
      quantity: line.quantity,
      sourceType: grant.sourceType,
      sourceId: grant.sourceId,
      balanceBefore: line.ledger.balanceBefore,
      balanceAfter: line.ledger.balanceAfter,
    })
  }

  return {
    ok: true,
    plan: {
      userId: input.userId,
      generationId: input.generationId,
      operationId: input.operationId,
      amount: input.creditAmount,
      now: new Date(floored),
      seconds: sqliteSeconds(floored),
      statusVersion: input.generation.statusVersion,
      quote: input.generation.quote,
      lines,
    },
  }
}

export async function planConsumeForGeneration(
  database: Database,
  input: ConsumeRequest,
): Promise<ConsumePlanResult> {
  const floored = floorToSqliteMs(input.nowMs)
  if (floored === null) return { ok: false, reason: 'invalid_amount' }
  if (input.operationId !== videoConsumeOperationKey(input.generationId)) {
    return { ok: false, reason: 'operation_mismatch' }
  }

  const generation = await readGeneration(database, input.generationId)
  if (!generation) return { ok: false, reason: 'generation_not_found' }
  if (generation.userId !== input.userId) return { ok: false, reason: 'generation_owner_mismatch' }

  const existing = await readConsumeOutcome(database, input, true)
  if (existing) {
    if (!existing.ok) return existing
    return { ok: true, kind: 'replay', result: existing }
  }

  const quote = parseCreditQuoteSnapshot(generation.quoteSnapshot)
  if (!quote) return { ok: false, reason: 'quote_mismatch' }
  const grants = await listChargeCandidates(database, input.userId, new Date(floored))
  const prepared = prepareConsumeCharge({
    userId: input.userId,
    generationId: input.generationId,
    operationId: input.operationId,
    creditAmount: input.creditAmount,
    nowMs: floored,
    generation: {
      userId: generation.userId,
      status: generation.status,
      statusVersion: generation.statusVersion,
      quotedCredits: generation.quotedCredits,
      quote,
    },
    grants,
  })
  if (!prepared.ok) return prepared
  return { ok: true, kind: 'charge', plan: prepared.plan }
}

export async function commitConsumePlan(
  database: Database,
  plan: PreparedConsume,
  extras?: {
    readonly composeBefore?: readonly LedgerBatchStatement[]
    readonly composeAfter?: readonly LedgerBatchStatement[]
  },
): Promise<ConsumeResult> {
  const request: ConsumeRequest = {
    userId: plan.userId,
    generationId: plan.generationId,
    creditAmount: plan.amount,
    operationId: plan.operationId,
    nowMs: plan.now.getTime(),
  }
  const existing = await readConsumeOutcome(database, request, true)
  if (existing) return existing

  const statements = [
    ...(extras?.composeBefore ?? []),
    generationFence(database, plan),
    ...plan.lines.map(line => consumeGrantStatement(database, plan, line)),
    ...plan.lines.map((line, index) => consumeTransactionInsert(database, plan, line, index + 1)),
    consumeOperationInsert(database, plan),
    consumeCloseCheck(database, plan),
    ...(extras?.composeAfter ?? []),
  ]
  try {
    return await finishLedgerCommit(
      database,
      plan.operationId,
      statements,
      source => readConsumeOutcome(database, request, source === 'reread'),
    )
  }
  catch (error) {
    if (error instanceof LedgerAbort) {
      return { ok: false, reason: 'aborted', failure: 'abort_batch' }
    }
    throw error
  }
}

export async function consumeCreditsForGeneration(
  database: Database,
  input: ConsumeRequest,
): Promise<ConsumeResult> {
  const planned = await planConsumeForGeneration(database, input)
  if (!planned.ok) return planned
  if (planned.kind === 'replay') return planned.result
  return commitConsumePlan(database, planned.plan, {
    ...(input.composeBefore ? { composeBefore: input.composeBefore } : {}),
    ...(input.composeAfter ? { composeAfter: input.composeAfter } : {}),
  })
}

async function readGeneration(database: Database, generationId: string) {
  const rows = await database
    .select()
    .from(videoGenerations)
    .where(eq(videoGenerations.id, generationId))
    .limit(1)
  return rows[0] ?? null
}

async function readConsumeOutcome(
  database: Database,
  input: ConsumeRequest,
  replay: boolean,
): Promise<ConsumeResult | null> {
  const rows = await database
    .select()
    .from(videoCreditOperations)
    .where(eq(videoCreditOperations.idempotencyKey, videoConsumeOperationKey(input.generationId)))
    .limit(1)
  const operation = rows[0]
  if (!operation) return null
  if (operation.operationType !== 'consume' || operation.generationId !== input.generationId) {
    return { ok: false, reason: 'operation_mismatch' }
  }
  if (operation.intendedQuantity !== input.creditAmount) {
    return { ok: false, reason: 'amount_conflict' }
  }
  const transactions = await database
    .select()
    .from(entitlementTransactions)
    .where(and(
      eq(entitlementTransactions.sourceType, VIDEO_CONSUME_SOURCE_TYPE),
      eq(entitlementTransactions.sourceId, input.generationId),
      eq(entitlementTransactions.transactionType, 'consume'),
    ))
    .orderBy(asc(entitlementTransactions.createdAt), asc(entitlementTransactions.id))
  return {
    ok: true,
    replay,
    operationId: operation.idempotencyKey,
    generationId: operation.generationId,
    userId: input.userId,
    intendedQuantity: operation.intendedQuantity,
    lines: transactions.map(transaction => ({
      grantId: transaction.grantId,
      quantity: -transaction.quantity,
      balanceBefore: transaction.balanceBefore,
      balanceAfter: transaction.balanceAfter,
    })),
  }
}

function generationFence(database: Database, plan: PreparedConsume) {
  return database
    .update(videoGenerations)
    .set({
      updatedAt: plan.now,
      // WHERE is only the primary key. A revoked grant with the same balance still fails here
      // when the generation predicates fail, and a failed grant write fails in its own CASE.
      statusVersion: sql`case
        when ${videoGenerations.userId} = ${plan.userId}
         and ${videoGenerations.status} = 'queued'
         and ${videoGenerations.statusVersion} = ${plan.statusVersion}
         and ${videoGenerations.quotedCredits} = ${plan.amount}
         and json_extract(${videoGenerations.quoteSnapshot}, '$.creditAmount') = ${plan.amount}
         and json_extract(${videoGenerations.quoteSnapshot}, '$.schemaVersion') = ${plan.quote.schemaVersion}
         and json_extract(${videoGenerations.quoteSnapshot}, '$.unit') = ${plan.quote.unit}
         and json_extract(${videoGenerations.quoteSnapshot}, '$.pricingRuleId') = ${plan.quote.pricingRuleId}
         and json_extract(${videoGenerations.quoteSnapshot}, '$.pricingRuleRevision') = ${plan.quote.pricingRuleRevision}
        then ${videoGenerations.statusVersion}
        else -1
      end`,
    })
    .where(eq(videoGenerations.id, plan.generationId))
}

function consumeGrantStatement(database: Database, plan: PreparedConsume, line: PreparedConsumeLine) {
  const nextRemaining = line.expectedRemaining - line.quantity
  return database
    .update(entitlementGrants)
    .set({
      remainingQuantity: sql`case
        when ${entitlementGrants.userId} = ${plan.userId}
         and ${entitlementGrants.entitlementKey} = 'credits'
         and ${entitlementGrants.entitlementType} = 'consumable'
         and ${entitlementGrants.status} = 'active'
         and ${entitlementGrants.remainingQuantity} = ${line.expectedRemaining}
         and ${entitlementGrants.grantedQuantity} = ${line.grantedQuantity}
         and typeof(${entitlementGrants.grantedQuantity}) = 'integer'
         and typeof(${entitlementGrants.remainingQuantity}) = 'integer'
         and ${entitlementGrants.remainingQuantity} <= ${entitlementGrants.grantedQuantity}
         and ${entitlementGrants.effectiveAt} <= ${plan.seconds}
         and (${entitlementGrants.expiresAt} is null or ${entitlementGrants.expiresAt} > ${plan.seconds})
         and ${entitlementGrants.sourceType} = ${line.sourceType}
         and ${entitlementGrants.sourceId} = ${line.sourceId}
         and ${entitlementGrants.sourceType} in ('order', 'subscription_cycle', 'admin', 'migration', 'promotion')
        then ${nextRemaining}
        else -1
      end`,
      updatedAt: plan.now,
    })
    .where(eq(entitlementGrants.id, line.grantId))
}

function consumeTransactionInsert(
  database: Database,
  plan: PreparedConsume,
  line: PreparedConsumeLine,
  sequence: number,
) {
  const idempotencyKey = videoConsumeTransactionKey(plan.generationId, line.grantId)
  return database.insert(entitlementTransactions).values({
    id: videoLedgerRowId(sequence, idempotencyKey),
    userId: plan.userId,
    grantId: line.grantId,
    transactionType: 'consume',
    quantity: -line.quantity,
    sourceType: VIDEO_CONSUME_SOURCE_TYPE,
    sourceId: plan.generationId,
    balanceBefore: line.balanceBefore,
    balanceAfter: line.balanceAfter,
    idempotencyKey,
    createdAt: plan.now,
  })
}

function consumeOperationInsert(database: Database, plan: PreparedConsume) {
  return database.insert(videoCreditOperations).values({
    id: plan.operationId,
    generationId: plan.generationId,
    operationType: 'consume',
    idempotencyKey: plan.operationId,
    intendedQuantity: plan.amount,
    spendableQuantity: plan.amount,
    expiredQuantity: 0,
    clawbackQuantity: 0,
    forfeitedQuantity: 0,
    status: 'completed',
    createdAt: plan.now,
  })
}

function consumeCloseCheck(database: Database, plan: PreparedConsume) {
  const predicates: SQL[] = [
    sql`${videoCreditOperations.operationType} = 'consume'`,
    sql`${videoCreditOperations.generationId} = ${plan.generationId}`,
    sql`${videoCreditOperations.intendedQuantity} = ${plan.amount}`,
    sql`${videoCreditOperations.spendableQuantity} = ${plan.amount}`,
    sql`exists (
      select 1 from video_generations
      where id = ${plan.generationId}
        and user_id = ${plan.userId}
        and status = 'queued'
        and quoted_credits = ${plan.amount}
        and status_version = ${plan.statusVersion}
    )`,
    sql`(
      select coalesce(sum(-quantity), 0)
      from entitlement_transactions
      where source_type = ${VIDEO_CONSUME_SOURCE_TYPE}
        and source_id = ${plan.generationId}
        and transaction_type = 'consume'
    ) = ${plan.amount}`,
    sql`(
      select count(*)
      from entitlement_transactions
      where source_type = ${VIDEO_CONSUME_SOURCE_TYPE}
        and source_id = ${plan.generationId}
        and transaction_type = 'consume'
    ) = ${plan.lines.length}`,
  ]
  for (const line of plan.lines) {
    predicates.push(sql`(
      select remaining_quantity from entitlement_grants where id = ${line.grantId}
    ) = ${line.expectedRemaining - line.quantity}`)
  }
  return database
    .update(videoCreditOperations)
    .set({
      // A grant or generation update that touched zero rows does not raise.
      // This write forces -1 unless the committed rows match the plan.
      intendedQuantity: sql`case when ${sqlAnd(predicates)} then ${videoCreditOperations.intendedQuantity} else -1 end`,
    })
    .where(eq(videoCreditOperations.id, plan.operationId))
}

function sqlAnd(parts: readonly SQL[]): SQL {
  const first = parts[0]
  if (!first) return sql`1 = 1`
  if (parts.length === 1) return first
  return sql.join([...parts], sql` and `)
}
