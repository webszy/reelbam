import { and, asc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm'
import type { Database } from '../client.ts'
import {
  billingOrders,
  billingRefundCreditAdjustments,
  entitlementGrants,
  entitlementTransactions,
} from '../schema/billing.ts'
import {
  billingRefundCreditSettlements,
  videoAttempts,
  videoCreditOperations,
  videoGenerations,
  videoOutbox,
} from '../schema/video.ts'
import {
  VIDEO_CONSUME_SOURCE_TYPE,
  VIDEO_RETURN_CLAWBACK_SOURCE_TYPE,
  VIDEO_RETURN_FORFEIT_SOURCE_TYPE,
  VIDEO_RETURN_REFUND_SOURCE_TYPE,
  evaluateSharedSettlementGuard,
  evaluateTerminalGuard,
  evaluateZeroConsumeFailure,
  legalTerminalPosting,
  planCreditReturn,
  returnGuardClaim,
  videoConsumeOperationKey,
  videoReturnClawbackTransactionKey,
  videoReturnOperationKey,
  type GuardAdjustmentObservation,
  type GuardStatus,
  type LedgerInstruction,
  type PlannedReturnGrant,
  type PlannedSettlement,
  type ReturnTotals,
  type TerminalOutboxEvent,
} from './contract.ts'
import type { LedgerBatchStatement } from './consume.ts'
import { LedgerAbort, finishLedgerCommit, floorToSqliteMs, sqliteSeconds, videoLedgerRowId } from './runtime.ts'

const CASH_OR_VIDEO_RECLAIM = new Set([
  'refund',
  VIDEO_RETURN_CLAWBACK_SOURCE_TYPE,
  VIDEO_RETURN_FORFEIT_SOURCE_TYPE,
])

export interface ReturnRequest {
  readonly userId: string
  readonly generationId: string
  readonly operationId: string
  readonly event: string
  readonly expectedVersion: number
  readonly leaseOwner: string
  readonly leaseToken: string
  readonly errorCode: string
  readonly nowMs: number
  /** Required for attempt-backed events; queued deadline settlement has no attempt. */
  readonly attemptId?: string
  readonly evidenceId?: string
  readonly providerRequestId?: string
  /** May persist the matching failure observation in this same batch. */
  readonly composeBefore?: readonly LedgerBatchStatement[]
}

export interface ReturnSuccess {
  readonly ok: true
  readonly replay: boolean
  readonly operationId: string
  readonly generationId: string
  readonly userId: string
  readonly intendedQuantity: number
  readonly spendableQuantity: number
  readonly expiredQuantity: number
  readonly clawbackQuantity: number
  readonly forfeitedQuantity: number
}

export type ReturnRefusalReason =
  | 'operation_mismatch'
  | 'generation_not_found'
  | 'generation_owner_mismatch'
  | 'illegal_transition'
  | 'stale_version'
  | 'lease_not_held'
  | 'invalid_attempt_evidence'
  | 'deadline_not_reached'
  | 'missing_consume_operation'
  | 'not_zero_consume'
  | 'consume_ledger_present'
  | 'invalid_quantity'
  | 'invalid_claim'
  | 'duplicate_grant'
  | 'missing_grant'
  | 'return_exceeds_grant'
  | 'invalid_shortfall'
  | 'invalid_grant'
  | 'missing_order_fence'
  | 'missing_grant_fence'
  | 'stale_refund_version'
  | 'stale_grant'
  | 'stale_settled'
  | 'unknown_adjustment'
  | 'adjustment_grant_mismatch'
  | 'settlement_exceeds_shortfall'
  | 'unsupported_source'
  | 'owner_mismatch'
  | 'settlement_missing'
  | 'ledger_mismatch'
  | 'aborted'

export type ReturnResult =
  | ReturnSuccess
  | { readonly ok: false, readonly reason: Exclude<ReturnRefusalReason, 'aborted'> }
  | { readonly ok: false, readonly reason: 'aborted', readonly failure: 'abort_batch' }

export interface PreparedOrderFence {
  readonly orderId: string
  readonly expectedRefundVersion: number
  readonly grants: readonly {
    readonly grantId: string
    readonly clawbackQuantity: number
    readonly observations: readonly GuardAdjustmentObservation[]
  }[]
}

export interface PreparedReturnGrant {
  readonly grantId: string
  readonly expectedRemaining: number
  readonly expectedStatus: GuardStatus
  readonly nextRemaining: number
  readonly nextStatus: GuardStatus
  readonly clawbackQuantity: number
  readonly ledger: readonly LedgerInstruction[]
  readonly settlements: readonly PlannedSettlement[]
}

export interface PreparedReturn {
  readonly userId: string
  readonly generationId: string
  readonly operationId: string
  readonly event: string
  readonly expectedVersion: number
  readonly leaseOwner: string
  readonly leaseToken: string
  readonly errorCode: string
  readonly now: Date
  readonly seconds: number
  readonly zero: boolean
  readonly fromStatus: string
  readonly attemptId: string | null
  readonly evidenceId: string | null
  readonly providerRequestId: string | null
  readonly outboxId: string | null
  readonly outboxEvent: TerminalOutboxEvent | null
  readonly totals: ReturnTotals
  readonly grants: readonly PreparedReturnGrant[]
  readonly fences: readonly PreparedOrderFence[]
}

export type ReturnPlanResult =
  | { readonly ok: true, readonly kind: 'replay', readonly result: ReturnSuccess }
  | { readonly ok: true, readonly kind: 'settle', readonly plan: PreparedReturn }
  | Exclude<ReturnResult, ReturnSuccess>

const ZERO_TOTALS: ReturnTotals = {
  intended: 0,
  spendable: 0,
  expired: 0,
  clawback: 0,
  forfeited: 0,
}

export async function planReturnForFailedGeneration(
  database: Database,
  input: ReturnRequest,
): Promise<ReturnPlanResult> {
  const floored = floorToSqliteMs(input.nowMs)
  if (floored === null || input.errorCode.trim().length === 0) {
    return { ok: false, reason: 'invalid_claim' }
  }
  if (input.operationId !== videoReturnOperationKey(input.generationId)) {
    return { ok: false, reason: 'operation_mismatch' }
  }
  const generation = await readGeneration(database, input.generationId)
  if (!generation) return { ok: false, reason: 'generation_not_found' }
  if (generation.userId !== input.userId) return { ok: false, reason: 'generation_owner_mismatch' }

  const existing = await readReturnOutcome(database, input, true)
  if (existing) return existing.ok
    ? { ok: true, kind: 'replay', result: existing }
    : existing
  if (generation.status === 'failed') return { ok: false, reason: 'settlement_missing' }

  const rule = legalTerminalPosting(generation.status, input.event)
  if (!rule || !rule.creditReturn) return { ok: false, reason: 'illegal_transition' }
  if (rule.attemptLease && (!input.attemptId?.trim() || !input.evidenceId?.trim()
    || ((input.event === 'provider_failed' || input.event === 'storage_irrecoverable') && !input.providerRequestId?.trim()))) {
    return { ok: false, reason: 'invalid_attempt_evidence' }
  }

  const now = new Date(floored)
  const lease = await readLease(database, {
    generationId: input.generationId,
    leaseOwner: input.leaseOwner,
    leaseToken: input.leaseToken,
    now,
    attemptLease: rule.attemptLease,
    attemptId: input.attemptId ?? null,
    outboxEvent: rule.outboxEvent,
  })
  const terminal = evaluateTerminalGuard({
    currentStatus: generation.status,
    currentVersion: generation.statusVersion,
    expectedVersion: input.expectedVersion,
    event: input.event,
    attemptLeaseHeld: lease.attemptHeld,
    outboxLeaseHeld: lease.outboxHeld,
    deadlineAtMs: generation.deadlineAt.getTime(),
    nowMs: floored,
  })
  if (!terminal.ok) return { ok: false, reason: terminal.reason }
  if (!terminal.creditReturn) return { ok: false, reason: 'illegal_transition' }

  const base = {
    userId: input.userId,
    generationId: input.generationId,
    operationId: input.operationId,
    event: input.event,
    expectedVersion: input.expectedVersion,
    leaseOwner: input.leaseOwner,
    leaseToken: input.leaseToken,
    errorCode: input.errorCode,
    now,
    seconds: sqliteSeconds(floored),
    fromStatus: generation.status,
    attemptId: lease.attemptId,
    evidenceId: rule.attemptLease ? input.evidenceId! : null,
    providerRequestId: rule.attemptLease ? input.providerRequestId ?? null : null,
    outboxId: lease.outboxId,
    outboxEvent: rule.outboxEvent,
  }

  if (generation.quotedCredits === 0) {
    const consumeOperation = await readConsumeOperation(database, input.generationId)
    const consumeCount = await countConsumeTransactions(database, input.generationId)
    const zero = evaluateZeroConsumeFailure({
      generationId: input.generationId,
      quotedCredits: 0,
      consumeOperation: consumeOperation
        ? {
            generationId: consumeOperation.generationId,
            operationType: 'consume',
            intendedQuantity: consumeOperation.intendedQuantity,
            spendableQuantity: consumeOperation.spendableQuantity,
            expiredQuantity: consumeOperation.expiredQuantity,
            clawbackQuantity: consumeOperation.clawbackQuantity,
            forfeitedQuantity: consumeOperation.forfeitedQuantity,
          }
        : null,
      consumeLedgerCount: consumeCount,
      terminal: {
        currentStatus: generation.status,
        currentVersion: generation.statusVersion,
        expectedVersion: input.expectedVersion,
        event: input.event,
        attemptLeaseHeld: lease.attemptHeld,
        outboxLeaseHeld: lease.outboxHeld,
        deadlineAtMs: generation.deadlineAt.getTime(),
        nowMs: floored,
      },
    })
    if (!zero.ok) return { ok: false, reason: zero.reason }
    return {
      ok: true,
      kind: 'settle',
      plan: { ...base, zero: true, totals: ZERO_TOTALS, grants: [], fences: [] },
    }
  }

  const consumeOperation = await readConsumeOperation(database, input.generationId)
  if (!consumeOperation) return { ok: false, reason: 'missing_consume_operation' }
  const consumeTransactions = await readConsumeTransactions(database, input.generationId)
  if (consumeTransactions.length === 0) return { ok: false, reason: 'missing_consume_operation' }
  const consumed = consumeTransactions.reduce((sum, transaction) => sum + (-transaction.quantity), 0)
  if (consumed !== consumeOperation.intendedQuantity || consumed !== generation.quotedCredits) {
    return { ok: false, reason: 'ledger_mismatch' }
  }

  const grantIds = consumeTransactions.map(transaction => transaction.grantId)
  const grantRows = await database
    .select()
    .from(entitlementGrants)
    .where(inArray(entitlementGrants.id, grantIds))
  if (grantRows.length !== new Set(grantIds).size) return { ok: false, reason: 'missing_grant' }
  const grantsById = new Map(grantRows.map(grant => [grant.id, grant]))
  for (const grant of grantRows) {
    if (grant.userId !== input.userId) return { ok: false, reason: 'owner_mismatch' }
  }

  const policyRevoked = await readPolicyRevoked(database, grantIds)
  const orderIds = [...new Set(grantRows.filter(grant => grant.sourceType === 'order').map(grant => grant.sourceId))]
  const orderRows = orderIds.length === 0
    ? []
    : await database.select().from(billingOrders).where(inArray(billingOrders.id, orderIds))
  const ordersById = new Map(orderRows.map(order => [order.id, order]))
  for (const orderId of orderIds) {
    if (!ordersById.has(orderId)) return { ok: false, reason: 'missing_order_fence' }
  }

  const adjustmentRows = await database
    .select()
    .from(billingRefundCreditAdjustments)
    .where(inArray(billingRefundCreditAdjustments.grantId, grantIds))
  const settledByAdjustment = await readSettledQuantities(database, adjustmentRows.map(row => row.id))
  const shortfalls = adjustmentRows.map(row => ({
    adjustmentId: row.id,
    grantId: row.grantId,
    shortfall: row.shortfallQuantity,
    settled: settledByAdjustment.get(row.id) ?? 0,
    createdAtMs: row.createdAt.getTime(),
  }))
  const planned = planCreditReturn({
    generationId: input.generationId,
    nowMs: floored,
    consumeLines: consumeTransactions.map(transaction => ({
      grantId: transaction.grantId,
      quantity: -transaction.quantity,
    })),
    grants: consumeTransactions.map(transaction => {
      const grant = grantsById.get(transaction.grantId)!
      return {
        grantId: grant.id,
        remaining: grant.remainingQuantity ?? 0,
        granted: grant.grantedQuantity ?? 0,
        status: grant.status,
        expiresAtMs: grant.expiresAt ? grant.expiresAt.getTime() : null,
        policyRevoked: policyRevoked.has(grant.id),
      }
    }),
    shortfalls,
  })
  if (!planned.ok) return { ok: false, reason: planned.reason }

  for (const grant of planned.grants) {
    const row = grantsById.get(grant.grantId)
    if (!row) return { ok: false, reason: 'missing_grant' }
    if (grant.clawbackQuantity > 0 && row.sourceType !== 'order') {
      return { ok: false, reason: 'invalid_grant' }
    }
  }

  const snapshot = {
    orders: orderIds.map(orderId => ({
      orderId,
      refundVersion: ordersById.get(orderId)!.refundVersion,
    })),
    grants: grantRows.map(grant => ({
      grantId: grant.id,
      userId: grant.userId,
      sourceType: grant.sourceType,
      sourceId: grant.sourceId,
      orderId: grant.sourceType === 'order' ? grant.sourceId : null,
      remaining: grant.remainingQuantity ?? 0,
      status: grant.status,
    })),
    adjustments: shortfalls.map(shortfall => ({
      adjustmentId: shortfall.adjustmentId,
      grantId: shortfall.grantId,
      shortfall: shortfall.shortfall,
      settled: shortfall.settled,
    })),
  }
  const claim = returnGuardClaim({
    snapshot,
    grants: planned.grants.map(grant => ({
      grantId: grant.grantId,
      expectedRemaining: grant.expectedRemaining,
      expectedStatus: grantsById.get(grant.grantId)!.status,
      nextRemaining: grant.nextRemaining,
      nextStatus: grant.nextStatus,
      settlements: grant.settlements,
    })),
  })
  if (!claim.ok) return { ok: false, reason: claim.reason }
  const guard = evaluateSharedSettlementGuard(snapshot, claim.claim)
  if (!guard.ok) return { ok: false, reason: guard.reason }

  const preparedGrants = planned.grants.map(grant => toPreparedGrant(grant, grantsById.get(grant.grantId)!.status))
  return {
    ok: true,
    kind: 'settle',
    plan: {
      ...base,
      zero: false,
      totals: planned.totals,
      grants: preparedGrants,
      fences: buildFences(snapshot, claim.claim.observations, preparedGrants),
    },
  }
}

export async function commitReturnPlan(
  database: Database,
  plan: PreparedReturn,
  extras?: { readonly composeBefore?: readonly LedgerBatchStatement[] },
): Promise<ReturnResult> {
  const request: ReturnRequest = {
    userId: plan.userId,
    generationId: plan.generationId,
    operationId: plan.operationId,
    event: plan.event,
    expectedVersion: plan.expectedVersion,
    leaseOwner: plan.leaseOwner,
    leaseToken: plan.leaseToken,
    errorCode: plan.errorCode,
    nowMs: plan.now.getTime(),
  }
  const existing = await readReturnOutcome(database, request, true)
  if (existing) return existing

  const statements: LedgerBatchStatement[] = [
    ...(extras?.composeBefore ?? []),
    ...plan.fences.map(fence => orderVersionStatement(database, plan, fence)),
    ...plan.grants.map(grant => grantSettlementStatement(database, plan, grant)),
    failureStatusStatement(database, plan),
  ]
  if (plan.outboxEvent && plan.outboxId) {
    statements.push(outboxDeliveredStatement(database, plan))
  }
  let sequence = 1
  for (const grant of plan.grants) {
    for (const instruction of grant.ledger) {
      statements.push(ledgerInsert(database, plan, grant.grantId, instruction, sequence))
      sequence += 1
    }
  }
  statements.push(returnOperationInsert(database, plan))
  for (const grant of plan.grants) {
    for (const settlement of grant.settlements) {
      statements.push(settlementInsert(database, plan, grant.grantId, settlement))
    }
  }
  for (const fence of plan.fences) {
    statements.push(orderCloseCheck(database, plan, fence))
  }
  statements.push(returnCloseCheck(database, plan))

  try {
    return await finishLedgerCommit(
      database,
      plan.operationId,
      statements,
      source => readReturnOutcome(database, request, source === 'reread'),
    )
  }
  catch (error) {
    if (error instanceof LedgerAbort) {
      return { ok: false, reason: 'aborted', failure: 'abort_batch' }
    }
    throw error
  }
}

export async function returnCreditsForFailedGeneration(
  database: Database,
  input: ReturnRequest,
): Promise<ReturnResult> {
  const planned = await planReturnForFailedGeneration(database, input)
  if (!planned.ok) return planned
  if (planned.kind === 'replay') return planned.result
  return commitReturnPlan(database, planned.plan, {
    ...(input.composeBefore ? { composeBefore: input.composeBefore } : {}),
  })
}

function toPreparedGrant(grant: PlannedReturnGrant, expectedStatus: GuardStatus): PreparedReturnGrant {
  return {
    grantId: grant.grantId,
    expectedRemaining: grant.expectedRemaining,
    expectedStatus,
    nextRemaining: grant.nextRemaining,
    nextStatus: grant.nextStatus,
    clawbackQuantity: grant.clawbackQuantity,
    ledger: grant.ledger,
    settlements: grant.settlements,
  }
}

function buildFences(
  snapshot: {
    readonly orders: readonly { readonly orderId: string, readonly refundVersion: number }[]
    readonly grants: readonly { readonly grantId: string, readonly sourceType: string, readonly orderId: string | null }[]
  },
  observations: readonly GuardAdjustmentObservation[],
  grants: readonly PreparedReturnGrant[],
): PreparedOrderFence[] {
  const fences = new Map<string, PreparedOrderFence>()
  for (const grant of grants) {
    const current = snapshot.grants.find(item => item.grantId === grant.grantId)
    if (!current || current.sourceType !== 'order' || !current.orderId) continue
    const order = snapshot.orders.find(item => item.orderId === current.orderId)
    if (!order) continue
    const existing = fences.get(order.orderId)
    const entry = {
      grantId: grant.grantId,
      clawbackQuantity: grant.clawbackQuantity,
      observations: observations.filter(observation => observation.grantId === grant.grantId),
    }
    if (existing) {
      fences.set(order.orderId, { ...existing, grants: [...existing.grants, entry] })
    }
    else {
      fences.set(order.orderId, {
        orderId: order.orderId,
        expectedRefundVersion: order.refundVersion,
        grants: [entry],
      })
    }
  }
  return [...fences.values()].sort((left, right) => compareText(left.orderId, right.orderId))
}

function orderVersionStatement(database: Database, plan: PreparedReturn, fence: PreparedOrderFence) {
  const predicates: SQL[] = [
    sql`${billingOrders.refundVersion} = ${fence.expectedRefundVersion}`,
  ]
  for (const grant of fence.grants) {
    predicates.push(sql`(
      select count(*) from billing_refund_credit_adjustments
      where grant_id = ${grant.grantId}
    ) = ${grant.observations.length}`)
    for (const observation of grant.observations) {
      predicates.push(sql`(
        select shortfall_quantity from billing_refund_credit_adjustments
        where id = ${observation.adjustmentId} and grant_id = ${observation.grantId}
      ) = ${observation.expectedShortfall}`)
      predicates.push(sql`(
        select coalesce(sum(quantity), 0) from billing_refund_credit_settlements
        where adjustment_id = ${observation.adjustmentId}
      ) = ${observation.expectedSettled}`)
      predicates.push(sql`${observation.expectedSettled} + ${observation.claimQuantity} <= ${observation.expectedShortfall}`)
    }
  }
  return database
    .update(billingOrders)
    .set({
      updatedAt: plan.now,
      refundVersion: sql`case when ${sqlAnd(predicates)} then ${fence.expectedRefundVersion + 1} else -1 end`,
    })
    .where(eq(billingOrders.id, fence.orderId))
}

function grantSettlementStatement(database: Database, plan: PreparedReturn, grant: PreparedReturnGrant) {
  return database
    .update(entitlementGrants)
    .set({
      remainingQuantity: sql`case
        when ${entitlementGrants.remainingQuantity} = ${grant.expectedRemaining}
         and ${entitlementGrants.status} = ${grant.expectedStatus}
        then ${grant.nextRemaining}
        else -1
      end`,
      status: sql`case
        when ${entitlementGrants.remainingQuantity} = ${grant.expectedRemaining}
         and ${entitlementGrants.status} = ${grant.expectedStatus}
        then ${grant.nextStatus}
        else ${entitlementGrants.status}
      end`,
      updatedAt: plan.now,
    })
    .where(eq(entitlementGrants.id, grant.grantId))
}

function failureStatusStatement(database: Database, plan: PreparedReturn) {
  const requireZero = plan.zero ? 1 : 0
  return database
    .update(videoGenerations)
    .set({
      status: 'failed',
      errorCode: plan.errorCode,
      errorAt: plan.now,
      terminalAt: plan.now,
      updatedAt: plan.now,
      statusVersion: sql`case
        when ${videoGenerations.userId} = ${plan.userId}
         and ${videoGenerations.status} = ${plan.fromStatus}
         and ${videoGenerations.statusVersion} = ${plan.expectedVersion}
         and (
           (${videoGenerations.status} = 'queued' and ${plan.event} = 'deadline_reached' and ${videoGenerations.deadlineAt} <= ${plan.seconds})
           or (${videoGenerations.status} = 'submitting' and ${plan.event} = 'submission_rejected')
           or (${videoGenerations.status} = 'processing' and ${plan.event} = 'provider_failed')
           or (${videoGenerations.status} = 'storing' and ${plan.event} = 'storage_irrecoverable')
           or (${videoGenerations.status} = 'needs_review' and ${plan.event} = 'recovery_confirmed_absent')
           or (${videoGenerations.status} = 'needs_review' and ${plan.event} = 'provider_failed')
         )
         and (
           ${videoGenerations.status} = 'queued'
           or exists (
             select 1 from video_attempts
             where id = ${plan.attemptId}
               and generation_id = ${videoGenerations.id}
               and lease_owner = ${plan.leaseOwner}
               and lease_token = ${plan.leaseToken}
               and lease_until > ${plan.seconds}
               and settlement_event = ${plan.event}
               and settlement_evidence_id = ${plan.evidenceId}
               and resolved_at is not null and resolved_at <= ${plan.seconds}
               and (
                 (${plan.event} in ('submission_rejected', 'recovery_confirmed_absent')
                   and acceptance_status = 'rejected' and provider_request_id is null)
                 or (${plan.event} in ('provider_failed', 'storage_irrecoverable')
                   and acceptance_status = 'accepted' and provider_request_id = ${plan.providerRequestId})
               )
               and not exists (
                 select 1 from video_attempts newer
                 where newer.generation_id = video_attempts.generation_id
                   and newer.step_id = video_attempts.step_id
                   and newer.attempt_number > video_attempts.attempt_number
               )
           )
         )
         and (
           not (
             (${videoGenerations.status} = 'queued' and ${plan.event} = 'deadline_reached')
             or (${videoGenerations.status} = 'storing' and ${plan.event} = 'storage_irrecoverable')
           )
           or exists (
             select 1 from video_outbox
             where id = ${plan.outboxId}
               and generation_id = ${videoGenerations.id}
               and event_type = case
                 when ${videoGenerations.status} = 'queued' then 'start_submission'
                 else 'store_output'
               end
               and delivery_status = 'leased'
               and lease_owner = ${plan.leaseOwner}
               and lease_token = ${plan.leaseToken}
               and lease_until > ${plan.seconds}
           )
         )
         and (
           ${requireZero} = 0
           or (
             exists (
               select 1 from video_credit_operations
               where generation_id = ${plan.generationId}
                 and operation_type = 'consume'
                 and intended_quantity = 0
                 and spendable_quantity = 0
                 and expired_quantity = 0
                 and clawback_quantity = 0
                 and forfeited_quantity = 0
             )
             and not exists (
               select 1 from entitlement_transactions
               where source_type = ${VIDEO_CONSUME_SOURCE_TYPE}
                 and source_id = ${plan.generationId}
                 and transaction_type = 'consume'
             )
           )
         )
        then ${plan.expectedVersion + 1}
        else -1
      end`,
    })
    .where(eq(videoGenerations.id, plan.generationId))
}

function outboxDeliveredStatement(database: Database, plan: PreparedReturn) {
  return database
    .update(videoOutbox)
    .set({
      deliveryStatus: 'delivered',
      deliveredAt: plan.now,
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
      updatedAt: plan.now,
      deliveryAttemptCount: sql`case
        when ${videoOutbox.generationId} = ${plan.generationId}
         and ${videoOutbox.deliveryStatus} = 'leased'
         and ${videoOutbox.eventType} = ${plan.outboxEvent}
         and ${videoOutbox.leaseOwner} = ${plan.leaseOwner}
         and ${videoOutbox.leaseToken} = ${plan.leaseToken}
         and ${videoOutbox.leaseUntil} > ${plan.seconds}
        then ${videoOutbox.deliveryAttemptCount}
        else -1
      end`,
    })
    .where(eq(videoOutbox.id, plan.outboxId ?? ''))
}

function ledgerInsert(
  database: Database,
  plan: PreparedReturn,
  grantId: string,
  instruction: LedgerInstruction,
  sequence: number,
) {
  return database.insert(entitlementTransactions).values({
    id: videoLedgerRowId(sequence, instruction.idempotencyKey),
    userId: plan.userId,
    grantId,
    transactionType: instruction.transactionType,
    quantity: instruction.quantity,
    sourceType: instruction.sourceType,
    sourceId: instruction.sourceId,
    balanceBefore: instruction.balanceBefore,
    balanceAfter: instruction.balanceAfter,
    idempotencyKey: instruction.idempotencyKey,
    createdAt: plan.now,
  })
}

function returnOperationInsert(database: Database, plan: PreparedReturn) {
  return database.insert(videoCreditOperations).values({
    id: plan.operationId,
    generationId: plan.generationId,
    operationType: 'return',
    idempotencyKey: plan.operationId,
    intendedQuantity: plan.totals.intended,
    spendableQuantity: plan.totals.spendable,
    expiredQuantity: plan.totals.expired,
    clawbackQuantity: plan.totals.clawback,
    forfeitedQuantity: plan.totals.forfeited,
    status: 'completed',
    createdAt: plan.now,
  })
}

function settlementInsert(
  database: Database,
  plan: PreparedReturn,
  grantId: string,
  settlement: PlannedSettlement,
) {
  return database.insert(billingRefundCreditSettlements).values({
    id: `brcs:${settlement.adjustmentId}:${plan.operationId}`,
    adjustmentId: settlement.adjustmentId,
    returnOperationId: plan.operationId,
    grantId,
    quantity: settlement.quantity,
    createdAt: plan.now,
  })
}

function orderCloseCheck(database: Database, plan: PreparedReturn, fence: PreparedOrderFence) {
  const predicates: SQL[] = [
    sql`${billingOrders.refundVersion} = ${fence.expectedRefundVersion + 1}`,
    sql`(
      select clawback_quantity from video_credit_operations
      where id = ${plan.operationId}
        and operation_type = 'return'
        and generation_id = ${plan.generationId}
    ) = (
      select coalesce(sum(quantity), 0) from billing_refund_credit_settlements
      where return_operation_id = ${plan.operationId}
    )`,
  ]
  for (const grant of fence.grants) {
    const clawbackKey = videoReturnClawbackTransactionKey(plan.generationId, grant.grantId)
    predicates.push(sql`(
      select coalesce(sum(quantity), 0) from billing_refund_credit_settlements
      where return_operation_id = ${plan.operationId}
        and grant_id = ${grant.grantId}
    ) = ${grant.clawbackQuantity}`)
    predicates.push(sql`(
      case
        when ${grant.clawbackQuantity} = 0 then not exists (
          select 1 from entitlement_transactions
          where idempotency_key = ${clawbackKey}
        )
        else (
          select -quantity from entitlement_transactions
          where idempotency_key = ${clawbackKey}
            and source_type = ${VIDEO_RETURN_CLAWBACK_SOURCE_TYPE}
            and source_id = ${plan.generationId}
            and grant_id = ${grant.grantId}
            and transaction_type = 'revoke'
        ) = ${grant.clawbackQuantity}
      end
    )`)
  }
  return database
    .update(billingOrders)
    .set({
      refundVersion: sql`case when ${sqlAnd(predicates)} then ${billingOrders.refundVersion} else -1 end`,
    })
    .where(eq(billingOrders.id, fence.orderId))
}

function returnCloseCheck(database: Database, plan: PreparedReturn) {
  const predicates: SQL[] = [
    sql`${videoCreditOperations.operationType} = 'return'`,
    sql`${videoCreditOperations.generationId} = ${plan.generationId}`,
    sql`${videoCreditOperations.intendedQuantity} = ${plan.totals.intended}`,
    sql`${videoCreditOperations.spendableQuantity} = ${plan.totals.spendable}`,
    sql`${videoCreditOperations.expiredQuantity} = ${plan.totals.expired}`,
    sql`${videoCreditOperations.clawbackQuantity} = ${plan.totals.clawback}`,
    sql`${videoCreditOperations.forfeitedQuantity} = ${plan.totals.forfeited}`,
    sql`exists (
      select 1 from video_generations
      where id = ${plan.generationId}
        and user_id = ${plan.userId}
        and status = 'failed'
        and status_version = ${plan.expectedVersion + 1}
        and error_code = ${plan.errorCode}
    )`,
    sql`(
      select coalesce(sum(quantity), 0) from entitlement_transactions
      where source_type = ${VIDEO_RETURN_REFUND_SOURCE_TYPE}
        and source_id = ${plan.generationId}
        and transaction_type = 'refund'
    ) = ${plan.totals.intended}`,
  ]
  for (const grant of plan.grants) {
    predicates.push(sql`(
      select remaining_quantity from entitlement_grants where id = ${grant.grantId}
    ) = ${grant.nextRemaining}`)
    predicates.push(sql`(
      select status from entitlement_grants where id = ${grant.grantId}
    ) = ${grant.nextStatus}`)
  }
  return database
    .update(videoCreditOperations)
    .set({
      intendedQuantity: sql`case when ${sqlAnd(predicates)} then ${videoCreditOperations.intendedQuantity} else -1 end`,
    })
    .where(eq(videoCreditOperations.id, plan.operationId))
}

async function readGeneration(database: Database, generationId: string) {
  const rows = await database
    .select()
    .from(videoGenerations)
    .where(eq(videoGenerations.id, generationId))
    .limit(1)
  return rows[0] ?? null
}

async function readReturnOutcome(
  database: Database,
  input: ReturnRequest,
  replay: boolean,
): Promise<ReturnResult | null> {
  const rows = await database
    .select()
    .from(videoCreditOperations)
    .where(eq(videoCreditOperations.idempotencyKey, videoReturnOperationKey(input.generationId)))
    .limit(1)
  const operation = rows[0]
  if (!operation) return null
  if (operation.operationType !== 'return' || operation.generationId !== input.generationId) {
    return { ok: false, reason: 'operation_mismatch' }
  }
  return {
    ok: true,
    replay,
    operationId: operation.idempotencyKey,
    generationId: operation.generationId,
    userId: input.userId,
    intendedQuantity: operation.intendedQuantity,
    spendableQuantity: operation.spendableQuantity,
    expiredQuantity: operation.expiredQuantity,
    clawbackQuantity: operation.clawbackQuantity,
    forfeitedQuantity: operation.forfeitedQuantity,
  }
}

async function readConsumeOperation(database: Database, generationId: string) {
  const rows = await database
    .select()
    .from(videoCreditOperations)
    .where(eq(videoCreditOperations.idempotencyKey, videoConsumeOperationKey(generationId)))
    .limit(1)
  const operation = rows[0]
  if (!operation || operation.operationType !== 'consume') return null
  return operation
}

async function readConsumeTransactions(database: Database, generationId: string) {
  return database
    .select()
    .from(entitlementTransactions)
    .where(and(
      eq(entitlementTransactions.sourceType, VIDEO_CONSUME_SOURCE_TYPE),
      eq(entitlementTransactions.sourceId, generationId),
      eq(entitlementTransactions.transactionType, 'consume'),
    ))
    .orderBy(asc(entitlementTransactions.createdAt), asc(entitlementTransactions.id))
}

async function countConsumeTransactions(database: Database, generationId: string): Promise<number> {
  const rows = await readConsumeTransactions(database, generationId)
  return rows.length
}

async function readPolicyRevoked(database: Database, grantIds: readonly string[]): Promise<Set<string>> {
  const rows = await database
    .select({
      grantId: entitlementTransactions.grantId,
      sourceType: entitlementTransactions.sourceType,
    })
    .from(entitlementTransactions)
    .where(and(
      inArray(entitlementTransactions.grantId, grantIds),
      eq(entitlementTransactions.transactionType, 'revoke'),
    ))
  const revoked = new Set<string>()
  for (const row of rows) {
    if (!CASH_OR_VIDEO_RECLAIM.has(row.sourceType)) revoked.add(row.grantId)
  }
  return revoked
}

async function readSettledQuantities(database: Database, adjustmentIds: readonly string[]): Promise<Map<string, number>> {
  const settled = new Map<string, number>()
  if (adjustmentIds.length === 0) return settled
  const rows = await database
    .select()
    .from(billingRefundCreditSettlements)
    .where(inArray(billingRefundCreditSettlements.adjustmentId, [...adjustmentIds]))
  for (const row of rows) {
    settled.set(row.adjustmentId, (settled.get(row.adjustmentId) ?? 0) + row.quantity)
  }
  return settled
}

async function readLease(
  database: Database,
  input: {
    readonly generationId: string
    readonly leaseOwner: string
    readonly leaseToken: string
    readonly now: Date
    readonly attemptLease: boolean
    readonly attemptId: string | null
    readonly outboxEvent: TerminalOutboxEvent | null
  },
): Promise<{
  readonly attemptId: string | null
  readonly outboxId: string | null
  readonly attemptHeld: boolean
  readonly outboxHeld: boolean
}> {
  let attemptId: string | null = null
  let attemptHeld = !input.attemptLease
  if (input.attemptLease) {
    const attempts = await database
      .select()
      .from(videoAttempts)
      .where(and(
        eq(videoAttempts.id, input.attemptId ?? ''),
        eq(videoAttempts.generationId, input.generationId),
        eq(videoAttempts.leaseOwner, input.leaseOwner),
        eq(videoAttempts.leaseToken, input.leaseToken),
        gt(videoAttempts.leaseUntil, input.now),
      ))
    attemptHeld = attempts.length === 1
    attemptId = attempts.length === 1 ? attempts[0]!.id : null
  }

  let outboxId: string | null = null
  let outboxHeld = input.outboxEvent === null
  if (input.outboxEvent) {
    const outboxRows = await database
      .select()
      .from(videoOutbox)
      .where(and(
        eq(videoOutbox.generationId, input.generationId),
        eq(videoOutbox.eventType, input.outboxEvent),
        eq(videoOutbox.deliveryStatus, 'leased'),
        eq(videoOutbox.leaseOwner, input.leaseOwner),
        eq(videoOutbox.leaseToken, input.leaseToken),
        gt(videoOutbox.leaseUntil, input.now),
      ))
    outboxHeld = outboxRows.length === 1
    outboxId = outboxRows.length === 1 ? outboxRows[0]!.id : null
  }

  return { attemptId, outboxId, attemptHeld, outboxHeld }
}

function sqlAnd(parts: readonly SQL[]): SQL {
  const first = parts[0]
  if (!first) return sql`1 = 1`
  if (parts.length === 1) return first
  return sql.join([...parts], sql` and `)
}

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
