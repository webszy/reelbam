import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { EntitlementSnapshotItem } from '../../../types/billing.ts'
import {
  buildAccountSummaryFromLocalRows,
  isEligibleLatestPurchaseOrder,
  isEligibleNextExpiryGrant,
  readCreditPackCreditsFromSnapshot,
  selectLatestPurchase,
  selectNextExpiry,
  type AccountSummaryGrantInput,
  type AccountSummaryOrderInput,
} from './account-summary.ts'

const OWNER_ID = 'user-owner'
const OTHER_ID = 'user-other'
const NOW = new Date('2026-08-13T12:00:00.000Z')

const PACK_5: EntitlementSnapshotItem = {
  entitlement_key: 'credits',
  entitlement_type: 'consumable',
  quantity: 5,
  grant_cadence: 'purchase',
  expiration_policy: 'fixed_duration',
  duration_days: 365,
}

const PACK_10: EntitlementSnapshotItem = {
  ...PACK_5,
  quantity: 10,
}

const PACK_30: EntitlementSnapshotItem = {
  ...PACK_5,
  quantity: 30,
}

function grant(
  overrides: Partial<AccountSummaryGrantInput> = {},
): AccountSummaryGrantInput {
  return {
    userId: OWNER_ID,
    entitlementKey: 'credits',
    entitlementType: 'consumable',
    status: 'active',
    remainingQuantity: 5,
    effectiveAt: new Date('2026-08-13T00:00:00.000Z'),
    expiresAt: new Date('2027-08-13T00:00:00.000Z'),
    ...overrides,
  }
}

function order(
  overrides: Partial<AccountSummaryOrderInput> = {},
): AccountSummaryOrderInput {
  return {
    userId: OWNER_ID,
    status: 'paid',
    amount: 899,
    currency: 'USD',
    priceCodeSnapshot: 'credit_pack_10_usd',
    entitlementSnapshot: [PACK_10],
    paidAt: new Date('2026-08-13T10:00:00.000Z'),
    createdAt: new Date('2026-08-13T09:00:00.000Z'),
    ...overrides,
  }
}

describe('readCreditPackCreditsFromSnapshot', () => {
  it('reads credited credits from valid 5/10/30 Credit Pack snapshots', () => {
    assert.deepEqual(readCreditPackCreditsFromSnapshot([PACK_5]), {
      ok: true,
      credits: 5,
    })
    assert.deepEqual(readCreditPackCreditsFromSnapshot([PACK_10]), {
      ok: true,
      credits: 10,
    })
    assert.deepEqual(readCreditPackCreditsFromSnapshot([PACK_30]), {
      ok: true,
      credits: 30,
    })
  })

  it('reads a JSON-string snapshot that contains one valid purchase item', () => {
    assert.deepEqual(
      readCreditPackCreditsFromSnapshot(JSON.stringify([PACK_10])),
      { ok: true, credits: 10 },
    )
  })

  it('rejects empty, non-array, and multi-item snapshots', () => {
    assert.deepEqual(readCreditPackCreditsFromSnapshot([]), { ok: false })
    assert.deepEqual(readCreditPackCreditsFromSnapshot(null), { ok: false })
    assert.deepEqual(readCreditPackCreditsFromSnapshot({}), { ok: false })
    assert.deepEqual(
      readCreditPackCreditsFromSnapshot([PACK_5, PACK_10]),
      { ok: false },
    )
  })

  it('rejects unsupported keys, types, cadences, and non-positive quantities', () => {
    assert.deepEqual(
      readCreditPackCreditsFromSnapshot([{
        ...PACK_10,
        entitlement_key: 'monitoring',
      }]),
      { ok: false },
    )
    assert.deepEqual(
      readCreditPackCreditsFromSnapshot([{
        ...PACK_10,
        entitlement_type: 'feature',
        quantity: null,
      }]),
      { ok: false },
    )
    assert.deepEqual(
      readCreditPackCreditsFromSnapshot([{
        ...PACK_10,
        grant_cadence: 'subscription',
      }]),
      { ok: false },
    )
    assert.deepEqual(
      readCreditPackCreditsFromSnapshot([{ ...PACK_10, quantity: 0 }]),
      { ok: false },
    )
    assert.deepEqual(
      readCreditPackCreditsFromSnapshot([{ ...PACK_10, quantity: -5 }]),
      { ok: false },
    )
    assert.deepEqual(
      readCreditPackCreditsFromSnapshot([{ ...PACK_10, quantity: 1.5 }]),
      { ok: false },
    )
    assert.deepEqual(
      readCreditPackCreditsFromSnapshot([{ ...PACK_10, quantity: null }]),
      { ok: false },
    )
  })
})

describe('selectNextExpiry', () => {
  it('returns the earliest eligible expiry and remaining credits', () => {
    const result = selectNextExpiry(
      [
        grant({ remainingQuantity: 3, expiresAt: new Date('2027-12-01T00:00:00.000Z') }),
        grant({ remainingQuantity: 5, expiresAt: new Date('2027-08-13T00:00:00.000Z') }),
      ],
      NOW,
      OWNER_ID,
    )
    assert.deepEqual(result, {
      credits: 5,
      expiresAt: '2027-08-13T00:00:00.000Z',
    })
  })

  it('sums remaining quantity when several grants share the earliest instant', () => {
    const sameExpiry = new Date('2027-08-13T00:00:00.000Z')
    const result = selectNextExpiry(
      [
        grant({ remainingQuantity: 2, expiresAt: sameExpiry }),
        grant({ remainingQuantity: 3, expiresAt: sameExpiry }),
        grant({ remainingQuantity: 9, expiresAt: new Date('2028-01-01T00:00:00.000Z') }),
      ],
      NOW,
      OWNER_ID,
    )
    assert.deepEqual(result, {
      credits: 5,
      expiresAt: '2027-08-13T00:00:00.000Z',
    })
  })

  it('returns null when no qualifying expiring grant exists', () => {
    assert.equal(selectNextExpiry([], NOW, OWNER_ID), null)
    assert.equal(
      selectNextExpiry([grant({ expiresAt: null })], NOW, OWNER_ID),
      null,
    )
  })

  it('excludes expired, future, inactive, zero, wrong-key, wrong-type, and other-user grants', () => {
    const excluded = [
      grant({ expiresAt: new Date('2026-08-12T00:00:00.000Z') }),
      grant({ effectiveAt: new Date('2026-08-14T00:00:00.000Z') }),
      grant({ status: 'expired' }),
      grant({ status: 'revoked' }),
      grant({ remainingQuantity: 0 }),
      grant({ remainingQuantity: null }),
      grant({ entitlementKey: 'monitoring' }),
      grant({ entitlementType: 'feature' }),
      grant({ userId: OTHER_ID }),
    ]
    for (const row of excluded) {
      assert.equal(isEligibleNextExpiryGrant(row, NOW, OWNER_ID), false)
    }
    assert.equal(selectNextExpiry(excluded, NOW, OWNER_ID), null)
  })
})

describe('selectLatestPurchase', () => {
  it('maps the newest paid Credit Pack from the immutable snapshot and local amount', () => {
    const result = selectLatestPurchase(
      [
        order({
          amount: 499,
          priceCodeSnapshot: 'credit_pack_5_usd',
          entitlementSnapshot: [PACK_5],
          paidAt: new Date('2026-07-01T00:00:00.000Z'),
        }),
        order({
          amount: 899,
          priceCodeSnapshot: 'credit_pack_10_usd',
          entitlementSnapshot: [PACK_10],
          paidAt: new Date('2026-08-13T00:00:00.000Z'),
        }),
      ],
      OWNER_ID,
    )
    assert.deepEqual(result, {
      ok: true,
      purchase: {
        credits: 10,
        amountCents: 899,
        currency: 'USD',
        paidAt: '2026-08-13T00:00:00.000Z',
      },
    })
  })

  it('breaks paidAt ties with createdAt descending', () => {
    const paidAt = new Date('2026-08-13T00:00:00.000Z')
    const result = selectLatestPurchase(
      [
        order({
          amount: 499,
          priceCodeSnapshot: 'credit_pack_5_usd',
          entitlementSnapshot: [PACK_5],
          paidAt,
          createdAt: new Date('2026-08-13T08:00:00.000Z'),
        }),
        order({
          amount: 1999,
          priceCodeSnapshot: 'credit_pack_30_usd',
          entitlementSnapshot: [PACK_30],
          paidAt,
          createdAt: new Date('2026-08-13T09:00:00.000Z'),
        }),
      ],
      OWNER_ID,
    )
    assert.deepEqual(result, {
      ok: true,
      purchase: {
        credits: 30,
        amountCents: 1999,
        currency: 'USD',
        paidAt: '2026-08-13T00:00:00.000Z',
      },
    })
  })

  it('returns null for an empty owner account', () => {
    assert.deepEqual(selectLatestPurchase([], OWNER_ID), {
      ok: true,
      purchase: null,
    })
  })

  it('excludes pending, failed, expired, refunded, and partially-refunded orders', () => {
    const excludedStatuses = [
      'pending',
      'failed',
      'expired',
      'refunded',
      'partially_refunded',
    ] as const
    for (const status of excludedStatuses) {
      const row = order({ status })
      assert.equal(isEligibleLatestPurchaseOrder(row, OWNER_ID), false)
      assert.deepEqual(selectLatestPurchase([row], OWNER_ID), {
        ok: true,
        purchase: null,
      })
    }
  })

  it('excludes other-user orders and missing paidAt', () => {
    assert.equal(
      isEligibleLatestPurchaseOrder(order({ userId: OTHER_ID }), OWNER_ID),
      false,
    )
    assert.equal(
      isEligibleLatestPurchaseOrder(order({ paidAt: null }), OWNER_ID),
      false,
    )
  })

  it('fails instead of falling back when the selected snapshot is invalid', () => {
    const result = selectLatestPurchase(
      [
        order({
          paidAt: new Date('2026-08-13T00:00:00.000Z'),
          entitlementSnapshot: [PACK_5, PACK_10],
        }),
        order({
          amount: 499,
          priceCodeSnapshot: 'credit_pack_5_usd',
          entitlementSnapshot: [PACK_5],
          paidAt: new Date('2026-07-01T00:00:00.000Z'),
        }),
      ],
      OWNER_ID,
    )
    assert.deepEqual(result, { ok: false })
  })

  it('fails when the selected paid order has no user-visible amount', () => {
    assert.deepEqual(
      selectLatestPurchase([order({ amount: 0 })], OWNER_ID),
      { ok: false },
    )
    assert.deepEqual(
      selectLatestPurchase([order({ currency: 'US' })], OWNER_ID),
      { ok: false },
    )
  })
})

describe('buildAccountSummaryFromLocalRows', () => {
  it('returns only owner-display facts and never raw order or provider fields', () => {
    const result = buildAccountSummaryFromLocalRows({
      grants: [grant()],
      orders: [order()],
      now: NOW,
      ownerUserId: OWNER_ID,
    })
    assert.equal(result.ok, true)
    if (!result.ok) {
      return
    }

    assert.deepEqual(result.data, {
      nextExpiry: {
        credits: 5,
        expiresAt: '2027-08-13T00:00:00.000Z',
      },
      latestPurchase: {
        credits: 10,
        amountCents: 899,
        currency: 'USD',
        paidAt: '2026-08-13T10:00:00.000Z',
      },
    })

    const serialized = JSON.stringify(result.data)
    for (const forbidden of [
      'orderId',
      'userId',
      'provider',
      'providerOrderId',
      'providerCheckoutId',
      'providerCheckoutUrl',
      'customerId',
      'entitlementSnapshot',
      'checkoutUrl',
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden)
    }
  })

  it('maps an empty owner account to successful null facts', () => {
    const result = buildAccountSummaryFromLocalRows({
      grants: [],
      orders: [],
      now: NOW,
      ownerUserId: OWNER_ID,
    })
    assert.deepEqual(result, {
      ok: true,
      data: {
        nextExpiry: null,
        latestPurchase: null,
      },
    })
  })

  it('uses the existing error code instead of fabricating a purchase', () => {
    const result = buildAccountSummaryFromLocalRows({
      grants: [],
      orders: [order({ entitlementSnapshot: [] })],
      now: NOW,
      ownerUserId: OWNER_ID,
    })
    assert.deepEqual(result, {
      ok: false,
      code: 'INTERNAL_ERROR',
    })
  })
})
