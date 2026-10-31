import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  GUARD_CONFLICT_FAILURE,
  applyCommittedGuard,
  cashRefundGuardClaim,
  evaluateClawbackLinkage,
  evaluateSharedSettlementGuard,
  evaluateTerminalGuard,
  planCreditReturn,
  providerCostRowAllowed,
  returnGuardClaim,
  videoReturnClawbackTransactionKey,
  videoReturnOperationKey,
} from '../src/credits/contract.ts'
import type {
  GuardStatus,
  PlannedReturn,
  SharedGuardClaim,
  SharedGuardSnapshot,
} from '../src/credits/contract.ts'

const revoked = 'revoked' satisfies GuardStatus

function snapshot(settled: number, refundVersion: number, remaining: number): SharedGuardSnapshot {
  return {
    orders: [{ orderId: 'order-1', refundVersion }],
    grants: [{
      grantId: 'grant-1',
      userId: 'user-1',
      sourceType: 'order',
      sourceId: 'order-1',
      orderId: 'order-1',
      remaining,
      status: remaining > 0 ? 'active' : revoked,
    }],
    adjustments: [{ adjustmentId: 'adj-partial', grantId: 'grant-1', shortfall: 6, settled }],
  }
}

function claimFor(current: SharedGuardSnapshot, generationId: string, quantity: number): SharedGuardClaim {
  const planned = planCreditReturn({
    generationId,
    nowMs: 1_000,
    consumeLines: [{ grantId: 'grant-1', quantity }],
    grants: [{
      grantId: 'grant-1',
      remaining: current.grants[0]!.remaining,
      granted: 10,
      status: current.grants[0]!.status,
      expiresAtMs: null,
      policyRevoked: false,
    }],
    shortfalls: current.adjustments.map(adjustment => ({
      adjustmentId: adjustment.adjustmentId,
      grantId: adjustment.grantId,
      shortfall: adjustment.shortfall,
      settled: adjustment.settled,
      createdAtMs: 10,
    })),
  })
  if (!planned.ok) throw new Error(planned.reason)
  const packaged = returnGuardClaim({
    snapshot: current,
    grants: planned.grants.map(grant => ({
      grantId: grant.grantId,
      expectedRemaining: grant.expectedRemaining,
      expectedStatus: current.grants[0]!.status,
      nextRemaining: grant.nextRemaining,
      nextStatus: grant.nextStatus,
      settlements: grant.settlements,
    })),
  })
  if (!packaged.ok) throw new Error(packaged.reason)
  return packaged.claim
}

function totals(planned: PlannedReturn & { ok: true }) {
  const grant = planned.grants[0]
  if (!grant) throw new Error('missing grant')
  return grant
}

function abortReason(decision: { ok: true } | { ok: false, reason: string }): string {
  return decision.ok ? 'ok' : decision.reason
}

function twoGrantClawbackFacts() {
  const generationId = 'gen-a'
  const grants = [
    { grantId: 'grant-1', adjustmentId: 'adj-1' },
    { grantId: 'grant-2', adjustmentId: 'adj-2' },
  ]
  return {
    generationId,
    operationClawback: 6,
    settlements: grants.map(grant => ({ ...grant, quantity: 3 })),
    adjustments: grants.map(grant => ({ ...grant, shortfall: 3 })),
    settledByAdjustment: grants.map(({ adjustmentId }) => ({ adjustmentId, settled: 3 })),
    clawbackLedgers: grants.map(({ grantId }) => ({
      grantId,
      quantity: -3,
      sourceType: 'video_generation_return_clawback',
      sourceId: generationId,
      idempotencyKey: videoReturnClawbackTransactionKey(generationId, grantId),
    })),
  }
}

describe('现金退款与返还的共享守卫', () => {
  it('applied 为 0 仍然写出 grant 守卫，净余额可以不变', () => {
    const packaged = cashRefundGuardClaim({
      orderId: 'order-1',
      expectedRefundVersion: 3,
      grants: [{
        grantId: 'grant-1',
        expectedRemaining: 0,
        expectedStatus: revoked,
        appliedQuantity: 0,
        nextStatus: revoked,
      }],
      observations: [],
    })
    if (!packaged.ok) assert.fail(packaged.reason)
    assert.equal(packaged.claim.grants.length, 1)
    assert.equal(packaged.claim.grants[0]?.expectedRemaining, 0)
    assert.equal(packaged.claim.grants[0]?.nextRemaining, 0)
    assert.deepEqual(packaged.claim.orders, [{ orderId: 'order-1', expectedRefundVersion: 3 }])
  })

  it('零回收：退款不改变余额时，后提交的返还整批中止', () => {
    const read: SharedGuardSnapshot = {
      orders: [{ orderId: 'order-1', refundVersion: 3 }],
      grants: [{
        grantId: 'grant-1',
        userId: 'user-1',
        sourceType: 'order',
        sourceId: 'order-1',
        orderId: 'order-1',
        remaining: 0,
        status: revoked,
      }],
      adjustments: [],
    }
    const refund = cashRefundGuardClaim({
      orderId: 'order-1',
      expectedRefundVersion: 3,
      grants: [{
        grantId: 'grant-1',
        expectedRemaining: 0,
        expectedStatus: revoked,
        appliedQuantity: 0,
        nextStatus: revoked,
      }],
      observations: [],
    })
    if (!refund.ok) assert.fail(refund.reason)
    const restore = planCreditReturn({
      generationId: 'gen-a',
      nowMs: 1_000,
      consumeLines: [{ grantId: 'grant-1', quantity: 6 }],
      grants: [{ grantId: 'grant-1', remaining: 0, granted: 10, status: revoked, expiresAtMs: null, policyRevoked: false }],
      shortfalls: [],
    })
    if (!restore.ok) assert.fail(restore.reason)
    const returnClaim = returnGuardClaim({
      snapshot: read,
      grants: [{
        grantId: 'grant-1',
        expectedRemaining: 0,
        expectedStatus: revoked,
        nextRemaining: restore.grants[0]!.nextRemaining,
        nextStatus: restore.grants[0]!.nextStatus,
        settlements: [],
      }],
    })
    if (!returnClaim.ok) assert.fail(returnClaim.reason)
    assert.equal(evaluateSharedSettlementGuard(read, refund.claim).ok, true)
    assert.equal(evaluateSharedSettlementGuard(read, returnClaim.claim).ok, true)

    const refundCommitted = applyCommittedGuard(read, refund.claim)
    assert.ok(refundCommitted)
    const afterRefund: SharedGuardSnapshot = {
      ...refundCommitted,
      adjustments: [{ adjustmentId: 'adj-partial', grantId: 'grant-1', shortfall: 6, settled: 0 }],
    }
    const staleReturn = evaluateSharedSettlementGuard(afterRefund, returnClaim.claim)
    assert.deepEqual(staleReturn, { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'stale_refund_version' })
    assert.equal(applyCommittedGuard(afterRefund, returnClaim.claim), null)

    const versionOnly: SharedGuardSnapshot = {
      ...read,
      orders: [{ orderId: 'order-1', refundVersion: 4 }],
    }
    assert.equal(abortReason(evaluateSharedSettlementGuard(versionOnly, refund.claim)), 'stale_refund_version')
    const remainingOnly: SharedGuardSnapshot = {
      ...read,
      grants: [{
        grantId: 'grant-1',
        userId: 'user-1',
        sourceType: 'order',
        sourceId: 'order-1',
        orderId: 'order-1',
        remaining: 6,
        status: 'active',
      }],
    }
    assert.equal(abortReason(evaluateSharedSettlementGuard(remainingOnly, refund.claim)), 'stale_grant')
  })

  it('净余额变化为 0 时，余额相同不能代替 refund_version', () => {
    const read = snapshot(0, 4, 0)
    const claim = claimFor(read, 'gen-a', 6)
    assert.equal(claim.grants[0]?.expectedRemaining, 0)
    assert.equal(claim.grants[0]?.nextRemaining, 0)
    assert.equal(claim.observations[0]?.claimQuantity, 6)
    const committed = applyCommittedGuard(read, claim)
    assert.ok(committed)
    assert.equal(committed.grants[0]?.remaining, 0)
    assert.equal(committed.orders[0]?.refundVersion, 5)
    assert.equal(committed.adjustments[0]?.shortfall, 6)
    assert.equal(committed.adjustments[0]?.settled, 6)

    const sibling = claimFor(read, 'gen-b', 4)
    assert.equal(sibling.grants[0]?.expectedRemaining, committed.grants[0]?.remaining)
    const decision = evaluateSharedSettlementGuard(committed, sibling)
    assert.deepEqual(decision, { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'stale_refund_version' })

    const sameVersionStaleSettled: SharedGuardClaim = {
      ...sibling,
      orders: [{ orderId: 'order-1', expectedRefundVersion: 5 }],
    }
    assert.equal(abortReason(evaluateSharedSettlementGuard(committed, sameVersionStaleSettled)), 'stale_settled')
  })
})

describe('两个任务不能重复补收同一 shortfall', () => {
  it('A 先提交时只补收 6，B 重算后可消费 4，原 shortfall 仍为 6', () => {
    const read = snapshot(0, 7, 0)
    const claimA = claimFor(read, 'gen-a', 6)
    const claimB = claimFor(read, 'gen-b', 4)
    assert.equal(claimA.observations[0]?.claimQuantity, 6)
    assert.equal(claimB.observations[0]?.claimQuantity, 4)
    assert.equal(videoReturnOperationKey('gen-a'), 'video_credit:return:gen-a')
    assert.equal(
      videoReturnClawbackTransactionKey('gen-a', 'grant-1'),
      'entitlement:video_generation:gen-a:grant:grant-1:clawback',
    )

    const afterA = applyCommittedGuard(read, claimA)
    assert.ok(afterA)
    assert.equal(applyCommittedGuard(afterA, claimB), null)
    const replayB = planCreditReturn({
      generationId: 'gen-b',
      nowMs: 1_000,
      consumeLines: [{ grantId: 'grant-1', quantity: 4 }],
      grants: [{
        grantId: 'grant-1',
        remaining: afterA.grants[0]!.remaining,
        granted: 10,
        status: afterA.grants[0]!.status,
        expiresAtMs: null,
        policyRevoked: false,
      }],
      shortfalls: [{
        adjustmentId: 'adj-partial',
        grantId: 'grant-1',
        shortfall: afterA.adjustments[0]!.shortfall,
        settled: afterA.adjustments[0]!.settled,
        createdAtMs: 10,
      }],
    })
    if (!replayB.ok) assert.fail(replayB.reason)
    const grantB = totals(replayB)
    assert.equal(grantB.clawbackQuantity, 0)
    assert.equal(grantB.spendableQuantity, 4)
    assert.equal(grantB.nextRemaining, 4)
    assert.deepEqual(grantB.settlements, [])
    const claimB2 = claimFor(afterA, 'gen-b', 4)
    const finalState = applyCommittedGuard(afterA, claimB2)
    assert.ok(finalState)
    assert.equal(finalState.adjustments[0]?.settled, 6)
    assert.equal(finalState.adjustments[0]?.shortfall, 6)
    assert.equal(finalState.grants[0]?.remaining, 4)
    assert.equal(read.adjustments[0]?.shortfall, 6)
    assert.equal(read.adjustments[0]?.settled, 0)
  })

  it('B 先提交 4 时，A 重算只再补收 2，合计仍是 6', () => {
    const read = snapshot(0, 7, 0)
    const afterB = applyCommittedGuard(read, claimFor(read, 'gen-b', 4))
    assert.ok(afterB)
    assert.equal(afterB.adjustments[0]?.settled, 4)
    assert.equal(afterB.adjustments[0]?.shortfall, 6)
    const replayA = planCreditReturn({
      generationId: 'gen-a',
      nowMs: 1_000,
      consumeLines: [{ grantId: 'grant-1', quantity: 6 }],
      grants: [{
        grantId: 'grant-1',
        remaining: 0,
        granted: 10,
        status: revoked,
        expiresAtMs: null,
        policyRevoked: false,
      }],
      shortfalls: [{
        adjustmentId: 'adj-partial',
        grantId: 'grant-1',
        shortfall: 6,
        settled: 4,
        createdAtMs: 10,
      }],
    })
    if (!replayA.ok) assert.fail(replayA.reason)
    const grantA = totals(replayA)
    assert.equal(grantA.clawbackQuantity, 2)
    assert.equal(grantA.spendableQuantity, 4)
    assert.equal(grantA.nextRemaining, 4)
    assert.deepEqual(grantA.settlements, [{ adjustmentId: 'adj-partial', quantity: 2 }])
    const finalState = applyCommittedGuard(afterB, claimFor(afterB, 'gen-a', 6))
    assert.ok(finalState)
    assert.equal(finalState.adjustments[0]?.settled, 6)
    assert.equal(finalState.adjustments[0]?.shortfall, 6)
    assert.equal(finalState.grants[0]?.remaining, 4)
  })

  it('多 grant 的完整 clawback 流水按不同顺序仍能对账', () => {
    const facts = twoGrantClawbackFacts()
    assert.deepEqual(evaluateClawbackLinkage(facts), { ok: true })
    assert.deepEqual(evaluateClawbackLinkage({
      ...facts,
      clawbackLedgers: [...facts.clawbackLedgers].reverse(),
    }), { ok: true })
  })

  it('拒绝重复、缺失或无关的 clawback 流水', () => {
    const facts = twoGrantClawbackFacts()
    const [first, second] = facts.clawbackLedgers
    assert.ok(first)
    assert.ok(second)
    const cases = [
      { name: '重复 g1 不能掩盖缺失的 g2', ledgers: [first, first] },
      { name: '不同 grant 不能共享幂等键', ledgers: [first, { ...second, idempotencyKey: first.idempotencyKey }] },
      { name: '缺失 g2', ledgers: [first] },
      {
        name: '无关 g3 不能替代 g2',
        ledgers: [first, {
          ...second,
          grantId: 'grant-3',
          idempotencyKey: videoReturnClawbackTransactionKey(facts.generationId, 'grant-3'),
        }],
      },
    ]
    for (const testCase of cases) {
      assert.deepEqual(evaluateClawbackLinkage({
        ...facts,
        clawbackLedgers: testCase.ledgers,
      }), { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'ledger_mismatch' }, testCase.name)
    }
  })

  it('结算合计、grant 和 clawback 流水必须互相吻合', () => {
    assert.equal(evaluateClawbackLinkage({
      generationId: 'gen-a',
      operationClawback: 6,
      settlements: [{ adjustmentId: 'adj-partial', grantId: 'grant-1', quantity: 6 }],
      adjustments: [{ adjustmentId: 'adj-partial', grantId: 'grant-1', shortfall: 6 }],
      settledByAdjustment: [{ adjustmentId: 'adj-partial', settled: 6 }],
      clawbackLedgers: [{
        grantId: 'grant-1',
        quantity: -6,
        sourceType: 'video_generation_return_clawback',
        sourceId: 'gen-a',
        idempotencyKey: videoReturnClawbackTransactionKey('gen-a', 'grant-1'),
      }],
    }).ok, true)

    assert.equal(abortReason(evaluateClawbackLinkage({
      generationId: 'gen-a',
      operationClawback: 10,
      settlements: [
        { adjustmentId: 'adj-partial', grantId: 'grant-1', quantity: 6 },
        { adjustmentId: 'adj-partial', grantId: 'grant-1', quantity: 4 },
      ],
      adjustments: [{ adjustmentId: 'adj-partial', grantId: 'grant-1', shortfall: 6 }],
      settledByAdjustment: [{ adjustmentId: 'adj-partial', settled: 10 }],
      clawbackLedgers: [],
    })), 'settlement_exceeds_shortfall')

    assert.equal(abortReason(evaluateClawbackLinkage({
      generationId: 'gen-a',
      operationClawback: 4,
      settlements: [{ adjustmentId: 'adj-other', grantId: 'grant-1', quantity: 4 }],
      adjustments: [{ adjustmentId: 'adj-other', grantId: 'grant-2', shortfall: 4 }],
      settledByAdjustment: [{ adjustmentId: 'adj-other', settled: 4 }],
      clawbackLedgers: [],
    })), 'adjustment_grant_mismatch')

    const foreign = returnGuardClaim({
      snapshot: snapshot(0, 1, 0),
      grants: [{
        grantId: 'grant-1',
        expectedRemaining: 0,
        expectedStatus: revoked,
        nextRemaining: 0,
        nextStatus: revoked,
        settlements: [{ adjustmentId: 'missing', quantity: 4 }],
      }],
    })
    assert.equal(foreign.ok, false)
  })
})

describe('失败与成功落账', () => {
  it('最新版本不能授权 succeeded 变成 failed', () => {
    const decision = evaluateTerminalGuard({
      currentStatus: 'succeeded',
      currentVersion: 7,
      expectedVersion: 7,
      event: 'provider_failed',
      attemptLeaseHeld: true,
      outboxLeaseHeld: true,
      deadlineAtMs: 1,
      nowMs: 2,
    })
    assert.deepEqual(decision, { ok: false, failure: GUARD_CONFLICT_FAILURE, reason: 'illegal_transition' })
  })

  it('合法失败要求原状态、事件和对应 lease，丢失 lease 时中止', () => {
    const posted = evaluateTerminalGuard({
      currentStatus: 'processing',
      currentVersion: 4,
      expectedVersion: 4,
      event: 'provider_failed',
      attemptLeaseHeld: true,
      outboxLeaseHeld: false,
      deadlineAtMs: null,
      nowMs: 1,
    })
    assert.deepEqual(posted, { ok: true, toStatus: 'failed', nextVersion: 5, creditReturn: true })

    const lostLease = evaluateTerminalGuard({
      currentStatus: 'processing',
      currentVersion: 4,
      expectedVersion: 4,
      event: 'provider_failed',
      attemptLeaseHeld: false,
      outboxLeaseHeld: false,
      deadlineAtMs: null,
      nowMs: 1,
    })
    assert.equal(lostLease.ok, false)
    if (lostLease.ok) return
    assert.equal(lostLease.failure, GUARD_CONFLICT_FAILURE)
    assert.equal(lostLease.reason, 'lease_not_held')
  })

  it('成功只从 storing 加 output_stored 进入，且不返还积分', () => {
    const posted = evaluateTerminalGuard({
      currentStatus: 'storing',
      currentVersion: 5,
      expectedVersion: 5,
      event: 'output_stored',
      attemptLeaseHeld: true,
      outboxLeaseHeld: true,
      deadlineAtMs: null,
      nowMs: 1,
    })
    assert.deepEqual(posted, { ok: true, toStatus: 'succeeded', nextVersion: 6, creditReturn: false })

    const stale = evaluateTerminalGuard({
      currentStatus: 'storing',
      currentVersion: 6,
      expectedVersion: 5,
      event: 'output_stored',
      attemptLeaseHeld: true,
      outboxLeaseHeld: true,
      deadlineAtMs: null,
      nowMs: 1,
    })
    assert.equal(abortReason(stale), 'stale_version')

    const noStoreLease = evaluateTerminalGuard({
      currentStatus: 'storing',
      currentVersion: 5,
      expectedVersion: 5,
      event: 'storage_irrecoverable',
      attemptLeaseHeld: true,
      outboxLeaseHeld: false,
      deadlineAtMs: null,
      nowMs: 1,
    })
    assert.equal(abortReason(noStoreLease), 'lease_not_held')
  })
})

describe('已知供应商成本', () => {
  it('known 0 和 unknown NULL 合法，空金额、小写和非字母币种非法', () => {
    assert.equal(providerCostRowAllowed({ costKind: 'estimated', amountMicros: 0, currency: 'USD' }), true)
    assert.equal(providerCostRowAllowed({ costKind: 'actual', amountMicros: 0, currency: 'EUR' }), true)
    assert.equal(providerCostRowAllowed({ costKind: 'unknown', amountMicros: null, currency: null }), true)
    const rejected = [
      { costKind: 'estimated' as const, amountMicros: null, currency: 'USD' },
      { costKind: 'estimated' as const, amountMicros: 0, currency: null },
      { costKind: 'actual' as const, amountMicros: null, currency: null },
      { costKind: 'actual' as const, amountMicros: -1, currency: 'USD' },
      { costKind: 'estimated' as const, amountMicros: 1.5, currency: 'USD' },
      { costKind: 'estimated' as const, amountMicros: 1, currency: 'usd' },
      { costKind: 'estimated' as const, amountMicros: 1, currency: 'US' },
      { costKind: 'estimated' as const, amountMicros: 1, currency: 'USDD' },
      { costKind: 'estimated' as const, amountMicros: 1, currency: 'US1' },
      { costKind: 'unknown' as const, amountMicros: 0, currency: null },
      { costKind: 'unknown' as const, amountMicros: null, currency: 'USD' },
    ]
    for (const row of rejected) assert.equal(providerCostRowAllowed(row), false, JSON.stringify(row))
  })
})
