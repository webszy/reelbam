/**
 * Pure refund accounting helpers (no database / Clerk / provider I/O).
 *
 * Cumulative proportional credit reversal for original-order grants:
 *   cumulativeTarget = Q when cumulativeRefund === paidBase
 *                    else min(Q, floor(Q * cumulativeRefund / paidBase))
 * Per-refund requested = current cumulative target − prior cumulative target.
 * Applied = min(requested, remaining); shortfall = requested − applied.
 */

export interface GrantRefundPlan {
  grantId: string
  grantedQuantity: number
  remainingQuantity: number
  priorCumulativeTarget: number
  cumulativeTarget: number
  /** Incremental target for this refund only. */
  targetQuantity: number
  appliedQuantity: number
  shortfallQuantity: number
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value > 0
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
}

/**
 * Cumulative credit target for one grant given money progress against the
 * immutable provider-paid base.
 */
export function computeCumulativeCreditTarget(input: {
  grantedQuantity: number
  paidBase: number
  cumulativeRefund: number
}): number {
  const { grantedQuantity, paidBase, cumulativeRefund } = input
  if (
    !isPositiveInteger(grantedQuantity)
    || !isPositiveInteger(paidBase)
    || !isNonNegativeInteger(cumulativeRefund)
  ) {
    throw new Error('INVALID_REFUND_RATIO_INPUT')
  }
  if (cumulativeRefund > paidBase) {
    throw new Error('CUMULATIVE_REFUND_EXCEEDS_PAID_BASE')
  }
  if (cumulativeRefund === 0) {
    return 0
  }
  if (cumulativeRefund === paidBase) {
    return grantedQuantity
  }
  return Math.min(
    grantedQuantity,
    Math.floor((grantedQuantity * cumulativeRefund) / paidBase),
  )
}

/**
 * Plan the incremental reverse for one grant for the current refund event.
 */
export function planGrantRefundReversal(input: {
  grantId: string
  grantedQuantity: number
  remainingQuantity: number
  paidBase: number
  priorCumulativeRefund: number
  cumulativeRefund: number
}): GrantRefundPlan {
  const priorCumulativeTarget = computeCumulativeCreditTarget({
    grantedQuantity: input.grantedQuantity,
    paidBase: input.paidBase,
    cumulativeRefund: input.priorCumulativeRefund,
  })
  const cumulativeTarget = computeCumulativeCreditTarget({
    grantedQuantity: input.grantedQuantity,
    paidBase: input.paidBase,
    cumulativeRefund: input.cumulativeRefund,
  })
  const targetQuantity = Math.max(0, cumulativeTarget - priorCumulativeTarget)
  const remaining = Math.max(0, input.remainingQuantity)
  const appliedQuantity = Math.min(targetQuantity, remaining)
  const shortfallQuantity = targetQuantity - appliedQuantity

  return {
    grantId: input.grantId,
    grantedQuantity: input.grantedQuantity,
    remainingQuantity: remaining,
    priorCumulativeTarget,
    cumulativeTarget,
    targetQuantity,
    appliedQuantity,
    shortfallQuantity,
  }
}

/** Derive original-order settlement status from cumulative money state. */
export function resolveOrderRefundStatus(input: {
  paidBase: number
  cumulativeSucceededRefund: number
}): 'partially_refunded' | 'refunded' {
  if (input.cumulativeSucceededRefund >= input.paidBase) {
    return 'refunded'
  }
  return 'partially_refunded'
}

/** Deterministic local refund primary key from provider identity. */
export function buildLocalRefundId(
  provider: string,
  providerRefundId: string,
): string {
  return `br:${provider}:${providerRefundId}`
}

/** Deterministic refund credit-adjustment id. */
export function buildRefundCreditAdjustmentId(
  refundId: string,
  grantId: string,
): string {
  return `brca:${refundId}:${grantId}`
}

/** Deterministic revoke ledger identity for a refund against a grant. */
export function buildRefundRevokeTransactionIds(
  refundId: string,
  grantId: string,
): { id: string, idempotencyKey: string } {
  const base = `refund:${refundId}:grant:${grantId}:revoke`
  return {
    id: `et:${base}`,
    idempotencyKey: `entitlement:${base}`,
  }
}

/** Deterministic dispute primary key. */
export function buildLocalDisputeId(
  provider: string,
  providerDisputeId: string,
): string {
  return `bd:${provider}:${providerDisputeId}`
}
