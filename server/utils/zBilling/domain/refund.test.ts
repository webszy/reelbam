import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  computeCumulativeCreditTarget,
  planGrantRefundReversal,
  resolveOrderRefundStatus,
} from './refund.ts'

describe('computeCumulativeCreditTarget', () => {
  it('returns full quantity when cumulative refund equals paid base', () => {
    assert.equal(
      computeCumulativeCreditTarget({
        grantedQuantity: 5,
        paidBase: 499,
        cumulativeRefund: 499,
      }),
      5,
    )
  })

  it('uses floor for partial proportions', () => {
    // 5 * 250 / 499 = 2.50… → floor 2
    assert.equal(
      computeCumulativeCreditTarget({
        grantedQuantity: 5,
        paidBase: 499,
        cumulativeRefund: 250,
      }),
      2,
    )
  })

  it('forces full quantity on final cumulative full refund even with floor rounding', () => {
    const mid = computeCumulativeCreditTarget({
      grantedQuantity: 5,
      paidBase: 499,
      cumulativeRefund: 250,
    })
    const full = computeCumulativeCreditTarget({
      grantedQuantity: 5,
      paidBase: 499,
      cumulativeRefund: 499,
    })
    assert.equal(mid, 2)
    assert.equal(full, 5)
  })

  it('rejects cumulative refund above paid base', () => {
    assert.throws(() => computeCumulativeCreditTarget({
      grantedQuantity: 5,
      paidBase: 499,
      cumulativeRefund: 500,
    }))
  })
})

describe('planGrantRefundReversal', () => {
  it('plans incremental target from cumulative targets not prior applied', () => {
    const first = planGrantRefundReversal({
      grantId: 'g1',
      grantedQuantity: 5,
      remainingQuantity: 5,
      paidBase: 499,
      priorCumulativeRefund: 0,
      cumulativeRefund: 250,
    })
    assert.equal(first.targetQuantity, 2)
    assert.equal(first.appliedQuantity, 2)
    assert.equal(first.shortfallQuantity, 0)

    const second = planGrantRefundReversal({
      grantId: 'g1',
      grantedQuantity: 5,
      remainingQuantity: 3,
      paidBase: 499,
      priorCumulativeRefund: 250,
      cumulativeRefund: 499,
    })
    // cumulative target 5 − prior 2 = 3
    assert.equal(second.targetQuantity, 3)
    assert.equal(second.appliedQuantity, 3)
    assert.equal(second.shortfallQuantity, 0)
  })

  it('clamps applied to remaining and records shortfall', () => {
    const plan = planGrantRefundReversal({
      grantId: 'g1',
      grantedQuantity: 5,
      remainingQuantity: 0,
      paidBase: 499,
      priorCumulativeRefund: 0,
      cumulativeRefund: 499,
    })
    assert.equal(plan.targetQuantity, 5)
    assert.equal(plan.appliedQuantity, 0)
    assert.equal(plan.shortfallQuantity, 5)
  })
})

describe('resolveOrderRefundStatus', () => {
  it('marks full cumulative refunds as refunded', () => {
    assert.equal(
      resolveOrderRefundStatus({ paidBase: 499, cumulativeSucceededRefund: 499 }),
      'refunded',
    )
  })

  it('marks partial cumulative refunds as partially_refunded', () => {
    assert.equal(
      resolveOrderRefundStatus({ paidBase: 499, cumulativeSucceededRefund: 100 }),
      'partially_refunded',
    )
  })
})
