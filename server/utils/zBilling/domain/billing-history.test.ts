import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BILLING_HISTORY_LIMIT,
  BILLING_HISTORY_MAX_PAGE,
  BILLING_HISTORY_PAGE_SIZE,
  BILLING_HISTORY_PROCESSOR_NAME,
  buildBillingHistoryCreditActivityPage,
  buildBillingHistoryFromLocalRows,
  buildBillingHistoryPagination,
  buildBillingHistoryPaymentsPage,
  creditActivityLabel,
  parseBillingHistoryQuery,
  toPaymentDisplayReference,
  type BillingHistoryActivityInput,
  type BillingHistoryAdjustmentInput,
  type BillingHistoryGrantInput,
  type BillingHistoryPaymentInput,
  type BillingHistoryRefundInput,
} from './billing-history.ts'

const OWNER_ID = 'user-owner'
const OTHER_ID = 'user-other'
const PAID_ORDER_ID = '11111111-2222-3333-4444-555555556666'
const PENDING_ORDER_ID = '11111111-2222-3333-4444-555555556667'
const FAILED_ORDER_ID = '11111111-2222-3333-4444-555555556668'
const REFUNDED_ORDER_ID = '11111111-2222-3333-4444-555555556669'

function payment(
  overrides: Partial<BillingHistoryPaymentInput> = {},
): BillingHistoryPaymentInput {
  return {
    id: PAID_ORDER_ID,
    userId: OWNER_ID,
    productName: '20 Credits',
    amount: 1499,
    currency: 'USD',
    status: 'paid',
    createdAt: new Date('2026-08-13T10:00:00.000Z'),
    paidAt: new Date('2026-08-13T10:01:00.000Z'),
    ...overrides,
  }
}

function grant(
  overrides: Partial<BillingHistoryGrantInput> = {},
): BillingHistoryGrantInput {
  return {
    userId: OWNER_ID,
    sourceType: 'order',
    sourceId: PAID_ORDER_ID,
    entitlementKey: 'credits',
    entitlementType: 'consumable',
    grantedQuantity: 20,
    remainingQuantity: 17,
    expiresAt: new Date('2027-08-13T10:01:00.000Z'),
    ...overrides,
  }
}

function refund(
  overrides: Partial<BillingHistoryRefundInput> = {},
): BillingHistoryRefundInput {
  return {
    orderId: REFUNDED_ORDER_ID,
    status: 'succeeded',
    amount: 1499,
    currency: 'USD',
    succeededAt: new Date('2026-08-14T12:00:00.000Z'),
    createdAt: new Date('2026-08-14T11:59:00.000Z'),
    ...overrides,
  }
}

function adjustment(
  overrides: Partial<BillingHistoryAdjustmentInput> = {},
): BillingHistoryAdjustmentInput {
  return {
    orderId: REFUNDED_ORDER_ID,
    appliedQuantity: 12,
    ...overrides,
  }
}

function activity(
  overrides: Partial<BillingHistoryActivityInput> = {},
): BillingHistoryActivityInput {
  return {
    id: 'txn-20-credits',
    userId: OWNER_ID,
    grantUserId: OWNER_ID,
    transactionType: 'grant',
    quantity: 20,
    balanceAfter: 20,
    createdAt: new Date('2026-08-13T10:05:00.000Z'),
    grantSourceType: 'order',
    grantExpiresAt: new Date('2027-08-13T10:05:00.000Z'),
    productName: '20 Credits',
    ...overrides,
  }
}

describe('creditActivityLabel', () => {
  it('uses the local product snapshot for order-backed grants', () => {
    assert.equal(
      creditActivityLabel({
        transactionType: 'grant',
        grantSourceType: 'order',
        productName: '20 Credits',
      }),
      'Purchased 20 Credits',
    )
  })

  it('uses a generic purchased label when the order name is missing', () => {
    assert.equal(
      creditActivityLabel({
        transactionType: 'grant',
        grantSourceType: 'order',
        productName: null,
      }),
      'Purchased credits',
    )
  })

  it('maps consume, refund, revoke, expire, and adjustment labels', () => {
    assert.equal(
      creditActivityLabel({
        transactionType: 'consume',
        grantSourceType: 'usage',
        productName: null,
      }),
      'Credits used',
    )
    assert.equal(
      creditActivityLabel({
        transactionType: 'refund',
        grantSourceType: 'refund',
        productName: null,
      }),
      'Credits refunded',
    )
    assert.equal(
      creditActivityLabel({
        transactionType: 'revoke',
        grantSourceType: 'refund',
        productName: null,
      }),
      'Credits reversed',
    )
    assert.equal(
      creditActivityLabel({
        transactionType: 'expire',
        grantSourceType: 'grant',
        productName: null,
      }),
      'Credits expired',
    )
    assert.equal(
      creditActivityLabel({
        transactionType: 'adjustment',
        grantSourceType: 'admin',
        productName: null,
      }),
      'Credit adjustment',
    )
  })

  it('uses a generic label for unknown source or type combinations', () => {
    assert.equal(
      creditActivityLabel({
        transactionType: 'grant',
        grantSourceType: 'promotion',
        productName: '20 Credits',
      }),
      'Credits added',
    )
    assert.equal(
      creditActivityLabel({
        transactionType: 'future_type',
        grantSourceType: 'future_source',
        productName: 'secret-id',
      }),
      'Credit activity',
    )
  })
})

describe('buildBillingHistoryFromLocalRows', () => {
  it('maps paid, pending, and failed local orders to display rows', () => {
    const result = buildBillingHistoryFromLocalRows({
      payments: [
        payment({ status: 'paid', createdAt: new Date('2026-08-13T10:00:00.000Z') }),
        payment({
          id: PENDING_ORDER_ID,
          status: 'pending',
          productName: '5 Credits',
          amount: 499,
          createdAt: new Date('2026-08-12T10:00:00.000Z'),
          paidAt: null,
        }),
        payment({
          id: FAILED_ORDER_ID,
          status: 'failed',
          productName: '50 Credits',
          amount: 2899,
          createdAt: new Date('2026-08-11T10:00:00.000Z'),
          paidAt: null,
        }),
      ],
      activities: [],
      ownerUserId: OWNER_ID,
    })

    assert.equal(result.ok, true)
    if (!result.ok) {
      return
    }
    assert.deepEqual(result.data.paymentHistory.map(row => row.status), [
      'paid',
      'pending',
      'failed',
    ])
    assert.deepEqual(result.data.paymentHistory[0], {
      date: '2026-08-13T10:00:00.000Z',
      product: '20 Credits',
      amountCents: 1499,
      currency: 'USD',
      status: 'paid',
      details: {
        reference: 'DC-55556666',
        product: '20 Credits',
        amountCents: 1499,
        currency: 'USD',
        status: 'paid',
        orderedAt: '2026-08-13T10:00:00.000Z',
        paidAt: '2026-08-13T10:01:00.000Z',
        processorName: BILLING_HISTORY_PROCESSOR_NAME,
        credits: { state: 'verifying' },
        refund: null,
      },
    })
    assert.equal(result.data.paymentHistory[1]?.details.credits.state, 'none')
    assert.equal(result.data.paymentHistory[2]?.details.credits.state, 'none')
  })

  it('maps signed credit changes, purchase wording, and nullable expiry', () => {
    const result = buildBillingHistoryFromLocalRows({
      payments: [],
      activities: [
        activity(),
        activity({
          transactionType: 'consume',
          quantity: -1,
          balanceAfter: 19,
          createdAt: new Date('2026-08-13T11:00:00.000Z'),
          grantSourceType: 'usage',
          productName: null,
        }),
        activity({
          transactionType: 'expire',
          quantity: -4,
          balanceAfter: 0,
          createdAt: new Date('2026-08-10T00:00:00.000Z'),
          grantExpiresAt: null,
          productName: null,
        }),
      ],
      ownerUserId: OWNER_ID,
    })

    assert.equal(result.ok, true)
    if (!result.ok) {
      return
    }
    assert.deepEqual(result.data.creditActivity, [
      {
        date: '2026-08-13T11:00:00.000Z',
        activity: 'Credits used',
        change: -1,
        balanceAfter: 19,
        expiresAt: '2027-08-13T10:05:00.000Z',
      },
      {
        date: '2026-08-13T10:05:00.000Z',
        activity: 'Purchased 20 Credits',
        change: 20,
        balanceAfter: 20,
        expiresAt: '2027-08-13T10:05:00.000Z',
      },
      {
        date: '2026-08-10T00:00:00.000Z',
        activity: 'Credits expired',
        change: -4,
        balanceAfter: 0,
        expiresAt: null,
      },
    ])
  })

  it('keeps at most five newest owner rows and excludes other users', () => {
    const payments = Array.from({ length: 6 }, (_, index) => payment({
      id: `11111111-2222-3333-4444-55555555000${index}`,
      productName: `Pack ${index}`,
      createdAt: new Date(Date.UTC(2026, 7, index + 1)),
    }))
    payments.push(payment({
      id: '11111111-2222-3333-4444-999999999999',
      userId: OTHER_ID,
      productName: 'Other User Pack',
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
    }))

    const activities = Array.from({ length: 6 }, (_, index) => activity({
      id: `txn-pack-${index}`,
      quantity: index + 1,
      balanceAfter: index + 1,
      createdAt: new Date(Date.UTC(2026, 7, index + 1)),
      productName: `Pack ${index}`,
    }))
    activities.push(activity({
      id: 'txn-other-user',
      userId: OTHER_ID,
      grantUserId: OTHER_ID,
      productName: 'Other User Credits',
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
    }))

    const result = buildBillingHistoryFromLocalRows({
      payments,
      activities,
      ownerUserId: OWNER_ID,
    })

    assert.equal(result.ok, true)
    if (!result.ok) {
      return
    }
    assert.equal(result.data.paymentHistory.length, BILLING_HISTORY_LIMIT)
    assert.equal(result.data.creditActivity.length, BILLING_HISTORY_LIMIT)
    assert.deepEqual(
      result.data.paymentHistory.map(row => row.product),
      ['Pack 5', 'Pack 4', 'Pack 3', 'Pack 2', 'Pack 1'],
    )
    assert.equal(
      result.data.paymentHistory.some(row => row.product === 'Other User Pack'),
      false,
    )
    assert.equal(
      result.data.creditActivity.some(row => row.activity.includes('Other User')),
      false,
    )
  })

  it('returns successful empty arrays when the owner has no history', () => {
    assert.deepEqual(
      buildBillingHistoryFromLocalRows({
        payments: [],
        activities: [],
        ownerUserId: OWNER_ID,
      }),
      {
        ok: true,
        data: {
          paymentHistory: [],
          creditActivity: [],
        },
      },
    )
  })

  it('fails instead of fabricating a row for invalid amount, currency, or date', () => {
    assert.deepEqual(
      buildBillingHistoryFromLocalRows({
        payments: [payment({ amount: 0 })],
        activities: [],
        ownerUserId: OWNER_ID,
      }),
      { ok: false, code: 'INTERNAL_ERROR' },
    )
    assert.deepEqual(
      buildBillingHistoryFromLocalRows({
        payments: [payment({ currency: 'US' })],
        activities: [],
        ownerUserId: OWNER_ID,
      }),
      { ok: false, code: 'INTERNAL_ERROR' },
    )
    assert.deepEqual(
      buildBillingHistoryFromLocalRows({
        payments: [payment({ createdAt: 'not-a-date' })],
        activities: [],
        ownerUserId: OWNER_ID,
      }),
      { ok: false, code: 'INTERNAL_ERROR' },
    )
    assert.deepEqual(
      buildBillingHistoryFromLocalRows({
        payments: [payment({ status: 'succeeded' })],
        activities: [],
        ownerUserId: OWNER_ID,
      }),
      { ok: false, code: 'INTERNAL_ERROR' },
    )
  })

  it('fails when a selected credit row has a non-integer change or balance', () => {
    assert.deepEqual(
      buildBillingHistoryFromLocalRows({
        payments: [],
        activities: [activity({ quantity: 1.5 })],
        ownerUserId: OWNER_ID,
      }),
      { ok: false, code: 'INTERNAL_ERROR' },
    )
    assert.deepEqual(
      buildBillingHistoryFromLocalRows({
        payments: [],
        activities: [activity({ balanceAfter: -1 })],
        ownerUserId: OWNER_ID,
      }),
      { ok: false, code: 'INTERNAL_ERROR' },
    )
  })

  it('does not expose identifiers, snapshots, or provider fields', () => {
    const result = buildBillingHistoryFromLocalRows({
      payments: [payment()],
      activities: [activity()],
      grants: [grant()],
      refunds: [refund({ orderId: PAID_ORDER_ID })],
      adjustments: [adjustment({ orderId: PAID_ORDER_ID })],
      ownerUserId: OWNER_ID,
    })
    assert.equal(result.ok, true)
    if (!result.ok) {
      return
    }

    const serialized = JSON.stringify(result.data)
    for (const forbidden of [
      PAID_ORDER_ID,
      OWNER_ID,
      OTHER_ID,
      'orderId',
      'userId',
      'grantId',
      'grantUserId',
      'sourceId',
      'provider',
      'providerOrderId',
      'providerCheckoutId',
      'providerCheckoutUrl',
      'customerId',
      'entitlementSnapshot',
      'idempotencyKey',
      'checkoutUrl',
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden)
    }
    assert.equal(
      result.data.paymentHistory[0]?.details.reference,
      toPaymentDisplayReference(PAID_ORDER_ID),
    )
    assert.equal(
      result.data.paymentHistory[0]?.details.processorName,
      BILLING_HISTORY_PROCESSOR_NAME,
    )
  })

  it('maps a paid order with an order-linked credits grant', () => {
    const result = buildBillingHistoryFromLocalRows({
      payments: [payment()],
      activities: [],
      grants: [grant()],
      ownerUserId: OWNER_ID,
    })
    assert.equal(result.ok, true)
    if (!result.ok) {
      return
    }
    assert.deepEqual(result.data.paymentHistory[0]?.details.credits, {
      state: 'recorded',
      added: 20,
      remaining: 17,
      expiresAt: '2027-08-13T10:01:00.000Z',
    })
  })

  it('maps a paid order without a valid grant as verifying', () => {
    const result = buildBillingHistoryFromLocalRows({
      payments: [payment()],
      activities: [],
      grants: [
        grant({
          entitlementKey: 'monitoring',
          entitlementType: 'feature',
          grantedQuantity: null,
          remainingQuantity: null,
        }),
        grant({
          userId: OTHER_ID,
          grantedQuantity: 20,
          remainingQuantity: 20,
        }),
        grant({
          sourceType: 'admin',
          sourceId: 'admin-1',
        }),
      ],
      ownerUserId: OWNER_ID,
    })
    assert.equal(result.ok, true)
    if (!result.ok) {
      return
    }
    assert.deepEqual(result.data.paymentHistory[0]?.details.credits, {
      state: 'verifying',
    })
  })

  it('does not display credited quantities for pending, failed, or expired orders', () => {
    const result = buildBillingHistoryFromLocalRows({
      payments: [
        payment({
          id: PENDING_ORDER_ID,
          status: 'pending',
          paidAt: null,
        }),
        payment({
          id: FAILED_ORDER_ID,
          status: 'failed',
          createdAt: new Date('2026-08-12T10:00:00.000Z'),
          paidAt: null,
        }),
        payment({
          id: '11111111-2222-3333-4444-555555556670',
          status: 'expired',
          createdAt: new Date('2026-08-11T10:00:00.000Z'),
          paidAt: null,
        }),
      ],
      activities: [],
      grants: [
        grant({ sourceId: PENDING_ORDER_ID }),
        grant({ sourceId: FAILED_ORDER_ID }),
        grant({ sourceId: '11111111-2222-3333-4444-555555556670' }),
      ],
      ownerUserId: OWNER_ID,
    })
    assert.equal(result.ok, true)
    if (!result.ok) {
      return
    }
    assert.deepEqual(
      result.data.paymentHistory.map(row => row.details.credits),
      [
        { state: 'none' },
        { state: 'none' },
        { state: 'none' },
      ],
    )
  })

  it('maps a refunded order from successful local refund and applied quantities', () => {
    const result = buildBillingHistoryFromLocalRows({
      payments: [payment({
        id: REFUNDED_ORDER_ID,
        status: 'refunded',
      })],
      activities: [],
      grants: [grant({ sourceId: REFUNDED_ORDER_ID })],
      refunds: [refund()],
      adjustments: [adjustment()],
      ownerUserId: OWNER_ID,
    })
    assert.equal(result.ok, true)
    if (!result.ok) {
      return
    }
    assert.deepEqual(result.data.paymentHistory[0]?.details.credits, {
      state: 'none',
    })
    assert.deepEqual(result.data.paymentHistory[0]?.details.refund, {
      amountCents: 1499,
      currency: 'USD',
      refundedAt: '2026-08-14T12:00:00.000Z',
      reversedCredits: 12,
    })
  })

  it('maps a refunded order without adjustments as a refund with no reversal quantity', () => {
    const result = buildBillingHistoryFromLocalRows({
      payments: [payment({
        id: REFUNDED_ORDER_ID,
        status: 'refunded',
      })],
      activities: [],
      refunds: [refund()],
      ownerUserId: OWNER_ID,
    })
    assert.equal(result.ok, true)
    if (!result.ok) {
      return
    }
    assert.deepEqual(result.data.paymentHistory[0]?.details.refund, {
      amountCents: 1499,
      currency: 'USD',
      refundedAt: '2026-08-14T12:00:00.000Z',
      reversedCredits: null,
    })
  })

  it('ignores pending refunds and does not infer a reversal from refund amount', () => {
    const result = buildBillingHistoryFromLocalRows({
      payments: [payment({
        id: REFUNDED_ORDER_ID,
        status: 'refunded',
      })],
      activities: [],
      refunds: [refund({
        status: 'pending',
        succeededAt: null,
      })],
      ownerUserId: OWNER_ID,
    })
    assert.equal(result.ok, true)
    if (!result.ok) {
      return
    }
    assert.equal(result.data.paymentHistory[0]?.details.refund, null)
  })

  it('fails when a matching credits grant has corrupt quantities', () => {
    assert.deepEqual(
      buildBillingHistoryFromLocalRows({
        payments: [payment()],
        activities: [],
        grants: [grant({ remainingQuantity: 21 })],
        ownerUserId: OWNER_ID,
      }),
      { ok: false, code: 'INTERNAL_ERROR' },
    )
  })
})

describe('parseBillingHistoryQuery', () => {
  it('treats a missing query as preview mode', () => {
    assert.deepEqual(parseBillingHistoryQuery(undefined), { mode: 'preview' })
    assert.deepEqual(parseBillingHistoryQuery({}), { mode: 'preview' })
  })

  it('accepts the two approved page kinds with a bounded page', () => {
    assert.deepEqual(
      parseBillingHistoryQuery({ kind: 'payments', page: '1' }),
      { mode: 'page', kind: 'payments', page: 1 },
    )
    assert.deepEqual(
      parseBillingHistoryQuery({ kind: 'credit-activity', page: BILLING_HISTORY_MAX_PAGE }),
      { mode: 'page', kind: 'credit-activity', page: BILLING_HISTORY_MAX_PAGE },
    )
  })

  it('rejects malformed, repeated, mixed, or out-of-range page queries', () => {
    const invalid = { mode: 'invalid', code: 'INVALID_HISTORY_QUERY' } as const
    assert.deepEqual(parseBillingHistoryQuery({ kind: 'payments' }), invalid)
    assert.deepEqual(parseBillingHistoryQuery({ page: '1' }), invalid)
    assert.deepEqual(parseBillingHistoryQuery({ kind: 'refunds', page: '1' }), invalid)
    assert.deepEqual(parseBillingHistoryQuery({ kind: ['payments'], page: '1' }), invalid)
    assert.deepEqual(parseBillingHistoryQuery({ kind: 'payments', page: ['1', '2'] }), invalid)
    assert.deepEqual(parseBillingHistoryQuery({ kind: 'payments', page: '0' }), invalid)
    assert.deepEqual(parseBillingHistoryQuery({ kind: 'payments', page: '01' }), invalid)
    assert.deepEqual(parseBillingHistoryQuery({ kind: 'payments', page: '1.5' }), invalid)
    assert.deepEqual(
      parseBillingHistoryQuery({
        kind: 'payments',
        page: String(BILLING_HISTORY_MAX_PAGE + 1),
      }),
      invalid,
    )
  })
})

describe('buildBillingHistoryPaymentsPage', () => {
  it('maps 20 selected owner rows without truncating to the preview cap', () => {
    const payments = Array.from({ length: 21 }, (_, index) => payment({
      id: `11111111-2222-3333-4444-55555555${String(index).padStart(4, '0')}`,
      productName: `Pack ${index}`,
      createdAt: new Date(Date.UTC(2026, 7, 1, 0, index)),
    }))

    const preview = buildBillingHistoryFromLocalRows({
      payments,
      activities: [],
      ownerUserId: OWNER_ID,
    })
    assert.equal(preview.ok, true)
    if (!preview.ok) {
      return
    }
    assert.equal(preview.data.paymentHistory.length, BILLING_HISTORY_LIMIT)

    const page = buildBillingHistoryPaymentsPage({
      payments,
      ownerUserId: OWNER_ID,
      page: 1,
      total: 21,
    })
    assert.equal(page.ok, true)
    if (!page.ok) {
      return
    }
    assert.equal(page.data.kind, 'payments')
    assert.equal(page.data.items.length, BILLING_HISTORY_PAGE_SIZE)
    assert.deepEqual(page.data.pagination, {
      page: 1,
      pageSize: BILLING_HISTORY_PAGE_SIZE,
      total: 21,
      totalPages: 2,
    })
    assert.equal(
      page.data.items.some(row => row.product === 'Pack 0'),
      false,
    )
  })

  it('keeps same-timestamp rows deterministic by internal id without serializing it', () => {
    const createdAt = new Date('2026-08-13T10:00:00.000Z')
    const result = buildBillingHistoryPaymentsPage({
      payments: [
        payment({
          id: '11111111-2222-3333-4444-aaaaaaaaaaa1',
          productName: 'Older Id',
          createdAt,
        }),
        payment({
          id: '11111111-2222-3333-4444-aaaaaaaaaaa2',
          productName: 'Newer Id',
          createdAt,
        }),
      ],
      ownerUserId: OWNER_ID,
      page: 1,
      total: 2,
    })
    assert.equal(result.ok, true)
    if (!result.ok) {
      return
    }
    assert.deepEqual(
      result.data.items.map(row => row.product),
      ['Newer Id', 'Older Id'],
    )
    const serialized = JSON.stringify(result.data)
    assert.equal(serialized.includes('aaaaaaaaaaa1'), false)
    assert.equal(serialized.includes('aaaaaaaaaaa2'), false)
  })

  it('returns an empty page with truthful totals for an out-of-range page', () => {
    const result = buildBillingHistoryPaymentsPage({
      payments: [],
      ownerUserId: OWNER_ID,
      page: 3,
      total: 21,
    })
    assert.deepEqual(result, {
      ok: true,
      data: {
        kind: 'payments',
        items: [],
        pagination: {
          page: 3,
          pageSize: BILLING_HISTORY_PAGE_SIZE,
          total: 21,
          totalPages: 2,
        },
      },
    })
  })

  it('excludes other-user rows from a selected payment page', () => {
    const result = buildBillingHistoryPaymentsPage({
      payments: [
        payment(),
        payment({
          id: '11111111-2222-3333-4444-999999999999',
          userId: OTHER_ID,
          productName: 'Other User Pack',
        }),
      ],
      ownerUserId: OWNER_ID,
      page: 1,
      total: 1,
    })
    assert.equal(result.ok, true)
    if (!result.ok) {
      return
    }
    assert.deepEqual(
      result.data.items.map(row => row.product),
      ['20 Credits'],
    )
  })
})

describe('buildBillingHistoryCreditActivityPage', () => {
  it('maps a selected credit-activity page and does not mix payment fields', () => {
    const result = buildBillingHistoryCreditActivityPage({
      activities: Array.from({ length: 21 }, (_, index) => activity({
        id: `txn-${index}`,
        quantity: index + 1,
        balanceAfter: index + 1,
        createdAt: new Date(Date.UTC(2026, 7, 1, 0, index)),
        productName: `Pack ${index}`,
      })),
      ownerUserId: OWNER_ID,
      page: 1,
      total: 21,
    })
    assert.equal(result.ok, true)
    if (!result.ok) {
      return
    }
    assert.equal(result.data.kind, 'credit-activity')
    assert.equal(result.data.items.length, BILLING_HISTORY_PAGE_SIZE)
    assert.equal('paymentHistory' in result.data, false)
    assert.equal(
      JSON.stringify(result.data).includes('txn-'),
      false,
    )
  })
})

describe('buildBillingHistoryPagination', () => {
  it('uses the fixed page size and a zero page count when there are no rows', () => {
    assert.deepEqual(buildBillingHistoryPagination(0, 1), {
      page: 1,
      pageSize: BILLING_HISTORY_PAGE_SIZE,
      total: 0,
      totalPages: 0,
    })
  })
})
