import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  GUARD_CONFLICT_FAILURE,
  evaluateConsumeGuard,
  evaluateSharedSettlementGuard,
  evaluateZeroConsumeFailure,
  planCreditConsumption,
  planCreditReturn,
  returnGuardClaim,
  returnSourceAllowed,
} from '../src/credits/contract.ts'
import type { ConsumeGrantRow, SharedGuardSnapshot, SpendableGrant } from '../src/credits/contract.ts'

function spendable(overrides: Partial<SpendableGrant> & Pick<SpendableGrant, 'id' | 'remaining'>): SpendableGrant {
  return {
    userId: 'user-1',
    entitlementKey: 'credits',
    entitlementType: 'consumable',
    sourceType: 'order',
    sourceId: 'order-1',
    granted: 20,
    status: 'active',
    effectiveAtMs: 0,
    expiresAtMs: null,
    createdAtMs: 1,
    ...overrides,
  }
}

function row(overrides: Partial<ConsumeGrantRow> & Pick<ConsumeGrantRow, 'id' | 'remaining'>): ConsumeGrantRow {
  return {
    userId: 'user-1',
    entitlementKey: 'credits',
    entitlementType: 'consumable',
    sourceType: 'order',
    sourceId: 'order-1',
    granted: 20,
    status: 'active',
    effectiveAtMs: 0,
    expiresAtMs: null,
    ...overrides,
  }
}

function abortReason(decision: { ok: true } | { ok: false, reason: string }): string {
  return decision.ok ? 'ok' : decision.reason
}

describe('消费提交守卫', () => {
  it('余额未变但状态已撤销时整批失败', () => {
    const decision = evaluateConsumeGuard({
      userId: 'user-1',
      nowMs: 1_000,
      lines: [{ grantId: 'grant-1', expectedRemaining: 6, quantity: 4 }],
      grants: [row({ id: 'grant-1', remaining: 6, status: 'revoked' })],
    })
    assert.equal(decision.ok, false)
    if (decision.ok) return
    assert.equal(decision.failure, GUARD_CONFLICT_FAILURE)
    assert.equal(decision.reason, 'grant_not_active')
  })

  it('归属、权益、有效期和来源进入同一失败裁决', () => {
    const line = { grantId: 'grant-1', expectedRemaining: 6, quantity: 2 }
    assert.equal(abortReason(evaluateConsumeGuard({
      userId: 'user-1',
      nowMs: 1_000,
      lines: [line],
      grants: [row({ id: 'grant-1', remaining: 6, userId: 'other' })],
    })), 'owner_mismatch')
    assert.equal(abortReason(evaluateConsumeGuard({
      userId: 'user-1',
      nowMs: 1_000,
      lines: [line],
      grants: [row({ id: 'grant-1', remaining: 6, entitlementKey: 'storage' })],
    })), 'entitlement_mismatch')
    assert.equal(abortReason(evaluateConsumeGuard({
      userId: 'user-1',
      nowMs: 1_000,
      lines: [line],
      grants: [row({ id: 'grant-1', remaining: 6, expiresAtMs: 1_000 })],
    })), 'outside_validity')
    assert.equal(abortReason(evaluateConsumeGuard({
      userId: 'user-1',
      nowMs: 1_000,
      lines: [line],
      grants: [row({ id: 'grant-1', remaining: 6, sourceType: 'gift' })],
    })), 'unsupported_source')
    assert.equal(evaluateConsumeGuard({
      userId: 'user-1',
      nowMs: 1_000,
      lines: [line],
      grants: [row({ id: 'grant-1', remaining: 6, sourceType: 'promotion', sourceId: 'promo-1' })],
    }).ok, true)
  })

  it('多 grant 中有一条撤销时不留下部分扣费', () => {
    const decision = evaluateConsumeGuard({
      userId: 'user-1',
      nowMs: 1_000,
      lines: [
        { grantId: 'order-grant', expectedRemaining: 4, quantity: 4 },
        { grantId: 'promo-grant', expectedRemaining: 6, quantity: 2 },
      ],
      grants: [
        row({ id: 'order-grant', remaining: 4, sourceType: 'order', sourceId: 'order-1' }),
        row({ id: 'promo-grant', remaining: 6, status: 'revoked', sourceType: 'promotion', sourceId: 'promo-1' }),
      ],
    })
    assert.equal(abortReason(decision), 'grant_not_active')
  })
})

describe('消费与返还的来源闭合', () => {
  it('扣费前拒绝不支持来源，不产生扣费行', () => {
    const result = planCreditConsumption({
      generationId: 'gen-1',
      userId: 'user-1',
      amount: 6,
      nowMs: 1_000,
      grants: [
        spendable({ id: 'order-grant', remaining: 10, sourceType: 'order', sourceId: 'order-1' }),
        spendable({ id: 'gift', remaining: 4, sourceType: 'gift', sourceId: 'gift-1' }),
      ],
    })
    assert.deepEqual(result, { ok: false, reason: 'unsupported_source' })
  })

  it('order 与 promotion 可以一起扣，返还只给 order 加版本围栏', () => {
    const planned = planCreditConsumption({
      generationId: 'gen-1',
      userId: 'user-1',
      amount: 10,
      nowMs: 1_000,
      grants: [
        spendable({ id: 'order-grant', remaining: 4, sourceType: 'order', sourceId: 'order-1', expiresAtMs: 2_000 }),
        spendable({ id: 'promo-grant', remaining: 6, sourceType: 'promotion', sourceId: 'promo-1', expiresAtMs: null, createdAtMs: 2 }),
      ],
    })
    if (!planned.ok) assert.fail(planned.reason)
    assert.deepEqual(planned.lines.map(line => [line.grantId, line.quantity]), [
      ['order-grant', 4],
      ['promo-grant', 6],
    ])

    const snapshot: SharedGuardSnapshot = {
      orders: [{ orderId: 'order-1', refundVersion: 2 }],
      grants: [
        {
          grantId: 'order-grant',
          userId: 'user-1',
          sourceType: 'order',
          sourceId: 'order-1',
          orderId: 'order-1',
          remaining: 0,
          status: 'active',
        },
        {
          grantId: 'promo-grant',
          userId: 'user-1',
          sourceType: 'promotion',
          sourceId: 'promo-1',
          orderId: null,
          remaining: 0,
          status: 'active',
        },
      ],
      adjustments: [],
    }
    const returned = planCreditReturn({
      generationId: 'gen-1',
      nowMs: 1_000,
      consumeLines: [
        { grantId: 'order-grant', quantity: 4 },
        { grantId: 'promo-grant', quantity: 6 },
      ],
      grants: [
        { grantId: 'order-grant', remaining: 0, granted: 4, status: 'active', expiresAtMs: null, policyRevoked: false },
        { grantId: 'promo-grant', remaining: 0, granted: 6, status: 'active', expiresAtMs: null, policyRevoked: false },
      ],
      shortfalls: [],
    })
    if (!returned.ok) assert.fail(returned.reason)
    const claim = returnGuardClaim({
      snapshot,
      grants: returned.grants.map(grant => ({
        grantId: grant.grantId,
        expectedRemaining: grant.expectedRemaining,
        expectedStatus: 'active' as const,
        nextRemaining: grant.nextRemaining,
        nextStatus: grant.nextStatus,
        settlements: grant.settlements,
      })),
    })
    if (!claim.ok) assert.fail(claim.reason)
    assert.deepEqual(claim.claim.orders, [{ orderId: 'order-1', expectedRefundVersion: 2 }])
    assert.equal(evaluateSharedSettlementGuard(snapshot, claim.claim).ok, true)
    assert.equal(returnSourceAllowed('promotion', true), true)
    assert.equal(returnSourceAllowed('gift', true), true)
    assert.equal(returnSourceAllowed('gift', false), false)
  })

  it('已消费的非 order 来源不会在返还时被拒绝', () => {
    const snapshot: SharedGuardSnapshot = {
      orders: [],
      grants: [{
        grantId: 'promo-grant',
        userId: 'user-1',
        sourceType: 'promotion',
        sourceId: 'promo-1',
        orderId: null,
        remaining: 0,
        status: 'active',
      }],
      adjustments: [],
    }
    const claim = returnGuardClaim({
      snapshot,
      grants: [{
        grantId: 'promo-grant',
        expectedRemaining: 0,
        expectedStatus: 'active',
        nextRemaining: 6,
        nextStatus: 'active',
        settlements: [],
      }],
    })
    if (!claim.ok) assert.fail(claim.reason)
    assert.deepEqual(claim.claim.orders, [])
    assert.equal(evaluateSharedSettlementGuard(snapshot, claim.claim).ok, true)
  })

  it('空 claim 仍然失败，不为非 order 伪造订单', () => {
    const empty = evaluateSharedSettlementGuard({ orders: [], grants: [], adjustments: [] }, {
      orders: [],
      grants: [],
      observations: [],
    })
    assert.equal(abortReason(empty), 'missing_order_fence')
    const fake = returnGuardClaim({
      snapshot: {
        orders: [{ orderId: 'fake', refundVersion: 0 }],
        grants: [{
          grantId: 'promo-grant',
          userId: 'user-1',
          sourceType: 'promotion',
          sourceId: 'promo-1',
          orderId: 'fake',
          remaining: 0,
          status: 'active',
        }],
        adjustments: [],
      },
      grants: [{
        grantId: 'promo-grant',
        expectedRemaining: 0,
        expectedStatus: 'active',
        nextRemaining: 1,
        nextStatus: 'active',
        settlements: [],
      }],
    })
    assert.equal(fake.ok, false)
  })
})

describe('零报价失败结算', () => {
  const terminal = {
    currentStatus: 'processing' as const,
    currentVersion: 3,
    expectedVersion: 3,
    event: 'provider_failed',
    attemptLeaseHeld: true,
    outboxLeaseHeld: false,
    deadlineAtMs: null,
    nowMs: 1_000,
  }

  it('真实零 consume operation 且没有消费流水时写出零 return，不写流水', () => {
    const decision = evaluateZeroConsumeFailure({
      generationId: 'gen-0',
      quotedCredits: 0,
      consumeOperation: {
        generationId: 'gen-0',
        operationType: 'consume',
        intendedQuantity: 0,
        spendableQuantity: 0,
        expiredQuantity: 0,
        clawbackQuantity: 0,
        forfeitedQuantity: 0,
      },
      consumeLedgerCount: 0,
      terminal,
    })
    if (!decision.ok) assert.fail(decision.reason)
    assert.equal(decision.returnOperation.intendedQuantity, 0)
    assert.equal(decision.returnOperation.ledger.length, 0)
    assert.deepEqual(decision.returnOperation.ledger, [])
  })

  it('缺少 operation、已有消费流水或报价不是 0 时失败', () => {
    assert.equal(abortReason(evaluateZeroConsumeFailure({
      generationId: 'gen-0',
      quotedCredits: 0,
      consumeOperation: null,
      consumeLedgerCount: 0,
      terminal,
    })), 'missing_consume_operation')
    assert.equal(abortReason(evaluateZeroConsumeFailure({
      generationId: 'gen-0',
      quotedCredits: 0,
      consumeOperation: {
        generationId: 'gen-0',
        operationType: 'consume',
        intendedQuantity: 0,
        spendableQuantity: 0,
        expiredQuantity: 0,
        clawbackQuantity: 0,
        forfeitedQuantity: 0,
      },
      consumeLedgerCount: 1,
      terminal,
    })), 'consume_ledger_present')
    assert.equal(abortReason(evaluateZeroConsumeFailure({
      generationId: 'gen-0',
      quotedCredits: 6,
      consumeOperation: {
        generationId: 'gen-0',
        operationType: 'consume',
        intendedQuantity: 0,
        spendableQuantity: 0,
        expiredQuantity: 0,
        clawbackQuantity: 0,
        forfeitedQuantity: 0,
      },
      consumeLedgerCount: 0,
      terminal,
    })), 'not_zero_consume')
  })

  it('零消费失败仍要求合法终态，不因空 grant 放行', () => {
    assert.equal(abortReason(evaluateZeroConsumeFailure({
      generationId: 'gen-0',
      quotedCredits: 0,
      consumeOperation: {
        generationId: 'gen-0',
        operationType: 'consume',
        intendedQuantity: 0,
        spendableQuantity: 0,
        expiredQuantity: 0,
        clawbackQuantity: 0,
        forfeitedQuantity: 0,
      },
      consumeLedgerCount: 0,
      terminal: { ...terminal, currentStatus: 'succeeded', event: 'provider_failed' },
    })), 'illegal_transition')
  })
})
