import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  canonicalizeGenerationInput,
  failureSettlementAllowed,
  hashCanonicalInput,
  parseCreditQuoteSnapshot,
  planCreditConsumption,
  planCreditReturn,
  videoConsumeOperationKey,
  videoConsumeTransactionKey,
  videoReturnOperationKey,
} from '../src/credits/contract.ts'
import type { GrantSettlementState, ShortfallBalance, SpendableGrant } from '../src/credits/contract.ts'

function grant(overrides: Partial<SpendableGrant> & Pick<SpendableGrant, 'id' | 'remaining'>): SpendableGrant {
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

function state(overrides: Partial<GrantSettlementState> & Pick<GrantSettlementState, 'grantId' | 'remaining' | 'granted'>): GrantSettlementState {
  return {
    status: 'active',
    expiresAtMs: null,
    policyRevoked: false,
    ...overrides,
  }
}

describe('原子消费计划', () => {
  const nowMs = 1_000

  it('按最近到期优先，空到期排在最后，并跨 grant 拆分', () => {
    const result = planCreditConsumption({
      generationId: 'gen-1',
      userId: 'user-1',
      amount: 6,
      nowMs,
      grants: [
        grant({ id: 'a', remaining: 2, expiresAtMs: 3_000, createdAtMs: 1 }),
        grant({ id: 'b', remaining: 5, expiresAtMs: null, createdAtMs: 1 }),
        grant({ id: 'c', remaining: 3, expiresAtMs: 2_000, createdAtMs: 1 }),
        grant({ id: 'd', remaining: 4, expiresAtMs: 2_000, createdAtMs: 2 }),
        grant({ id: 'future', remaining: 9, effectiveAtMs: 5_000 }),
        grant({ id: 'closed', remaining: 9, status: 'expired', expiresAtMs: 2_000 }),
      ],
    })
    if (!result.ok) assert.fail(result.reason)
    assert.deepEqual(result.lines.map(line => [line.grantId, line.quantity, line.expectedRemaining]), [
      ['c', 3, 3],
      ['d', 3, 4],
    ])
    assert.equal(result.lines[0]?.ledger.quantity, -3)
    assert.equal(result.lines[0]?.ledger.balanceBefore, 3)
    assert.equal(result.lines[0]?.ledger.balanceAfter, 0)
    assert.equal(result.lines[0]?.ledger.idempotencyKey, videoConsumeTransactionKey('gen-1', 'c'))
    assert.equal(result.lines[0]?.ledger.sourceType, 'video_generation')
  })

  it('余额不足时不产生部分扣费', () => {
    const result = planCreditConsumption({
      generationId: 'gen-1',
      userId: 'user-1',
      amount: 20,
      nowMs,
      grants: [grant({ id: 'a', remaining: 14, expiresAtMs: 2_000 })],
    })
    assert.deepEqual(result, { ok: false, reason: 'insufficient_credits' })
  })

  it('0 积分返回空批次；非法 grant 与金额被拒绝', () => {
    const zero = planCreditConsumption({
      generationId: 'gen-1',
      userId: 'user-1',
      amount: 0,
      nowMs,
      grants: [grant({ id: 'a', remaining: 4 })],
    })
    if (!zero.ok) assert.fail(zero.reason)
    assert.deepEqual(zero.lines, [])

    assert.equal(planCreditConsumption({
      generationId: 'gen-1',
      userId: 'user-1',
      amount: 1.5,
      nowMs,
      grants: [],
    }).ok, false)
    assert.equal(planCreditConsumption({
      generationId: 'gen-1',
      userId: 'user-1',
      amount: 1,
      nowMs,
      grants: [grant({ id: 'a', remaining: 1 }), grant({ id: 'a', remaining: 1 })],
    }).ok, false)
    assert.equal(planCreditConsumption({
      generationId: 'gen-1',
      userId: 'user-1',
      amount: 1,
      nowMs,
      grants: [grant({ id: 'a', remaining: -1 })],
    }).ok, false)
  })
})

describe('失败返还计划', () => {
  const nowMs = 1_000

  it('全额现金退款后的 6 积分返还全部补收，可消费余额保持 0', () => {
    const shortfall: ShortfallBalance = {
      adjustmentId: 'adj-full',
      grantId: 'grant-1',
      shortfall: 6,
      settled: 0,
      createdAtMs: 10,
    }
    const result = planCreditReturn({
      generationId: 'gen-1',
      nowMs,
      consumeLines: [{ grantId: 'grant-1', quantity: 6 }],
      grants: [state({ grantId: 'grant-1', remaining: 0, granted: 10, status: 'revoked' })],
      shortfalls: [shortfall],
    })
    if (!result.ok) assert.fail(result.reason)
    const planned = result.grants[0]
    assert.ok(planned)
    assert.equal(planned.clawbackQuantity, 6)
    assert.equal(planned.spendableQuantity, 0)
    assert.equal(planned.expiredQuantity, 0)
    assert.equal(planned.forfeitedQuantity, 0)
    assert.equal(planned.sweepQuantity, 0)
    assert.equal(planned.nextRemaining, 0)
    assert.equal(planned.nextStatus, 'revoked')
    assert.deepEqual(planned.settlements, [{ adjustmentId: 'adj-full', quantity: 6 }])
    assert.deepEqual(planned.ledger.map(line => [line.transactionType, line.quantity, line.balanceBefore, line.balanceAfter]), [
      ['refund', 6, 0, 6],
      ['revoke', -6, 6, 0],
    ])
    assert.equal(result.totals.intended, 6)
    assert.equal(result.totals.clawback, 6)
    assert.equal(result.totals.spendable, 0)
    assert.equal(shortfall.settled, 0)
    assert.equal(shortfall.shortfall, 6)
  })

  it('部分现金退款只补收未回收额度，其余恢复为可消费', () => {
    const result = planCreditReturn({
      generationId: 'gen-1',
      nowMs,
      consumeLines: [{ grantId: 'grant-1', quantity: 6 }],
      grants: [state({ grantId: 'grant-1', remaining: 0, granted: 10, status: 'revoked' })],
      shortfalls: [{
        adjustmentId: 'adj-partial',
        grantId: 'grant-1',
        shortfall: 1,
        settled: 0,
        createdAtMs: 10,
      }],
    })
    if (!result.ok) assert.fail(result.reason)
    const planned = result.grants[0]
    assert.ok(planned)
    assert.equal(planned.clawbackQuantity, 1)
    assert.equal(planned.spendableQuantity, 5)
    assert.equal(planned.nextRemaining, 5)
    assert.equal(planned.nextStatus, 'active')
    assert.deepEqual(planned.settlements, [{ adjustmentId: 'adj-partial', quantity: 1 }])
  })

  it('多笔 shortfall 按创建时间再按调整 ID 补收', () => {
    const result = planCreditReturn({
      generationId: 'gen-1',
      nowMs,
      consumeLines: [{ grantId: 'grant-1', quantity: 6 }],
      grants: [state({ grantId: 'grant-1', remaining: 0, granted: 10, status: 'revoked' })],
      shortfalls: [
        { adjustmentId: 'adj-late', grantId: 'grant-1', shortfall: 4, settled: 0, createdAtMs: 20 },
        { adjustmentId: 'adj-early', grantId: 'grant-1', shortfall: 3, settled: 1, createdAtMs: 10 },
      ],
    })
    if (!result.ok) assert.fail(result.reason)
    assert.deepEqual(result.grants[0]?.settlements, [
      { adjustmentId: 'adj-early', quantity: 2 },
      { adjustmentId: 'adj-late', quantity: 4 },
    ])

    const tied = planCreditReturn({
      generationId: 'gen-1',
      nowMs,
      consumeLines: [{ grantId: 'grant-1', quantity: 3 }],
      grants: [state({ grantId: 'grant-1', remaining: 0, granted: 10, status: 'revoked' })],
      shortfalls: [
        { adjustmentId: 'b', grantId: 'grant-1', shortfall: 2, settled: 0, createdAtMs: 10 },
        { adjustmentId: 'a', grantId: 'grant-1', shortfall: 2, settled: 0, createdAtMs: 10 },
      ],
    })
    if (!tied.ok) assert.fail(tied.reason)
    assert.deepEqual(tied.grants[0]?.settlements, [
      { adjustmentId: 'a', quantity: 2 },
      { adjustmentId: 'b', quantity: 1 },
    ])
  })

  it('到期后返还清掉本次返还和该 grant 上已有剩余', () => {
    const result = planCreditReturn({
      generationId: 'gen-1',
      nowMs,
      consumeLines: [{ grantId: 'grant-1', quantity: 6 }],
      grants: [state({
        grantId: 'grant-1',
        remaining: 4,
        granted: 10,
        status: 'active',
        expiresAtMs: 500,
      })],
      shortfalls: [],
    })
    if (!result.ok) assert.fail(result.reason)
    const planned = result.grants[0]
    assert.ok(planned)
    assert.equal(planned.expiredQuantity, 6)
    assert.equal(planned.sweepQuantity, 4)
    assert.equal(planned.spendableQuantity, 0)
    assert.equal(planned.nextRemaining, 0)
    assert.equal(planned.nextStatus, 'expired')
    assert.equal(result.totals.expired, 6)
    assert.deepEqual(planned.ledger.map(line => [line.transactionType, line.quantity]), [
      ['refund', 6],
      ['expire', -10],
    ])
  })

  it('政策撤销只作废本次应返还部分，不没收无关剩余', () => {
    const result = planCreditReturn({
      generationId: 'gen-1',
      nowMs,
      consumeLines: [{ grantId: 'grant-1', quantity: 6 }],
      grants: [state({
        grantId: 'grant-1',
        remaining: 4,
        granted: 10,
        status: 'revoked',
        policyRevoked: true,
        expiresAtMs: 500,
      })],
      shortfalls: [],
    })
    if (!result.ok) assert.fail(result.reason)
    const planned = result.grants[0]
    assert.ok(planned)
    assert.equal(planned.forfeitedQuantity, 6)
    assert.equal(planned.sweepQuantity, 0)
    assert.equal(planned.expiredQuantity, 0)
    assert.equal(planned.spendableQuantity, 0)
    assert.equal(planned.nextRemaining, 4)
    assert.equal(planned.nextStatus, 'revoked')
  })

  it('返还后超过 granted、重复或缺 grant、损坏 shortfall 都拒绝', () => {
    assert.equal(planCreditReturn({
      generationId: 'gen-1',
      nowMs,
      consumeLines: [{ grantId: 'grant-1', quantity: 6 }],
      grants: [state({ grantId: 'grant-1', remaining: 5, granted: 10 })],
      shortfalls: [],
    }).ok, false)
    assert.equal(planCreditReturn({
      generationId: 'gen-1',
      nowMs,
      consumeLines: [
        { grantId: 'grant-1', quantity: 1 },
        { grantId: 'grant-1', quantity: 1 },
      ],
      grants: [state({ grantId: 'grant-1', remaining: 0, granted: 10 })],
      shortfalls: [],
    }).ok, false)
    assert.equal(planCreditReturn({
      generationId: 'gen-1',
      nowMs,
      consumeLines: [{ grantId: 'missing', quantity: 1 }],
      grants: [],
      shortfalls: [],
    }).ok, false)
    assert.equal(planCreditReturn({
      generationId: 'gen-1',
      nowMs,
      consumeLines: [{ grantId: 'grant-1', quantity: 1 }],
      grants: [state({ grantId: 'grant-1', remaining: 0, granted: 10 })],
      shortfalls: [{
        adjustmentId: 'adj',
        grantId: 'grant-1',
        shortfall: 1,
        settled: 2,
        createdAtMs: 1,
      }],
    }).ok, false)
  })

  it('幂等键稳定，且只有 failed 允许失败结算', () => {
    assert.equal(videoConsumeOperationKey('gen-1'), 'video_credit:consume:gen-1')
    assert.equal(videoReturnOperationKey('gen-1'), 'video_credit:return:gen-1')
    assert.equal(failureSettlementAllowed('failed'), true)
    for (const status of ['queued', 'submitting', 'submission_unknown', 'processing', 'storing', 'succeeded', 'needs_review'] as const) {
      assert.equal(failureSettlementAllowed(status), false)
    }
  })
})

describe('输入快照与报价', () => {
  it('规范化输入排除报价和路由，可选参数改变哈希', () => {
    const input = {
      modelId: 'model-a',
      mode: 'text-to-video',
      prompt: 'a cat',
      parameters: { durationSeconds: 5, resolution: '720p' },
    }
    const canonical = canonicalizeGenerationInput(input)
    assert.equal(canonical, JSON.stringify({
      modelId: 'model-a',
      mode: 'text-to-video',
      parameters: { durationSeconds: 5, resolution: '720p' },
      prompt: 'a cat',
    }))
    assert.equal(hashCanonicalInput(input), createHash('sha256').update(canonical).digest('hex'))
    assert.equal(hashCanonicalInput(input), hashCanonicalInput(input))
    const withRatio = {
      ...input,
      parameters: { ...input.parameters, aspectRatio: '16:9' },
    }
    assert.notEqual(hashCanonicalInput(input), hashCanonicalInput(withRatio))
    const parsed = JSON.parse(canonical) as Record<string, unknown>
    assert.equal('quote' in parsed, false)
    assert.equal('route' in parsed, false)
  })

  it('报价快照拒绝未知字段和非积分单位', () => {
    assert.deepEqual(parseCreditQuoteSnapshot({
      schemaVersion: 1,
      creditAmount: 6,
      pricingRuleId: 'rule-1',
      pricingRuleRevision: 2,
      unit: 'credit',
    }), {
      schemaVersion: 1,
      creditAmount: 6,
      pricingRuleId: 'rule-1',
      pricingRuleRevision: 2,
      unit: 'credit',
    })
    assert.equal(parseCreditQuoteSnapshot({
      schemaVersion: 1,
      creditAmount: 6,
      pricingRuleId: 'rule-1',
      pricingRuleRevision: 2,
      unit: 'credit',
      clientPrice: 1,
    }), null)
    assert.equal(parseCreditQuoteSnapshot({
      schemaVersion: 1,
      creditAmount: 6,
      pricingRuleId: 'rule-1',
      pricingRuleRevision: 2,
      unit: 'usd',
    }), null)
  })
})
