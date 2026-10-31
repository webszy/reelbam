import { createHash } from 'node:crypto'
import type { GenerationInput } from '@reelbam/video-contracts'
import type { InternalGenerationStatus } from '@reelbam/video-contracts/internal'

/**
 * Pure credit settlement contract for the future writer.
 * These functions do not read or write D1. A conflict result is always
 * `abort_batch`: the writer must fail the whole batch and re-read. A predicate
 * that updates zero rows and then continues is not an implementation of this
 * contract.
 */

export const VIDEO_CONSUME_SOURCE_TYPE = 'video_generation'
export const VIDEO_RETURN_REFUND_SOURCE_TYPE = 'video_generation_return'
export const VIDEO_RETURN_EXPIRE_SOURCE_TYPE = 'video_generation_return_expiry'
export const VIDEO_RETURN_CLAWBACK_SOURCE_TYPE = 'video_generation_return_clawback'
export const VIDEO_RETURN_FORFEIT_SOURCE_TYPE = 'video_generation_return_forfeit'

export interface CreditQuoteSnapshot {
  readonly schemaVersion: 1
  readonly creditAmount: number
  readonly pricingRuleId: string
  readonly pricingRuleRevision: number
  readonly unit: 'credit'
}

/** Sources the video balance read and the charge may use. Same set as the grant CHECK. */
export const VIDEO_SPENDABLE_SOURCE_TYPES = [
  'order',
  'subscription_cycle',
  'admin',
  'migration',
  'promotion',
] as const

export type VideoSpendableSourceType = (typeof VIDEO_SPENDABLE_SOURCE_TYPES)[number]

export function isVideoSpendableSource(sourceType: string): sourceType is VideoSpendableSourceType {
  return (VIDEO_SPENDABLE_SOURCE_TYPES as readonly string[]).includes(sourceType)
}

/**
 * A consumed grant is always returned on that same grant.
 * Narrowing the allow-list later must not strand an already charged source.
 */
export function returnSourceAllowed(sourceType: string, alreadyConsumed: boolean): boolean {
  if (isVideoSpendableSource(sourceType)) return true
  return alreadyConsumed && sourceType.length > 0
}

export interface SpendableGrant {
  readonly id: string
  readonly userId: string
  readonly entitlementKey: 'credits'
  readonly entitlementType: 'consumable'
  readonly sourceType: string
  readonly sourceId: string
  readonly granted: number | null
  readonly remaining: number
  readonly status: 'active' | 'expired' | 'revoked'
  readonly effectiveAtMs: number
  readonly expiresAtMs: number | null
  readonly createdAtMs: number
}

export interface LedgerInstruction {
  readonly transactionType: 'consume' | 'refund' | 'expire' | 'revoke'
  readonly quantity: number
  readonly sourceType: string
  readonly sourceId: string
  readonly idempotencyKey: string
  readonly balanceBefore: number
  readonly balanceAfter: number
}

export interface PlannedConsumeLine {
  readonly grantId: string
  readonly expectedRemaining: number
  readonly quantity: number
  readonly ledger: LedgerInstruction
}

export type PlannedConsume =
  | { readonly ok: true, readonly lines: readonly PlannedConsumeLine[] }
  | { readonly ok: false, readonly reason: 'invalid_amount' | 'insufficient_credits' | 'invalid_grant' | 'unsupported_source' }

export interface ConsumeLine {
  readonly grantId: string
  readonly quantity: number
}

export interface GrantSettlementState {
  readonly grantId: string
  readonly remaining: number
  readonly granted: number
  readonly status: 'active' | 'expired' | 'revoked'
  readonly expiresAtMs: number | null
  readonly policyRevoked: boolean
}

export interface ShortfallBalance {
  readonly adjustmentId: string
  readonly grantId: string
  readonly shortfall: number
  readonly settled: number
  readonly createdAtMs: number
}

export interface PlannedSettlement {
  readonly adjustmentId: string
  readonly quantity: number
}

export interface PlannedReturnGrant {
  readonly grantId: string
  readonly expectedRemaining: number
  readonly refundQuantity: number
  readonly spendableQuantity: number
  readonly expiredQuantity: number
  readonly clawbackQuantity: number
  readonly forfeitedQuantity: number
  readonly sweepQuantity: number
  readonly nextRemaining: number
  readonly nextStatus: 'active' | 'expired' | 'revoked'
  readonly settlements: readonly PlannedSettlement[]
  readonly ledger: readonly LedgerInstruction[]
}

export interface ReturnTotals {
  readonly intended: number
  readonly spendable: number
  readonly expired: number
  readonly clawback: number
  readonly forfeited: number
}

export type PlannedReturn =
  | { readonly ok: true, readonly grants: readonly PlannedReturnGrant[], readonly totals: ReturnTotals }
  | {
    readonly ok: false
    readonly reason:
      | 'invalid_quantity'
      | 'duplicate_grant'
      | 'missing_grant'
      | 'return_exceeds_grant'
      | 'invalid_shortfall'
  }

const QUOTE_KEYS = ['schemaVersion', 'creditAmount', 'pricingRuleId', 'pricingRuleRevision', 'unit'] as const

export function videoConsumeOperationKey(generationId: string): string {
  return `video_credit:consume:${generationId}`
}

export function videoReturnOperationKey(generationId: string): string {
  return `video_credit:return:${generationId}`
}

export function videoConsumeTransactionKey(generationId: string, grantId: string): string {
  return `entitlement:video_generation:${generationId}:grant:${grantId}:consume`
}

export function videoReturnRefundTransactionKey(generationId: string, grantId: string): string {
  return `entitlement:video_generation:${generationId}:grant:${grantId}:refund`
}

export function videoReturnExpireTransactionKey(generationId: string, grantId: string): string {
  return `entitlement:video_generation:${generationId}:grant:${grantId}:expire`
}

export function videoReturnClawbackTransactionKey(generationId: string, grantId: string): string {
  return `entitlement:video_generation:${generationId}:grant:${grantId}:clawback`
}

export function videoReturnForfeitTransactionKey(generationId: string, grantId: string): string {
  return `entitlement:video_generation:${generationId}:grant:${grantId}:forfeit`
}

export function failureSettlementAllowed(status: InternalGenerationStatus): boolean {
  return status === 'failed'
}

export function parseCreditQuoteSnapshot(value: unknown): CreditQuoteSnapshot | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== QUOTE_KEYS.length || QUOTE_KEYS.some(key => !Object.hasOwn(record, key))) return null
  const { schemaVersion, creditAmount, pricingRuleId, pricingRuleRevision, unit } = record
  if (schemaVersion !== 1 || unit !== 'credit') return null
  if (!isNonNegativeInteger(creditAmount)) return null
  if (typeof pricingRuleId !== 'string' || pricingRuleId.trim() === '') return null
  if (!isPositiveInteger(pricingRuleRevision)) return null
  return {
    schemaVersion: 1,
    creditAmount,
    pricingRuleId,
    pricingRuleRevision,
    unit: 'credit',
  }
}

export function canonicalizeGenerationInput(input: GenerationInput): string {
  const parameters: Record<string, string | number | boolean> = {
    durationSeconds: input.parameters.durationSeconds,
    resolution: input.parameters.resolution,
  }
  if (input.parameters.aspectRatio !== undefined) parameters.aspectRatio = input.parameters.aspectRatio
  if (input.parameters.seed !== undefined) parameters.seed = input.parameters.seed
  if (input.parameters.generateAudio !== undefined) parameters.generateAudio = input.parameters.generateAudio

  const body: Record<string, unknown> = {
    modelId: input.modelId,
    mode: input.mode,
    parameters,
  }
  if (input.mode === 'text-to-video') {
    body.prompt = input.prompt
  }
  else if (input.mode === 'image-to-video') {
    body.imageAssetId = input.imageAssetId
    if (input.prompt !== undefined) body.prompt = input.prompt
  }
  else {
    body.imageAssetId = input.imageAssetId
    body.referenceVideoAssetId = input.referenceVideoAssetId
    if (input.prompt !== undefined) body.prompt = input.prompt
  }
  return JSON.stringify(body)
}

export function hashCanonicalInput(input: GenerationInput): string {
  return createHash('sha256').update(canonicalizeGenerationInput(input)).digest('hex')
}

export function planCreditConsumption(input: {
  readonly generationId: string
  readonly userId: string
  readonly amount: number
  readonly nowMs: number
  readonly grants: readonly SpendableGrant[]
}): PlannedConsume {
  if (!isNonNegativeInteger(input.amount) || !Number.isInteger(input.nowMs)) {
    return { ok: false, reason: 'invalid_amount' }
  }
  if (input.userId.length === 0 || hasDuplicate(input.grants.map(grant => grant.id))) {
    return { ok: false, reason: 'invalid_grant' }
  }
  for (const grant of input.grants) {
    if (!isGrantSnapshotValid(grant) || grant.userId !== input.userId) {
      return { ok: false, reason: 'invalid_grant' }
    }
    if (!isVideoSpendableSource(grant.sourceType) || grant.sourceId.length === 0) {
      return { ok: false, reason: 'unsupported_source' }
    }
  }
  if (input.amount === 0) return { ok: true, lines: [] }

  const eligible = input.grants.filter(grant => isSpendable(grant, input.nowMs))
  eligible.sort(compareGrantConsumptionOrder)
  const available = eligible.reduce((sum, grant) => sum + grant.remaining, 0)
  if (available < input.amount) return { ok: false, reason: 'insufficient_credits' }

  let left = input.amount
  const lines: PlannedConsumeLine[] = []
  for (const grant of eligible) {
    if (left === 0) break
    const quantity = Math.min(grant.remaining, left)
    const balanceAfter = grant.remaining - quantity
    lines.push({
      grantId: grant.id,
      expectedRemaining: grant.remaining,
      quantity,
      ledger: {
        transactionType: 'consume',
        quantity: -quantity,
        sourceType: VIDEO_CONSUME_SOURCE_TYPE,
        sourceId: input.generationId,
        idempotencyKey: videoConsumeTransactionKey(input.generationId, grant.id),
        balanceBefore: grant.remaining,
        balanceAfter,
      },
    })
    left -= quantity
  }
  return { ok: true, lines }
}

export interface ConsumeGrantRow {
  readonly id: string
  readonly userId: string
  readonly entitlementKey: string
  readonly entitlementType: string
  readonly sourceType: string
  readonly sourceId: string
  readonly granted: number | null
  readonly status: 'active' | 'expired' | 'revoked'
  readonly remaining: number
  readonly effectiveAtMs: number
  readonly expiresAtMs: number | null
}

export type ConsumeGuardAbortReason =
  | 'invalid_claim'
  | 'missing_grant'
  | 'stale_grant'
  | 'grant_not_active'
  | 'owner_mismatch'
  | 'entitlement_mismatch'
  | 'outside_validity'
  | 'unsupported_source'

/**
 * Commit-time check for a positive consumption. Empty lines are not a zero-quote
 * authorization. Status, owner, entitlement, validity, and source are inside the
 * same failing decision as remaining: revoked with an unchanged balance aborts.
 */
export function evaluateConsumeGuard(input: {
  readonly userId: string
  readonly nowMs: number
  readonly lines: readonly { readonly grantId: string, readonly expectedRemaining: number, readonly quantity: number }[]
  readonly grants: readonly ConsumeGrantRow[]
}): { readonly ok: true }
  | { readonly ok: false, readonly failure: GuardConflictFailure, readonly reason: ConsumeGuardAbortReason } {
  if (input.userId.length === 0 || !Number.isInteger(input.nowMs) || input.lines.length === 0) {
    return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'invalid_claim' }
  }
  if (hasDuplicate(input.lines.map(line => line.grantId)) || hasDuplicate(input.grants.map(grant => grant.id))) {
    return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'invalid_claim' }
  }
  const grants = new Map(input.grants.map(grant => [grant.id, grant]))
  for (const line of [...input.lines].sort((left, right) => compareText(left.grantId, right.grantId))) {
    if (!isPositiveInteger(line.quantity) || !isNonNegativeInteger(line.expectedRemaining) || line.quantity > line.expectedRemaining) {
      return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'invalid_claim' }
    }
    const grant = grants.get(line.grantId)
    if (!grant) return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'missing_grant' }
    if (grant.userId !== input.userId) return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'owner_mismatch' }
    if (grant.entitlementKey !== 'credits' || grant.entitlementType !== 'consumable') {
      return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'entitlement_mismatch' }
    }
    if (!isVideoSpendableSource(grant.sourceType) || grant.sourceId.length === 0) {
      return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'unsupported_source' }
    }
    if (grant.status !== 'active') return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'grant_not_active' }
    if (grant.effectiveAtMs > input.nowMs || (grant.expiresAtMs !== null && grant.expiresAtMs <= input.nowMs)) {
      return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'outside_validity' }
    }
    if (grant.remaining !== line.expectedRemaining) {
      return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'stale_grant' }
    }
    if (!Number.isSafeInteger(grant.granted) || grant.granted === null
      || grant.granted < 0 || grant.remaining > grant.granted) {
      return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'invalid_claim' }
    }
  }
  return { ok: true }
}

export function planCreditReturn(input: {
  readonly generationId: string
  readonly nowMs: number
  readonly consumeLines: readonly ConsumeLine[]
  readonly grants: readonly GrantSettlementState[]
  readonly shortfalls: readonly ShortfallBalance[]
}): PlannedReturn {
  if (!Number.isInteger(input.nowMs)) return { ok: false, reason: 'invalid_quantity' }
  if (hasDuplicate(input.consumeLines.map(line => line.grantId))) {
    return { ok: false, reason: 'duplicate_grant' }
  }
  const grants = new Map(input.grants.map(grant => [grant.grantId, grant]))
  if (grants.size !== input.grants.length) return { ok: false, reason: 'duplicate_grant' }

  const shortfallsByGrant = new Map<string, ShortfallBalance[]>()
  for (const shortfall of input.shortfalls) {
    if (!isNonNegativeInteger(shortfall.shortfall) || !isNonNegativeInteger(shortfall.settled)) {
      return { ok: false, reason: 'invalid_shortfall' }
    }
    if (shortfall.settled > shortfall.shortfall) return { ok: false, reason: 'invalid_shortfall' }
    const list = shortfallsByGrant.get(shortfall.grantId) ?? []
    list.push(shortfall)
    shortfallsByGrant.set(shortfall.grantId, list)
  }

  const planned: PlannedReturnGrant[] = []
  for (const line of input.consumeLines) {
    if (!isPositiveInteger(line.quantity)) return { ok: false, reason: 'invalid_quantity' }
    const grant = grants.get(line.grantId)
    if (!grant) return { ok: false, reason: 'missing_grant' }
    if (!isGrantStateValid(grant)) return { ok: false, reason: 'invalid_quantity' }
    if (grant.remaining + line.quantity > grant.granted) {
      return { ok: false, reason: 'return_exceeds_grant' }
    }
    planned.push(planGrantReturn({
      generationId: input.generationId,
      nowMs: input.nowMs,
      quantity: line.quantity,
      grant,
      shortfalls: shortfallsByGrant.get(grant.grantId) ?? [],
    }))
  }

  const totals = planned.reduce<ReturnTotals>((sum, grant) => ({
    intended: sum.intended + grant.refundQuantity,
    spendable: sum.spendable + grant.spendableQuantity,
    expired: sum.expired + grant.expiredQuantity,
    clawback: sum.clawback + grant.clawbackQuantity,
    forfeited: sum.forfeited + grant.forfeitedQuantity,
  }), { intended: 0, spendable: 0, expired: 0, clawback: 0, forfeited: 0 })

  return { ok: true, grants: planned, totals }
}

function planGrantReturn(input: {
  generationId: string
  nowMs: number
  quantity: number
  grant: GrantSettlementState
  shortfalls: readonly ShortfallBalance[]
}): PlannedReturnGrant {
  const outstanding = input.shortfalls
    .map(shortfall => ({
      adjustmentId: shortfall.adjustmentId,
      createdAtMs: shortfall.createdAtMs,
      outstanding: shortfall.shortfall - shortfall.settled,
    }))
    .filter(shortfall => shortfall.outstanding > 0)
    .sort((left, right) => left.createdAtMs - right.createdAtMs || compareText(left.adjustmentId, right.adjustmentId))

  let clawbackLeft = input.quantity
  const settlements: PlannedSettlement[] = []
  for (const shortfall of outstanding) {
    if (clawbackLeft === 0) break
    const quantity = Math.min(shortfall.outstanding, clawbackLeft)
    settlements.push({ adjustmentId: shortfall.adjustmentId, quantity })
    clawbackLeft -= quantity
  }
  const clawbackQuantity = input.quantity - clawbackLeft
  const rest = input.quantity - clawbackQuantity
  const timeExpired = input.grant.expiresAtMs !== null && input.grant.expiresAtMs <= input.nowMs
  // Sweep only unused remainder that is already past expiry. A policy revoke does not confiscate unrelated remainder.
  const sweepQuantity = timeExpired && !input.grant.policyRevoked ? input.grant.remaining : 0
  const expiredQuantity = !input.grant.policyRevoked && timeExpired ? rest : 0
  const forfeitedQuantity = input.grant.policyRevoked ? rest : 0
  const spendableQuantity = input.grant.policyRevoked || timeExpired ? 0 : rest

  const ledger: LedgerInstruction[] = []
  let balance = input.grant.remaining
  const push = (
    transactionType: LedgerInstruction['transactionType'],
    quantity: number,
    sourceType: string,
    idempotencyKey: string,
  ) => {
    const balanceAfter = balance + quantity
    ledger.push({
      transactionType,
      quantity,
      sourceType,
      sourceId: input.generationId,
      idempotencyKey,
      balanceBefore: balance,
      balanceAfter,
    })
    balance = balanceAfter
  }

  push('refund', input.quantity, VIDEO_RETURN_REFUND_SOURCE_TYPE, videoReturnRefundTransactionKey(input.generationId, input.grant.grantId))
  if (clawbackQuantity > 0) {
    push('revoke', -clawbackQuantity, VIDEO_RETURN_CLAWBACK_SOURCE_TYPE, videoReturnClawbackTransactionKey(input.generationId, input.grant.grantId))
  }
  if (forfeitedQuantity > 0) {
    push('revoke', -forfeitedQuantity, VIDEO_RETURN_FORFEIT_SOURCE_TYPE, videoReturnForfeitTransactionKey(input.generationId, input.grant.grantId))
  }
  const expireLedgerQuantity = expiredQuantity + sweepQuantity
  if (expireLedgerQuantity > 0) {
    push('expire', -expireLedgerQuantity, VIDEO_RETURN_EXPIRE_SOURCE_TYPE, videoReturnExpireTransactionKey(input.generationId, input.grant.grantId))
  }

  return {
    grantId: input.grant.grantId,
    expectedRemaining: input.grant.remaining,
    refundQuantity: input.quantity,
    spendableQuantity,
    expiredQuantity,
    clawbackQuantity,
    forfeitedQuantity,
    sweepQuantity,
    nextRemaining: balance,
    nextStatus: nextGrantStatus(input.grant, timeExpired, balance),
    settlements,
    ledger,
  }
}

function nextGrantStatus(
  grant: GrantSettlementState,
  timeExpired: boolean,
  nextRemaining: number,
): 'active' | 'expired' | 'revoked' {
  if (grant.policyRevoked) return 'revoked'
  if (timeExpired) return 'expired'
  if (nextRemaining > 0) return 'active'
  if (grant.status === 'revoked') return 'revoked'
  if (grant.status === 'expired') return 'expired'
  return 'active'
}

function isSpendable(grant: SpendableGrant, nowMs: number): boolean {
  return grant.status === 'active'
    && grant.remaining > 0
    && grant.entitlementKey === 'credits'
    && grant.entitlementType === 'consumable'
    && isVideoSpendableSource(grant.sourceType)
    && grant.effectiveAtMs <= nowMs
    && (grant.expiresAtMs === null || grant.expiresAtMs > nowMs)
}

function compareGrantConsumptionOrder(left: SpendableGrant, right: SpendableGrant): number {
  if ((left.expiresAtMs === null) !== (right.expiresAtMs === null)) {
    return left.expiresAtMs === null ? 1 : -1
  }
  if (left.expiresAtMs !== null && right.expiresAtMs !== null && left.expiresAtMs !== right.expiresAtMs) {
    return left.expiresAtMs - right.expiresAtMs
  }
  if (left.createdAtMs !== right.createdAtMs) return left.createdAtMs - right.createdAtMs
  return compareText(left.id, right.id)
}

function isGrantSnapshotValid(grant: SpendableGrant): boolean {
  return grant.id.length > 0
    && grant.userId.length > 0
    && grant.entitlementKey === 'credits'
    && grant.entitlementType === 'consumable'
    && isNonNegativeInteger(grant.remaining)
    && grant.granted !== null
    && Number.isSafeInteger(grant.granted)
    && grant.granted >= 0
    && grant.remaining <= grant.granted
    && Number.isInteger(grant.effectiveAtMs)
    && Number.isInteger(grant.createdAtMs)
    && (grant.expiresAtMs === null || Number.isInteger(grant.expiresAtMs))
}

function isGrantStateValid(grant: GrantSettlementState): boolean {
  return grant.grantId.length > 0
    && isNonNegativeInteger(grant.remaining)
    && isPositiveInteger(grant.granted)
    && grant.remaining <= grant.granted
    && (grant.expiresAtMs === null || Number.isInteger(grant.expiresAtMs))
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Conflict failure for every shared guard. There is no "matched zero rows,
 * continue the batch" result.
 */
export const GUARD_CONFLICT_FAILURE = 'abort_batch' as const

export type GuardConflictFailure = typeof GUARD_CONFLICT_FAILURE
export type GuardStatus = 'active' | 'expired' | 'revoked'

export interface GuardOrder {
  readonly orderId: string
  readonly refundVersion: number
}

export interface GuardGrant {
  readonly grantId: string
  readonly userId: string
  readonly sourceType: string
  readonly sourceId: string
  /** Present only when `sourceType` is `order`, and then equal to `sourceId`. */
  readonly orderId: string | null
  readonly remaining: number
  readonly status: GuardStatus
}

export interface GuardAdjustment {
  readonly adjustmentId: string
  readonly grantId: string
  readonly shortfall: number
  readonly settled: number
}

/** Values read before a cash-refund or video-return batch. */
export interface SharedGuardSnapshot {
  readonly orders: readonly GuardOrder[]
  readonly grants: readonly GuardGrant[]
  readonly adjustments: readonly GuardAdjustment[]
}

export interface GuardOrderWrite {
  readonly orderId: string
  readonly expectedRefundVersion: number
}

export interface GuardGrantWrite {
  readonly grantId: string
  readonly expectedRemaining: number
  readonly expectedStatus: GuardStatus
  readonly nextRemaining: number
  readonly nextStatus: GuardStatus
}

/** One adjustment the batch read. `claimQuantity` is 0 when it was read but not settled. */
export interface GuardAdjustmentObservation {
  readonly adjustmentId: string
  readonly grantId: string
  readonly expectedShortfall: number
  readonly expectedSettled: number
  readonly claimQuantity: number
}

export interface SharedGuardClaim {
  readonly orders: readonly GuardOrderWrite[]
  readonly grants: readonly GuardGrantWrite[]
  readonly observations: readonly GuardAdjustmentObservation[]
}

export type SharedGuardAbortReason =
  | 'invalid_claim'
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

export type SharedGuardDecision =
  | { readonly ok: true }
  | { readonly ok: false, readonly failure: GuardConflictFailure, readonly reason: SharedGuardAbortReason }

export interface CashRefundGuardGrant {
  readonly grantId: string
  readonly expectedRemaining: number
  readonly expectedStatus: GuardStatus
  readonly appliedQuantity: number
  readonly nextStatus: GuardStatus
}

/**
 * Cash-refund fence. `appliedQuantity === 0` still produces a grant write
 * whose next remaining equals the expected remaining. Callers must emit that
 * write; this function has no branch that drops it.
 */
export function cashRefundGuardClaim(input: {
  readonly orderId: string
  readonly expectedRefundVersion: number
  readonly grants: readonly CashRefundGuardGrant[]
  readonly observations: readonly GuardAdjustmentObservation[]
}): { readonly ok: true, readonly claim: SharedGuardClaim }
  | { readonly ok: false, readonly failure: GuardConflictFailure, readonly reason: 'invalid_claim' } {
  if (input.orderId.length === 0 || !isNonNegativeInteger(input.expectedRefundVersion)) {
    return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'invalid_claim' }
  }
  if (input.grants.length === 0) {
    return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'invalid_claim' }
  }
  const grants: GuardGrantWrite[] = []
  for (const grant of input.grants) {
    if (grant.grantId.length === 0
      || !isNonNegativeInteger(grant.expectedRemaining)
      || !isNonNegativeInteger(grant.appliedQuantity)
      || grant.appliedQuantity > grant.expectedRemaining) {
      return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'invalid_claim' }
    }
    grants.push({
      grantId: grant.grantId,
      expectedRemaining: grant.expectedRemaining,
      expectedStatus: grant.expectedStatus,
      nextRemaining: grant.expectedRemaining - grant.appliedQuantity,
      nextStatus: grant.nextStatus,
    })
  }
  return {
    ok: true,
    claim: {
      orders: [{ orderId: input.orderId, expectedRefundVersion: input.expectedRefundVersion }],
      grants,
      observations: input.observations,
    },
  }
}

/**
 * Package the return plan with the order version and every adjustment read
 * for those grants. Zero claim quantities stay in the observation list.
 * Shortfall numbers are copied, never rewritten.
 */
export function returnGuardClaim(input: {
  readonly snapshot: SharedGuardSnapshot
  readonly grants: readonly {
    readonly grantId: string
    readonly expectedRemaining: number
    readonly expectedStatus: GuardStatus
    readonly nextRemaining: number
    readonly nextStatus: GuardStatus
    readonly settlements: readonly { readonly adjustmentId: string, readonly quantity: number }[]
  }[]
}): { readonly ok: true, readonly claim: SharedGuardClaim }
  | { readonly ok: false, readonly failure: GuardConflictFailure, readonly reason: 'invalid_claim' | 'adjustment_grant_mismatch' | 'missing_order_fence' | 'unsupported_source' } {
  const grantsById = new Map(input.snapshot.grants.map(grant => [grant.grantId, grant]))
  const adjustmentsById = new Map(input.snapshot.adjustments.map(adjustment => [adjustment.adjustmentId, adjustment]))
  const orders: GuardOrderWrite[] = []
  const seenOrders = new Set<string>()
  const grantWrites: GuardGrantWrite[] = []
  const claimed = new Map<string, number>()

  for (const grant of input.grants) {
    const current = grantsById.get(grant.grantId)
    if (!current) return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'invalid_claim' }
    if (current.sourceType === 'order') {
      if (current.orderId === null || current.orderId !== current.sourceId) {
        return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'missing_order_fence' }
      }
      if (!seenOrders.has(current.orderId)) {
        const order = input.snapshot.orders.find(item => item.orderId === current.orderId)
        if (!order) return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'missing_order_fence' }
        seenOrders.add(current.orderId)
        orders.push({ orderId: order.orderId, expectedRefundVersion: order.refundVersion })
      }
    }
    else if (current.orderId !== null) {
      return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'invalid_claim' }
    }
    else if (!returnSourceAllowed(current.sourceType, true)) {
      return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'unsupported_source' }
    }
    grantWrites.push({
      grantId: grant.grantId,
      expectedRemaining: grant.expectedRemaining,
      expectedStatus: grant.expectedStatus,
      nextRemaining: grant.nextRemaining,
      nextStatus: grant.nextStatus,
    })
    for (const settlement of grant.settlements) {
      const adjustment = adjustmentsById.get(settlement.adjustmentId)
      if (!adjustment || adjustment.grantId !== grant.grantId) {
        return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'adjustment_grant_mismatch' }
      }
      if (!isPositiveInteger(settlement.quantity)) {
        return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'invalid_claim' }
      }
      claimed.set(settlement.adjustmentId, (claimed.get(settlement.adjustmentId) ?? 0) + settlement.quantity)
    }
  }

  const observations: GuardAdjustmentObservation[] = []
  for (const adjustment of input.snapshot.adjustments) {
    if (!grantWrites.some(grant => grant.grantId === adjustment.grantId)) continue
    observations.push({
      adjustmentId: adjustment.adjustmentId,
      grantId: adjustment.grantId,
      expectedShortfall: adjustment.shortfall,
      expectedSettled: adjustment.settled,
      claimQuantity: claimed.get(adjustment.adjustmentId) ?? 0,
    })
  }
  return { ok: true, claim: { orders, grants: grantWrites, observations } }
}

/**
 * Decide whether a cash-refund or return batch may commit.
 * Order: claim shape, order fence, refund_version, grant remaining/status,
 * then adjustment observation / settled sum / shortfall cap.
 * A zero remaining delta still checks the grant. Order grants still require
 * `refund_version`. Non-order grants do not invent an order. An empty grant
 * list stays `missing_order_fence`; zero-quote failure uses a separate check.
 */
export function evaluateSharedSettlementGuard(
  current: SharedGuardSnapshot,
  claim: SharedGuardClaim,
): SharedGuardDecision {
  if (hasDuplicate(current.orders.map(order => order.orderId))
    || hasDuplicate(current.grants.map(grant => grant.grantId))
    || hasDuplicate(current.adjustments.map(adjustment => adjustment.adjustmentId))
    || hasDuplicate(claim.orders.map(order => order.orderId))
    || hasDuplicate(claim.grants.map(grant => grant.grantId))
    || hasDuplicate(claim.observations.map(observation => observation.adjustmentId))) {
    return abortGuard('invalid_claim')
  }
  if (claim.grants.length === 0) return abortGuard('missing_order_fence')

  const orders = new Map(current.orders.map(order => [order.orderId, order]))
  const grants = new Map(current.grants.map(grant => [grant.grantId, grant]))
  const adjustments = new Map(current.adjustments.map(adjustment => [adjustment.adjustmentId, adjustment]))

  for (const grantWrite of claim.grants) {
    const grant = grants.get(grantWrite.grantId)
    if (!grant) return abortGuard('stale_grant')
    if (grant.userId.length === 0 || grant.sourceId.length === 0) return abortGuard('owner_mismatch')
    if (grant.sourceType === 'order') {
      if (grant.orderId === null || grant.orderId !== grant.sourceId) return abortGuard('missing_order_fence')
      if (!claim.orders.some(order => order.orderId === grant.orderId)) return abortGuard('missing_order_fence')
    }
    else if (grant.orderId !== null || !returnSourceAllowed(grant.sourceType, true)) {
      return abortGuard(grant.orderId !== null ? 'invalid_claim' : 'unsupported_source')
    }
    if (!isNonNegativeInteger(grantWrite.expectedRemaining) || !isNonNegativeInteger(grantWrite.nextRemaining)) {
      return abortGuard('invalid_claim')
    }
  }

  const orderWrites = [...claim.orders].sort((left, right) => compareText(left.orderId, right.orderId))
  for (const orderWrite of orderWrites) {
    const order = orders.get(orderWrite.orderId)
    if (!order || order.refundVersion !== orderWrite.expectedRefundVersion) {
      return abortGuard('stale_refund_version')
    }
  }

  const grantWrites = [...claim.grants].sort((left, right) => compareText(left.grantId, right.grantId))
  for (const grantWrite of grantWrites) {
    const grant = grants.get(grantWrite.grantId)
    if (!grant
      || grant.remaining !== grantWrite.expectedRemaining
      || grant.status !== grantWrite.expectedStatus) {
      return abortGuard('stale_grant')
    }
  }

  const fencedGrants = new Set(claim.grants.map(grant => grant.grantId))
  const observed = new Map(claim.observations.map(observation => [observation.adjustmentId, observation]))
  for (const adjustment of current.adjustments) {
    if (fencedGrants.has(adjustment.grantId) && !observed.has(adjustment.adjustmentId)) {
      return abortGuard('stale_settled')
    }
  }

  for (const observation of [...claim.observations].sort((left, right) => compareText(left.adjustmentId, right.adjustmentId))) {
    if (!fencedGrants.has(observation.grantId)) return abortGuard('missing_grant_fence')
    const adjustment = adjustments.get(observation.adjustmentId)
    if (!adjustment) return abortGuard('unknown_adjustment')
    if (adjustment.grantId !== observation.grantId) return abortGuard('adjustment_grant_mismatch')
    if (!isNonNegativeInteger(observation.expectedShortfall)
      || !isNonNegativeInteger(observation.expectedSettled)
      || !isNonNegativeInteger(observation.claimQuantity)) {
      return abortGuard('invalid_claim')
    }
    if (adjustment.shortfall !== observation.expectedShortfall
      || adjustment.settled !== observation.expectedSettled) {
      return abortGuard('stale_settled')
    }
    if (observation.expectedSettled + observation.claimQuantity > observation.expectedShortfall) {
      return abortGuard('settlement_exceeds_shortfall')
    }
  }

  return { ok: true }
}

/**
 * Apply a claim that already passed the guard. Shortfall is preserved.
 * Returns null when the guard would abort, and does not change the input.
 */
export function applyCommittedGuard(
  current: SharedGuardSnapshot,
  claim: SharedGuardClaim,
): SharedGuardSnapshot | null {
  if (!evaluateSharedSettlementGuard(current, claim).ok) return null
  const nextVersion = new Map(claim.orders.map(order => [order.orderId, order.expectedRefundVersion + 1]))
  const grantWrites = new Map(claim.grants.map(grant => [grant.grantId, grant]))
  const claimed = new Map(claim.observations.map(observation => [observation.adjustmentId, observation.claimQuantity]))
  return {
    orders: current.orders.map(order => ({
      orderId: order.orderId,
      refundVersion: nextVersion.get(order.orderId) ?? order.refundVersion,
    })),
    grants: current.grants.map(grant => {
      const write = grantWrites.get(grant.grantId)
      if (!write) return grant
      return {
        ...grant,
        remaining: write.nextRemaining,
        status: write.nextStatus,
      }
    }),
    adjustments: current.adjustments.map(adjustment => ({
      adjustmentId: adjustment.adjustmentId,
      grantId: adjustment.grantId,
      shortfall: adjustment.shortfall,
      settled: adjustment.settled + (claimed.get(adjustment.adjustmentId) ?? 0),
    })),
  }
}

export type LinkageAbortReason =
  | 'clawback_sum_mismatch'
  | 'adjustment_grant_mismatch'
  | 'settlement_exceeds_shortfall'
  | 'ledger_mismatch'
  | 'idempotency_key_mismatch'

export interface ClawbackLedgerFact {
  readonly grantId: string
  readonly quantity: number
  readonly sourceType: string
  readonly sourceId: string
  readonly idempotencyKey: string
}

/**
 * After the inserts, the return batch must still prove this or abort.
 * Settlement sum for the operation equals `operationClawback`.
 * Each grant's settlement sum equals the absolute clawback ledger quantity.
 * Cumulative settled quantity cannot exceed that adjustment's original shortfall.
 */
export function evaluateClawbackLinkage(input: {
  readonly generationId: string
  readonly operationClawback: number
  readonly settlements: readonly { readonly adjustmentId: string, readonly grantId: string, readonly quantity: number }[]
  readonly adjustments: readonly { readonly adjustmentId: string, readonly grantId: string, readonly shortfall: number }[]
  readonly settledByAdjustment: readonly { readonly adjustmentId: string, readonly settled: number }[]
  readonly clawbackLedgers: readonly ClawbackLedgerFact[]
}): { readonly ok: true }
  | { readonly ok: false, readonly failure: GuardConflictFailure, readonly reason: LinkageAbortReason } {
  if (!isNonNegativeInteger(input.operationClawback)) {
    return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'clawback_sum_mismatch' }
  }
  const adjustments = new Map(input.adjustments.map(adjustment => [adjustment.adjustmentId, adjustment]))
  const settled = new Map(input.settledByAdjustment.map(item => [item.adjustmentId, item.settled]))
  const claimedHere = new Map<string, number>()
  let settlementSum = 0
  const byGrant = new Map<string, number>()
  for (const settlement of input.settlements) {
    if (!isPositiveInteger(settlement.quantity)) {
      return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'clawback_sum_mismatch' }
    }
    const adjustment = adjustments.get(settlement.adjustmentId)
    if (!adjustment || adjustment.grantId !== settlement.grantId) {
      return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'adjustment_grant_mismatch' }
    }
    claimedHere.set(settlement.adjustmentId, (claimedHere.get(settlement.adjustmentId) ?? 0) + settlement.quantity)
    settlementSum += settlement.quantity
    byGrant.set(settlement.grantId, (byGrant.get(settlement.grantId) ?? 0) + settlement.quantity)
  }
  for (const [adjustmentId, claimed] of claimedHere) {
    const adjustment = adjustments.get(adjustmentId)
    const cumulative = settled.get(adjustmentId)
    if (!adjustment || cumulative === undefined || claimed > adjustment.shortfall || cumulative > adjustment.shortfall) {
      return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'settlement_exceeds_shortfall' }
    }
  }
  if (settlementSum !== input.operationClawback) {
    return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'clawback_sum_mismatch' }
  }
  // Unique IDs, equal counts, and the membership checks below prove full grant coverage.
  if (input.clawbackLedgers.length !== byGrant.size
    || hasDuplicate(input.clawbackLedgers.map(ledger => ledger.grantId))
    || hasDuplicate(input.clawbackLedgers.map(ledger => ledger.idempotencyKey))) {
    return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'ledger_mismatch' }
  }
  for (const ledger of input.clawbackLedgers) {
    const expectedKey = videoReturnClawbackTransactionKey(input.generationId, ledger.grantId)
    if (ledger.idempotencyKey !== expectedKey) {
      return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'idempotency_key_mismatch' }
    }
    if (ledger.sourceType !== VIDEO_RETURN_CLAWBACK_SOURCE_TYPE || ledger.sourceId !== input.generationId) {
      return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'ledger_mismatch' }
    }
    const settledQuantity = byGrant.get(ledger.grantId)
    if (settledQuantity === undefined || ledger.quantity !== -settledQuantity) {
      return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'ledger_mismatch' }
    }
  }
  return { ok: true }
}

export type TerminalOutboxEvent = 'start_submission' | 'store_output'

export interface TerminalPostingRule {
  readonly fromStatus: InternalGenerationStatus
  readonly event:
    | 'deadline_reached'
    | 'submission_rejected'
    | 'provider_failed'
    | 'storage_irrecoverable'
    | 'recovery_confirmed_absent'
    | 'output_stored'
  readonly toStatus: 'failed' | 'succeeded'
  readonly creditReturn: boolean
  readonly attemptLease: boolean
  readonly outboxEvent: TerminalOutboxEvent | null
}

const TERMINAL_POSTINGS: readonly TerminalPostingRule[] = [
  { fromStatus: 'queued', event: 'deadline_reached', toStatus: 'failed', creditReturn: true, attemptLease: false, outboxEvent: 'start_submission' },
  { fromStatus: 'submitting', event: 'submission_rejected', toStatus: 'failed', creditReturn: true, attemptLease: true, outboxEvent: null },
  { fromStatus: 'processing', event: 'provider_failed', toStatus: 'failed', creditReturn: true, attemptLease: true, outboxEvent: null },
  { fromStatus: 'storing', event: 'storage_irrecoverable', toStatus: 'failed', creditReturn: true, attemptLease: true, outboxEvent: 'store_output' },
  { fromStatus: 'needs_review', event: 'recovery_confirmed_absent', toStatus: 'failed', creditReturn: true, attemptLease: true, outboxEvent: null },
  { fromStatus: 'needs_review', event: 'provider_failed', toStatus: 'failed', creditReturn: true, attemptLease: true, outboxEvent: null },
  { fromStatus: 'storing', event: 'output_stored', toStatus: 'succeeded', creditReturn: false, attemptLease: true, outboxEvent: 'store_output' },
]

export interface ZeroConsumeOperation {
  readonly generationId: string
  readonly operationType: 'consume'
  readonly intendedQuantity: number
  readonly spendableQuantity: number
  readonly expiredQuantity: number
  readonly clawbackQuantity: number
  readonly forfeitedQuantity: number
}

export interface ZeroReturnOperation {
  readonly intendedQuantity: 0
  readonly spendableQuantity: 0
  readonly expiredQuantity: 0
  readonly clawbackQuantity: 0
  readonly forfeitedQuantity: 0
  readonly ledger: readonly []
}

export type ZeroConsumeAbortReason =
  | 'missing_consume_operation'
  | 'not_zero_consume'
  | 'consume_ledger_present'
  | TerminalAbortReason

/**
 * Failure settlement for a real zero-quote consume. Does not accept an empty
 * shared-guard claim, and does not emit a zero-quantity ledger row.
 */
export function evaluateZeroConsumeFailure(input: {
  readonly generationId: string
  readonly quotedCredits: number
  readonly consumeOperation: ZeroConsumeOperation | null
  readonly consumeLedgerCount: number
  readonly terminal: {
    readonly currentStatus: InternalGenerationStatus
    readonly currentVersion: number
    readonly expectedVersion: number
    readonly event: string
    readonly attemptLeaseHeld: boolean
    readonly outboxLeaseHeld: boolean
    readonly deadlineAtMs: number | null
    readonly nowMs: number
  }
}): { readonly ok: true, readonly returnOperation: ZeroReturnOperation }
  | { readonly ok: false, readonly failure: GuardConflictFailure, readonly reason: ZeroConsumeAbortReason } {
  const terminal = evaluateTerminalGuard(input.terminal)
  if (!terminal.ok) return terminal
  if (!terminal.creditReturn) return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'not_zero_consume' }
  if (input.quotedCredits !== 0) return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'not_zero_consume' }
  if (input.consumeOperation === null) {
    return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'missing_consume_operation' }
  }
  const operation = input.consumeOperation
  const parts = operation.spendableQuantity + operation.expiredQuantity + operation.clawbackQuantity + operation.forfeitedQuantity
  if (operation.generationId !== input.generationId
    || operation.operationType !== 'consume'
    || operation.intendedQuantity !== 0
    || parts !== 0
    || operation.spendableQuantity !== 0
    || operation.expiredQuantity !== 0
    || operation.clawbackQuantity !== 0
    || operation.forfeitedQuantity !== 0) {
    return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'not_zero_consume' }
  }
  if (input.consumeLedgerCount !== 0) {
    return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'consume_ledger_present' }
  }
  return {
    ok: true,
    returnOperation: {
      intendedQuantity: 0,
      spendableQuantity: 0,
      expiredQuantity: 0,
      clawbackQuantity: 0,
      forfeitedQuantity: 0,
      ledger: [],
    },
  }
}

export function legalTerminalPosting(
  fromStatus: InternalGenerationStatus,
  event: string,
): TerminalPostingRule | null {
  return TERMINAL_POSTINGS.find(rule => rule.fromStatus === fromStatus && rule.event === event) ?? null
}

export type TerminalAbortReason =
  | 'illegal_transition'
  | 'stale_version'
  | 'lease_not_held'
  | 'deadline_not_reached'

export type TerminalGuardDecision =
  | { readonly ok: true, readonly toStatus: 'failed' | 'succeeded', readonly nextVersion: number, readonly creditReturn: boolean }
  | { readonly ok: false, readonly failure: GuardConflictFailure, readonly reason: TerminalAbortReason }

/**
 * Version match is required and is not sufficient. `succeeded` has no legal
 * event into `failed`, including when `currentVersion === expectedVersion`.
 * A lost lease aborts the batch; it does not skip the status write and continue.
 */
export function evaluateTerminalGuard(input: {
  readonly currentStatus: InternalGenerationStatus
  readonly currentVersion: number
  readonly expectedVersion: number
  readonly event: string
  readonly attemptLeaseHeld: boolean
  readonly outboxLeaseHeld: boolean
  readonly deadlineAtMs: number | null
  readonly nowMs: number
}): TerminalGuardDecision {
  const rule = legalTerminalPosting(input.currentStatus, input.event)
  if (!rule) return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'illegal_transition' }
  if (!isPositiveInteger(input.currentVersion) || input.currentVersion !== input.expectedVersion) {
    return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'stale_version' }
  }
  if ((rule.attemptLease && !input.attemptLeaseHeld) || (rule.outboxEvent !== null && !input.outboxLeaseHeld)) {
    return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'lease_not_held' }
  }
  if (rule.event === 'deadline_reached' && (input.deadlineAtMs === null || !Number.isInteger(input.nowMs) || input.deadlineAtMs > input.nowMs)) {
    return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'deadline_not_reached' }
  }
  return {
    ok: true,
    toStatus: rule.toStatus,
    nextVersion: input.currentVersion + 1,
    creditReturn: rule.creditReturn,
  }
}

/** Mirrors the `video_provider_costs` CHECK added in migration 0002. */
export function providerCostRowAllowed(row: {
  readonly costKind: 'estimated' | 'actual' | 'unknown'
  readonly amountMicros: number | null
  readonly currency: string | null
}): boolean {
  if (row.costKind === 'unknown') return row.amountMicros === null && row.currency === null
  return typeof row.amountMicros === 'number'
    && Number.isInteger(row.amountMicros)
    && row.amountMicros >= 0
    && row.currency !== null
    && /^[A-Z]{3}$/.test(row.currency)
}

function abortGuard(reason: SharedGuardAbortReason): SharedGuardDecision {
  return { ok: false, failure: GUARD_CONFLICT_FAILURE, reason }
}
