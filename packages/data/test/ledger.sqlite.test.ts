import './webhook-globals.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { eq } from 'drizzle-orm'
import {
  consumeCreditsForGeneration,
  commitConsumePlan,
  planConsumeForGeneration,
  prepareConsumeCharge,
} from '../src/credits/consume.ts'
import {
  commitReturnPlan,
  planReturnForFailedGeneration,
  returnCreditsForFailedGeneration,
} from '../src/credits/return.ts'
import {
  getAvailableCredits,
  listChargeCandidates,
} from '../src/credits/spendable.ts'
import { reconcileGrantLedger } from '../src/credits/reconcile.ts'
import {
  videoConsumeOperationKey,
  videoReturnOperationKey,
} from '../src/credits/contract.ts'
import type { Database } from '../src/client.ts'
import {
  applyCheckoutCompleted,
  applyRefundCreated,
  buildExpectedOrderCreditFulfillment,
  buildOrderCreditGrantId,
  buildOrderCreditGrantTransactionIds,
  ensureOrderCreditFulfillment,
} from '../../../server/api/webhooks/creem.post.ts'
import {
  entitlementGrants,
  entitlementTransactions,
  insertCatalog,
  insertGrant,
  insertGrantTransaction,
  insertLeasedOutbox,
  insertOutputAsset,
  insertPaidOrder,
  insertQueuedGeneration,
  insertUser,
  openExistingLedgerDatabase,
  openLedgerDatabase,
  billingRefundCreditSettlements,
  videoCreditOperations,
  videoGenerations,
  type LedgerHandle,
} from './ledger-harness.ts'

const NOW_MS = Date.UTC(2026, 5, 1, 12, 0, 0)
const NOW = new Date(NOW_MS)
const USER = 'user-ledger'
const LEASE_OWNER = 'worker-1'
const LEASE_TOKEN = 'token-1'
const tempDirs: string[] = []

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createHandle(): LedgerHandle {
  const dir = mkdtempSync(join(tmpdir(), 'reelbam-ledger-'))
  tempDirs.push(dir)
  return openLedgerDatabase(join(dir, 'ledger.sqlite'))
}

async function seedWorld(database: Database, userId = USER) {
  await insertUser(database, userId, NOW)
  return insertCatalog(database, NOW)
}

async function seedOrderGrant(database: Database, input: {
  readonly orderId: string
  readonly grantId?: string
  readonly userId?: string
  readonly granted: number
  readonly remaining?: number
  readonly amount?: number
  readonly providerOrderId: string
  readonly productId: string
  readonly priceId: string
  readonly expiresAt?: Date | null
  readonly createdAt?: Date
}) {
  const userId = input.userId ?? USER
  const grantId = input.grantId ?? buildOrderCreditGrantId(input.orderId, 'credits')
  const txIds = buildOrderCreditGrantTransactionIds(input.orderId, 'credits')
  await insertPaidOrder(database, {
    id: input.orderId,
    userId,
    productId: input.productId,
    priceId: input.priceId,
    amount: input.amount ?? 1000,
    grantedQuantity: input.granted,
    providerOrderId: input.providerOrderId,
    now: NOW,
  })
  await insertGrant(database, {
    id: grantId,
    userId,
    sourceType: 'order',
    sourceId: input.orderId,
    granted: input.granted,
    remaining: input.remaining ?? input.granted,
    now: NOW,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  })
  await insertGrantTransaction(database, {
    id: txIds.id,
    userId,
    grantId,
    quantity: input.granted,
    sourceType: 'order',
    sourceId: input.orderId,
    idempotencyKey: txIds.idempotencyKey,
    now: new Date(NOW_MS - 60_000),
  })
  return { grantId, txIds }
}

async function seedGeneration(database: Database, id: string, credits: number, userId = USER) {
  await insertQueuedGeneration(database, { id, userId, credits, now: NOW })
  await insertLeasedOutbox(database, {
    id: `ob-${id}`,
    generationId: id,
    eventType: 'start_submission',
    now: NOW,
  })
}

async function charge(database: Database, generationId: string, amount: number, userId = USER) {
  return consumeCreditsForGeneration(database, {
    userId,
    generationId,
    creditAmount: amount,
    operationId: videoConsumeOperationKey(generationId),
    nowMs: NOW_MS,
  })
}

async function failGeneration(database: Database, generationId: string, userId = USER) {
  return returnCreditsForFailedGeneration(database, {
    userId,
    generationId,
    operationId: videoReturnOperationKey(generationId),
    event: 'deadline_reached',
    expectedVersion: 1,
    leaseOwner: LEASE_OWNER,
    leaseToken: LEASE_TOKEN,
    errorCode: 'deadline_reached',
    nowMs: NOW_MS,
  })
}

function cashRefund(database: Database, input: {
  readonly providerOrderId: string
  readonly providerRefundId: string
  readonly refundAmount: number
  readonly providerPaidAmount?: number
  readonly providerEventId?: string
}) {
  return applyRefundCreated(database as Parameters<typeof applyRefundCreated>[0], {
    kind: 'refund.created',
    providerEventId: input.providerEventId ?? `evt-${input.providerRefundId}`,
    eventType: 'refund.created',
    payloadHash: 'b'.repeat(64),
    refund: {
      providerRefundId: input.providerRefundId,
      status: 'succeeded',
      refundAmount: input.refundAmount,
      currency: 'USD',
      providerTransactionId: `txn-${input.providerRefundId}`,
      providerOrderId: input.providerOrderId,
      providerPaidAmount: input.providerPaidAmount ?? 1000,
      reasonCode: null,
    },
  })
}

async function remainingOf(database: Database, grantId: string): Promise<number> {
  const rows = await database.select().from(entitlementGrants).where(eq(entitlementGrants.id, grantId)).limit(1)
  return rows[0]?.remainingQuantity ?? -1
}

async function operations(database: Database, generationId: string) {
  return database.select().from(videoCreditOperations).where(eq(videoCreditOperations.generationId, generationId))
}

async function consumeTxs(database: Database, generationId: string) {
  return database.select().from(entitlementTransactions).where(eq(entitlementTransactions.sourceId, generationId))
}

function spawnWorker(data: unknown): Promise<{ ok: boolean, result?: unknown, error?: string }> {
  const alias = fileURLToPath(new URL('../../../scripts/alias-register.mjs', import.meta.url))
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./ledger-worker.ts', import.meta.url), {
      workerData: data,
      execArgv: ['--experimental-transform-types', '--import', alias],
    })
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error('ledger worker timeout'))
    }, 15_000)
    worker.once('message', (result) => { clearTimeout(timer); resolve(result) })
    worker.once('error', (error) => { clearTimeout(timer); reject(error) })
    worker.once('exit', (code) => {
      if (code !== 0) { clearTimeout(timer); reject(new Error(`ledger worker exited ${code}`)) }
    })
  })
}

describe('P2.3 sqlite ledger', () => {
  it('T01 single grant consume writes per-grant balances', async () => {
    const handle = createHandle()
    try {
      const catalog = await seedWorld(handle.database)
      const { grantId } = await seedOrderGrant(handle.database, {
        orderId: 'order-t01',
        granted: 10,
        providerOrderId: 'ord_t01',
        ...catalog,
      })
      await seedGeneration(handle.database, 'gen-t01', 6)
      const result = await charge(handle.database, 'gen-t01', 6)
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.replay, false)
      assert.equal(result.intendedQuantity, 6)
      assert.equal(result.lines.length, 1)
      assert.equal(result.lines[0]?.grantId, grantId)
      assert.equal(result.lines[0]?.quantity, 6)
      assert.equal(result.lines[0]?.balanceBefore, 10)
      assert.equal(result.lines[0]?.balanceAfter, 4)
      assert.equal(await remainingOf(handle.database, grantId), 4)
      assert.equal(await getAvailableCredits(handle.database, USER, NOW), 4)
      const txs = await consumeTxs(handle.database, 'gen-t01')
      const consume = txs.find(row => row.transactionType === 'consume')
      assert.equal(consume?.quantity, -6)
      assert.equal(consume?.balanceBefore, 10)
      assert.equal(consume?.balanceAfter, 4)
      const ops = await operations(handle.database, 'gen-t01')
      assert.equal(ops.length, 1)
      assert.equal(ops[0]?.status, 'completed')
    }
    finally {
      handle.close()
    }
  })

  it('T02 consumes earliest-expiry grants first and splits across grants', async () => {
    const handle = createHandle()
    try {
      const catalog = await seedWorld(handle.database)
      const soon = new Date(NOW_MS + 10 * 24 * 60 * 60 * 1000)
      const later = new Date(NOW_MS + 100 * 24 * 60 * 60 * 1000)
      const a = await seedOrderGrant(handle.database, {
        orderId: 'order-t02a',
        granted: 3,
        providerOrderId: 'ord_t02a',
        expiresAt: soon,
        createdAt: new Date(NOW_MS - 2_000),
        ...catalog,
      })
      const b = await seedOrderGrant(handle.database, {
        orderId: 'order-t02b',
        granted: 7,
        providerOrderId: 'ord_t02b',
        expiresAt: later,
        createdAt: new Date(NOW_MS - 1_000),
        ...catalog,
      })
      await seedGeneration(handle.database, 'gen-t02', 6)
      const result = await charge(handle.database, 'gen-t02', 6)
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.lines.length, 2)
      assert.equal(result.lines[0]?.grantId, a.grantId)
      assert.equal(result.lines[0]?.quantity, 3)
      assert.equal(result.lines[1]?.grantId, b.grantId)
      assert.equal(result.lines[1]?.quantity, 3)
      assert.equal(await remainingOf(handle.database, a.grantId), 0)
      assert.equal(await remainingOf(handle.database, b.grantId), 4)
      assert.equal(await getAvailableCredits(handle.database, USER, NOW), 4)
    }
    finally {
      handle.close()
    }
  })

  it('T03 insufficient balance leaves no rows', async () => {
    const handle = createHandle()
    try {
      const catalog = await seedWorld(handle.database)
      const { grantId } = await seedOrderGrant(handle.database, {
        orderId: 'order-t03',
        granted: 10,
        providerOrderId: 'ord_t03',
        ...catalog,
      })
      await seedGeneration(handle.database, 'gen-t03', 11)
      const result = await charge(handle.database, 'gen-t03', 11)
      assert.equal(result.ok, false)
      if (result.ok) return
      assert.equal(result.reason, 'insufficient_credits')
      assert.equal(await remainingOf(handle.database, grantId), 10)
      assert.equal((await operations(handle.database, 'gen-t03')).length, 0)
      assert.equal((await consumeTxs(handle.database, 'gen-t03')).length, 0)
    }
    finally {
      handle.close()
    }
  })

  it('T04 concurrent consume does not overdraft', async () => {
    const handle = createHandle()
    try {
    const catalog = await seedWorld(handle.database)
    const { grantId } = await seedOrderGrant(handle.database, {
      orderId: 'order-t04',
      granted: 10,
      providerOrderId: 'ord_t04',
      ...catalog,
    })
    await seedGeneration(handle.database, 'gen-t04a', 6)
    await seedGeneration(handle.database, 'gen-t04b', 6)
    const planA = await planConsumeForGeneration(handle.database, {
      userId: USER,
      generationId: 'gen-t04a',
      creditAmount: 6,
      operationId: videoConsumeOperationKey('gen-t04a'),
      nowMs: NOW_MS,
    })
    const planB = await planConsumeForGeneration(handle.database, {
      userId: USER,
      generationId: 'gen-t04b',
      creditAmount: 6,
      operationId: videoConsumeOperationKey('gen-t04b'),
      nowMs: NOW_MS,
    })
    assert.equal(planA.ok && planA.kind === 'charge', true)
    assert.equal(planB.ok && planB.kind === 'charge', true)
    if (!planA.ok || planA.kind !== 'charge' || !planB.ok || planB.kind !== 'charge') return
    const first = await commitConsumePlan(handle.database, planA.plan)
    const second = await commitConsumePlan(handle.database, planB.plan)
    assert.equal(first.ok, true)
    assert.equal(second.ok, false)
    if (second.ok) return
    assert.equal(second.reason, 'aborted')
    assert.equal(await remainingOf(handle.database, grantId), 4)
    assert.equal((await operations(handle.database, 'gen-t04a')).length, 1)
    assert.equal((await operations(handle.database, 'gen-t04b')).length, 0)
    }
    finally {
      handle.close()
    }

    const race = createHandle()
    try {
      const raceCatalog = await seedWorld(race.database)
      await seedOrderGrant(race.database, {
        orderId: 'order-t04w',
        granted: 10,
        providerOrderId: 'ord_t04w',
        ...raceCatalog,
      })
      await seedGeneration(race.database, 'gen-t04wa', 6)
      await seedGeneration(race.database, 'gen-t04wb', 6)
      const path = race.path
      race.close()
      const barrier = new SharedArrayBuffer(4)
      const [left, right] = await Promise.all([
        spawnWorker({
          kind: 'consume',
          path,
          userId: USER,
          generationId: 'gen-t04wa',
          creditAmount: 6,
          nowMs: NOW_MS,
          barrier,
        }),
        spawnWorker({
          kind: 'consume',
          path,
          userId: USER,
          generationId: 'gen-t04wb',
          creditAmount: 6,
          nowMs: NOW_MS,
          barrier,
        }),
      ])
      const after = openExistingLedgerDatabase(path)
      try {
        const grantRows = await after.database.select().from(entitlementGrants)
        const remaining = grantRows[0]?.remainingQuantity ?? -1
        assert.ok(remaining >= 0)
        assert.ok(remaining === 4)
        const successes = [left, right].filter(item => item.ok && (item.result as { ok?: boolean })?.ok)
        assert.equal(successes.length, 1)
      }
      finally {
        after.close()
      }
    }
    finally {
      // race handle already closed
    }
  })

  it('T05 same operation id charges once', async () => {
    const handle = createHandle()
    try {
      const catalog = await seedWorld(handle.database)
      const { grantId } = await seedOrderGrant(handle.database, {
        orderId: 'order-t05',
        granted: 10,
        providerOrderId: 'ord_t05',
        ...catalog,
      })
      await seedGeneration(handle.database, 'gen-t05', 6)
      const first = await charge(handle.database, 'gen-t05', 6)
      const second = await charge(handle.database, 'gen-t05', 6)
      assert.equal(first.ok, true)
      assert.equal(second.ok, true)
      if (!second.ok) return
      assert.equal(second.replay, true)
      assert.equal(await remainingOf(handle.database, grantId), 4)
      assert.equal((await operations(handle.database, 'gen-t05')).length, 1)
      assert.equal((await consumeTxs(handle.database, 'gen-t05')).filter(row => row.transactionType === 'consume').length, 1)
    }
    finally {
      handle.close()
    }
  })

  it('T06 same operation id with a different amount is refused', async () => {
    const handle = createHandle()
    try {
      const catalog = await seedWorld(handle.database)
      const { grantId } = await seedOrderGrant(handle.database, {
        orderId: 'order-t06',
        granted: 10,
        providerOrderId: 'ord_t06',
        ...catalog,
      })
      await seedGeneration(handle.database, 'gen-t06', 6)
      const first = await charge(handle.database, 'gen-t06', 6)
      const second = await charge(handle.database, 'gen-t06', 7)
      assert.equal(first.ok, true)
      assert.equal(second.ok, false)
      if (second.ok) return
      assert.equal(second.reason, 'amount_conflict')
      assert.equal(await remainingOf(handle.database, grantId), 4)
    }
    finally {
      handle.close()
    }
  })

  it('T07 failure return restores the original grant once', async () => {
    const handle = createHandle()
    try {
      const catalog = await seedWorld(handle.database)
      const { grantId } = await seedOrderGrant(handle.database, {
        orderId: 'order-t07',
        granted: 10,
        providerOrderId: 'ord_t07',
        ...catalog,
      })
      await seedGeneration(handle.database, 'gen-t07', 6)
      assert.equal((await charge(handle.database, 'gen-t07', 6)).ok, true)
      const first = await failGeneration(handle.database, 'gen-t07')
      const second = await failGeneration(handle.database, 'gen-t07')
      assert.equal(first.ok, true)
      assert.equal(second.ok, true)
      if (!first.ok || !second.ok) return
      assert.equal(first.replay, false)
      assert.equal(second.replay, true)
      assert.equal(first.spendableQuantity, 6)
      assert.equal(await remainingOf(handle.database, grantId), 10)
      assert.equal(await getAvailableCredits(handle.database, USER, NOW), 10)
      const generation = (await handle.database.select().from(videoGenerations).where(eq(videoGenerations.id, 'gen-t07')))[0]
      assert.equal(generation?.status, 'failed')
      assert.equal((await operations(handle.database, 'gen-t07')).filter(row => row.operationType === 'return').length, 1)
    }
    finally {
      handle.close()
    }
  })

  it('T08 a succeeded generation cannot be refunded by a late failure', async () => {
    const handle = createHandle()
    try {
      const catalog = await seedWorld(handle.database)
      const { grantId } = await seedOrderGrant(handle.database, {
        orderId: 'order-t08',
        granted: 10,
        providerOrderId: 'ord_t08',
        ...catalog,
      })
      await seedGeneration(handle.database, 'gen-t08', 6)
      assert.equal((await charge(handle.database, 'gen-t08', 6)).ok, true)
      await insertOutputAsset(handle.database, { id: 'asset-t08', userId: USER, now: NOW })
      await handle.database.update(videoGenerations).set({
        status: 'succeeded',
        outputAssetId: 'asset-t08',
        terminalAt: NOW,
        updatedAt: NOW,
      }).where(eq(videoGenerations.id, 'gen-t08'))
      const result = await failGeneration(handle.database, 'gen-t08')
      assert.equal(result.ok, false)
      if (result.ok) return
      assert.equal(result.reason, 'illegal_transition')
      assert.equal(await remainingOf(handle.database, grantId), 4)
      assert.equal((await operations(handle.database, 'gen-t08')).filter(row => row.operationType === 'return').length, 0)
    }
    finally {
      handle.close()
    }
  })

  it('T09 return after expiry does not restore spendable value', async () => {
    const handle = createHandle()
    try {
      const catalog = await seedWorld(handle.database)
      const { grantId } = await seedOrderGrant(handle.database, {
        orderId: 'order-t09',
        granted: 10,
        providerOrderId: 'ord_t09',
        ...catalog,
      })
      await seedGeneration(handle.database, 'gen-t09', 6)
      assert.equal((await charge(handle.database, 'gen-t09', 6)).ok, true)
      const originalExpiry = (await handle.database.select().from(entitlementGrants).where(eq(entitlementGrants.id, grantId)))[0]?.expiresAt
      await handle.database.update(entitlementGrants).set({
        expiresAt: new Date(NOW_MS - 1000),
        updatedAt: NOW,
      }).where(eq(entitlementGrants.id, grantId))
      const result = await failGeneration(handle.database, 'gen-t09')
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.expiredQuantity, 6)
      assert.equal(result.spendableQuantity, 0)
      assert.equal(await remainingOf(handle.database, grantId), 0)
      assert.equal(await getAvailableCredits(handle.database, USER, NOW), 0)
      const grant = (await handle.database.select().from(entitlementGrants).where(eq(entitlementGrants.id, grantId)))[0]
      assert.equal(grant?.status, 'expired')
      assert.equal(grant?.expiresAt?.getTime(), new Date(NOW_MS - 1000).getTime())
      assert.ok(originalExpiry)
      const expire = (await consumeTxs(handle.database, 'gen-t09')).find(row => row.transactionType === 'expire')
      assert.equal(expire?.quantity, -10)
    }
    finally {
      handle.close()
    }
  })

  it('T10 full cash refund then late video return keeps spendable at 0', async () => {
    const handle = createHandle()
    try {
      const catalog = await seedWorld(handle.database)
      const { grantId } = await seedOrderGrant(handle.database, {
        orderId: 'order-t10',
        granted: 10,
        providerOrderId: 'ord_t10',
        ...catalog,
      })
      await seedGeneration(handle.database, 'gen-t10', 6)
      assert.equal((await charge(handle.database, 'gen-t10', 6)).ok, true)
      const refund = await cashRefund(handle.database, {
        providerOrderId: 'ord_t10',
        providerRefundId: 'ref_t10',
        refundAmount: 1000,
      })
      assert.deepEqual(refund, { ok: true })
      assert.equal(await remainingOf(handle.database, grantId), 0)
      const result = await failGeneration(handle.database, 'gen-t10')
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.clawbackQuantity, 6)
      assert.equal(result.spendableQuantity, 0)
      assert.equal(await remainingOf(handle.database, grantId), 0)
      assert.equal(await getAvailableCredits(handle.database, USER, NOW), 0)
      const grant = (await handle.database.select().from(entitlementGrants).where(eq(entitlementGrants.id, grantId)))[0]
      assert.equal(grant?.status, 'revoked')
      const settled = await handle.database.select().from(billingRefundCreditSettlements)
      const settlementSum = settled.reduce((sum, row) => sum + row.quantity, 0)
      assert.equal(settlementSum, 6)
    }
    finally {
      handle.close()
    }
  })

  it('T11 partial cash refund across grants then failure return', async () => {
    const handle = createHandle()
    try {
      const catalog = await seedWorld(handle.database)
      const a = await seedOrderGrant(handle.database, {
        orderId: 'order-t11a',
        granted: 3,
        amount: 1000,
        providerOrderId: 'ord_t11a',
        expiresAt: new Date(NOW_MS + 10 * 24 * 60 * 60 * 1000),
        createdAt: new Date(NOW_MS - 2_000),
        ...catalog,
      })
      const b = await seedOrderGrant(handle.database, {
        orderId: 'order-t11b',
        granted: 7,
        amount: 1000,
        providerOrderId: 'ord_t11b',
        expiresAt: new Date(NOW_MS + 100 * 24 * 60 * 60 * 1000),
        createdAt: new Date(NOW_MS - 1_000),
        ...catalog,
      })
      await seedGeneration(handle.database, 'gen-t11', 6)
      assert.equal((await charge(handle.database, 'gen-t11', 6)).ok, true)
      assert.equal(await remainingOf(handle.database, a.grantId), 0)
      assert.equal(await remainingOf(handle.database, b.grantId), 4)
      assert.deepEqual(await cashRefund(handle.database, {
        providerOrderId: 'ord_t11a',
        providerRefundId: 'ref_t11a',
        refundAmount: 500,
      }), { ok: true })
      assert.deepEqual(await cashRefund(handle.database, {
        providerOrderId: 'ord_t11b',
        providerRefundId: 'ref_t11b',
        refundAmount: 500,
      }), { ok: true })
      const result = await failGeneration(handle.database, 'gen-t11')
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(await getAvailableCredits(handle.database, USER, NOW), 6)
      assert.equal(
        (await remainingOf(handle.database, a.grantId)) + (await remainingOf(handle.database, b.grantId)),
        6,
      )
    }
    finally {
      handle.close()
    }
  })

  it('T12 cash refund concurrent with video return ends at spendable 0', async () => {
    const handle = createHandle()
    try {
      const catalog = await seedWorld(handle.database)
      const { grantId } = await seedOrderGrant(handle.database, {
        orderId: 'order-t12',
        granted: 10,
        providerOrderId: 'ord_t12',
        ...catalog,
      })
      await seedGeneration(handle.database, 'gen-t12', 6)
      assert.equal((await charge(handle.database, 'gen-t12', 6)).ok, true)
      const planned = await planReturnForFailedGeneration(handle.database, {
        userId: USER,
        generationId: 'gen-t12',
        operationId: videoReturnOperationKey('gen-t12'),
        event: 'deadline_reached',
        expectedVersion: 1,
        leaseOwner: LEASE_OWNER,
        leaseToken: LEASE_TOKEN,
        errorCode: 'deadline_reached',
        nowMs: NOW_MS,
      })
      assert.equal(planned.ok && planned.kind === 'settle', true)
      if (!planned.ok || planned.kind !== 'settle') return
      assert.deepEqual(await cashRefund(handle.database, {
        providerOrderId: 'ord_t12',
        providerRefundId: 'ref_t12',
        refundAmount: 1000,
      }), { ok: true })
      const stale = await commitReturnPlan(handle.database, planned.plan)
      assert.equal(stale.ok, false)
      const retried = await failGeneration(handle.database, 'gen-t12')
      assert.equal(retried.ok, true)
      if (!retried.ok) return
      assert.equal(retried.clawbackQuantity, 6)
      assert.equal(await remainingOf(handle.database, grantId), 0)
      assert.equal(await getAvailableCredits(handle.database, USER, NOW), 0)
    }
    finally {
      handle.close()
    }
  })

  it('T13 duplicate Creem fulfillment after consume does not refill', async () => {
    const handle = createHandle()
    try {
      const catalog = await seedWorld(handle.database)
      const { grantId } = await seedOrderGrant(handle.database, {
        orderId: 'order-t13',
        granted: 10,
        providerOrderId: 'ord_t13',
        ...catalog,
      })
      await seedGeneration(handle.database, 'gen-t13', 6)
      assert.equal((await charge(handle.database, 'gen-t13', 6)).ok, true)
      const expected = buildExpectedOrderCreditFulfillment({
        orderId: 'order-t13',
        userId: USER,
        entitlementSnapshot: [{
          entitlement_key: 'credits',
          entitlement_type: 'consumable',
          quantity: 10,
          grant_cadence: 'purchase',
          expiration_policy: 'fixed_duration',
          duration_days: 365,
        }],
        paidAt: NOW,
      })
      assert.equal(expected.ok, true)
      if (!expected.ok) return
      const ensured = await ensureOrderCreditFulfillment(
        handle.database as Parameters<typeof ensureOrderCreditFulfillment>[0],
        expected.fulfillment,
      )
      assert.deepEqual(ensured, { ok: true })
      const checkout = await applyCheckoutCompleted(
        handle.database as Parameters<typeof applyCheckoutCompleted>[0],
        {
          kind: 'checkout.completed',
          providerEventId: 'evt-t13-b',
          eventType: 'checkout.completed',
          payloadHash: 'c'.repeat(64),
          checkout: {
            checkoutId: 'ch_ord_t13',
            providerOrderId: 'ord_t13',
            orderStatus: 'paid',
            amount: 1000,
            currency: 'USD',
            requestId: 'order-t13',
          },
        },
      )
      assert.deepEqual(checkout, { ok: true })
      assert.equal(await remainingOf(handle.database, grantId), 4)
    }
    finally {
      handle.close()
    }
  })

  it('T14 missing original grant transaction after consume is not repaired', async () => {
    const handle = createHandle()
    try {
      const catalog = await seedWorld(handle.database)
      const { grantId, txIds } = await seedOrderGrant(handle.database, {
        orderId: 'order-t14',
        granted: 10,
        providerOrderId: 'ord_t14',
        ...catalog,
      })
      await seedGeneration(handle.database, 'gen-t14', 6)
      assert.equal((await charge(handle.database, 'gen-t14', 6)).ok, true)
      await handle.database.delete(entitlementTransactions).where(eq(entitlementTransactions.id, txIds.id))
      const expected = buildExpectedOrderCreditFulfillment({
        orderId: 'order-t14',
        userId: USER,
        entitlementSnapshot: [{
          entitlement_key: 'credits',
          entitlement_type: 'consumable',
          quantity: 10,
          grant_cadence: 'purchase',
          expiration_policy: 'fixed_duration',
          duration_days: 365,
        }],
        paidAt: NOW,
      })
      assert.equal(expected.ok, true)
      if (!expected.ok) return
      const ensured = await ensureOrderCreditFulfillment(
        handle.database as Parameters<typeof ensureOrderCreditFulfillment>[0],
        expected.fulfillment,
      )
      assert.deepEqual(ensured, { ok: false, errorCode: 'ENTITLEMENT_TRANSACTION_MISSING' })
      assert.equal(await remainingOf(handle.database, grantId), 4)
      const grantTx = await handle.database.select().from(entitlementTransactions).where(eq(entitlementTransactions.id, txIds.id))
      assert.equal(grantTx.length, 0)
    }
    finally {
      handle.close()
    }
  })

  it('T15 retry after a committed consume stays idempotent', async () => {
    const handle = createHandle()
    try {
      const catalog = await seedWorld(handle.database)
      const { grantId } = await seedOrderGrant(handle.database, {
        orderId: 'order-t15',
        granted: 10,
        providerOrderId: 'ord_t15',
        ...catalog,
      })
      await seedGeneration(handle.database, 'gen-t15', 6)
      const planned = await planConsumeForGeneration(handle.database, {
        userId: USER,
        generationId: 'gen-t15',
        creditAmount: 6,
        operationId: videoConsumeOperationKey('gen-t15'),
        nowMs: NOW_MS,
      })
      assert.equal(planned.ok && planned.kind === 'charge', true)
      if (!planned.ok || planned.kind !== 'charge') return
      const first = await commitConsumePlan(handle.database, planned.plan)
      const second = await commitConsumePlan(handle.database, planned.plan)
      assert.equal(first.ok, true)
      assert.equal(second.ok, true)
      if (!second.ok) return
      assert.equal(second.replay, true)
      assert.equal(await remainingOf(handle.database, grantId), 4)
      assert.equal((await operations(handle.database, 'gen-t15')).length, 1)
    }
    finally {
      handle.close()
    }
  })

  it('T16 rebuilt ledger matches remainingQuantity', async () => {
    const handle = createHandle()
    try {
      const catalog = await seedWorld(handle.database)
      const { grantId } = await seedOrderGrant(handle.database, {
        orderId: 'order-t16',
        granted: 10,
        providerOrderId: 'ord_t16',
        ...catalog,
      })
      await seedGeneration(handle.database, 'gen-t16', 6)
      assert.equal((await charge(handle.database, 'gen-t16', 6)).ok, true)
      const rebuilt = await reconcileGrantLedger(handle.database, grantId)
      assert.equal(rebuilt.ok, true)
      if (!rebuilt.ok) return
      assert.equal(rebuilt.remainingQuantity, 4)
      assert.equal(rebuilt.rebuiltQuantity, 4)
    }
    finally {
      handle.close()
    }
  })

  it('T17 duplicate refund, duplicate return, and reverse order stay consistent', async () => {
    const handle = createHandle()
    try {
      const catalog = await seedWorld(handle.database)
      const { grantId } = await seedOrderGrant(handle.database, {
        orderId: 'order-t17',
        granted: 10,
        providerOrderId: 'ord_t17',
        ...catalog,
      })
      await seedGeneration(handle.database, 'gen-t17', 6)
      assert.equal((await charge(handle.database, 'gen-t17', 6)).ok, true)
      const firstRefund = await cashRefund(handle.database, {
        providerOrderId: 'ord_t17',
        providerRefundId: 'ref_t17',
        refundAmount: 1000,
      })
      const duplicateRefund = await cashRefund(handle.database, {
        providerOrderId: 'ord_t17',
        providerRefundId: 'ref_t17',
        refundAmount: 1000,
      })
      assert.deepEqual(firstRefund, { ok: true })
      assert.deepEqual(duplicateRefund, { ok: true })
      const firstReturn = await failGeneration(handle.database, 'gen-t17')
      const duplicateReturn = await failGeneration(handle.database, 'gen-t17')
      assert.equal(firstReturn.ok, true)
      assert.equal(duplicateReturn.ok, true)
      if (!duplicateReturn.ok) return
      assert.equal(duplicateReturn.replay, true)
      assert.equal(await remainingOf(handle.database, grantId), 0)
      assert.equal(await getAvailableCredits(handle.database, USER, NOW), 0)

      const reverse = createHandle()
      const reverseCatalog = await seedWorld(reverse.database, 'user-t17b')
      const reverseGrant = await seedOrderGrant(reverse.database, {
        orderId: 'order-t17b',
        userId: 'user-t17b',
        granted: 10,
        providerOrderId: 'ord_t17b',
        ...reverseCatalog,
      })
      await seedGeneration(reverse.database, 'gen-t17b', 6, 'user-t17b')
      assert.equal((await charge(reverse.database, 'gen-t17b', 6, 'user-t17b')).ok, true)
      const returnedFirst = await failGeneration(reverse.database, 'gen-t17b', 'user-t17b')
      assert.equal(returnedFirst.ok, true)
      assert.equal(await remainingOf(reverse.database, reverseGrant.grantId), 10)
      assert.deepEqual(await cashRefund(reverse.database, {
        providerOrderId: 'ord_t17b',
        providerRefundId: 'ref_t17b',
        refundAmount: 1000,
      }), { ok: true })
      assert.equal(await remainingOf(reverse.database, reverseGrant.grantId), 0)
      assert.equal(await getAvailableCredits(reverse.database, 'user-t17b', NOW), 0)
      reverse.close()
    }
    finally {
      handle.close()
    }
  })

  it('A/B shortfall clawback totals 6 and leaves spendable 4', async () => {
    const handle = createHandle()
    try {
      const catalog = await seedWorld(handle.database)
      const { grantId } = await seedOrderGrant(handle.database, {
        orderId: 'order-ab',
        granted: 10,
        providerOrderId: 'ord_ab',
        ...catalog,
      })
      await seedGeneration(handle.database, 'gen-ab-a', 6)
      await seedGeneration(handle.database, 'gen-ab-b', 4)
      assert.equal((await charge(handle.database, 'gen-ab-a', 6)).ok, true)
      assert.equal((await charge(handle.database, 'gen-ab-b', 4)).ok, true)
      assert.deepEqual(await cashRefund(handle.database, {
        providerOrderId: 'ord_ab',
        providerRefundId: 'ref_ab',
        refundAmount: 600,
      }), { ok: true })
      const planA = await planReturnForFailedGeneration(handle.database, {
        userId: USER,
        generationId: 'gen-ab-a',
        operationId: videoReturnOperationKey('gen-ab-a'),
        event: 'deadline_reached',
        expectedVersion: 1,
        leaseOwner: LEASE_OWNER,
        leaseToken: LEASE_TOKEN,
        errorCode: 'deadline_reached',
        nowMs: NOW_MS,
      })
      const planB = await planReturnForFailedGeneration(handle.database, {
        userId: USER,
        generationId: 'gen-ab-b',
        operationId: videoReturnOperationKey('gen-ab-b'),
        event: 'deadline_reached',
        expectedVersion: 1,
        leaseOwner: LEASE_OWNER,
        leaseToken: LEASE_TOKEN,
        errorCode: 'deadline_reached',
        nowMs: NOW_MS,
      })
      assert.equal(planA.ok && planA.kind === 'settle', true)
      assert.equal(planB.ok && planB.kind === 'settle', true)
      if (!planA.ok || planA.kind !== 'settle' || !planB.ok || planB.kind !== 'settle') return
      const first = await commitReturnPlan(handle.database, planA.plan)
      const stale = await commitReturnPlan(handle.database, planB.plan)
      assert.equal(first.ok, true)
      assert.equal(stale.ok, false)
      const retried = await failGeneration(handle.database, 'gen-ab-b')
      assert.equal(retried.ok, true)
      if (!retried.ok) return
      assert.equal(await getAvailableCredits(handle.database, USER, NOW), 4)
      assert.equal(await remainingOf(handle.database, grantId), 4)
    }
    finally {
      handle.close()
    }
  })

  it('composeBefore rolls back with a failing grant CASE', async () => {
    const handle = createHandle()
    try {
      const catalog = await seedWorld(handle.database)
      const { grantId } = await seedOrderGrant(handle.database, {
        orderId: 'order-compose',
        granted: 10,
        providerOrderId: 'ord_compose',
        ...catalog,
      })
      const grants = await listChargeCandidates(handle.database, USER, NOW)
      const prepared = prepareConsumeCharge({
        userId: USER,
        generationId: 'gen-compose',
        operationId: videoConsumeOperationKey('gen-compose'),
        creditAmount: 6,
        nowMs: NOW_MS,
        generation: {
          userId: USER,
          status: 'queued',
          statusVersion: 1,
          quotedCredits: 6,
          quote: {
            schemaVersion: 1,
            creditAmount: 6,
            pricingRuleId: 'rule-test',
            pricingRuleRevision: 1,
            unit: 'credit',
          },
        },
        grants,
      })
      assert.equal(prepared.ok, true)
      if (!prepared.ok) return
      await handle.database.update(entitlementGrants).set({
        remainingQuantity: 3,
        updatedAt: NOW,
      }).where(eq(entitlementGrants.id, grantId))
      const insert = handle.database.insert(videoGenerations).values({
        id: 'gen-compose',
        userId: USER,
        idempotencyKey: 'idem-gen-compose',
        canonicalInputHash: 'b'.repeat(64),
        canonicalInput: { modelId: 'model-1' },
        routeSnapshotVersion: 1,
        routeSnapshot: {
          schemaVersion: 1,
          routeId: 'route-1',
          revision: 1,
          model: { id: 'model-1', revision: 1 },
          providerId: 'mock',
          providerModelId: 'mock-1',
          adapterVersion: '1',
          capability: {
            id: 'cap-text',
            mode: 'text-to-video',
            prompt: 'required',
            durationSeconds: [5],
            resolutions: ['720p'],
            optionalParameters: {},
          },
          input: {
            modelId: 'model-1',
            mode: 'text-to-video',
            prompt: 'a reel',
            parameters: { durationSeconds: 5, resolution: '720p' },
          },
        },
        quotedCredits: 6,
        quoteSnapshot: {
          schemaVersion: 1,
          creditAmount: 6,
          pricingRuleId: 'rule-test',
          pricingRuleRevision: 1,
          unit: 'credit',
        },
        mode: 'text-to-video',
        status: 'queued',
        statusVersion: 1,
        deadlineAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
      const result = await commitConsumePlan(handle.database, prepared.plan, {
        composeBefore: [insert],
      })
      assert.equal(result.ok, false)
      const created = await handle.database.select().from(videoGenerations).where(eq(videoGenerations.id, 'gen-compose'))
      assert.equal(created.length, 0)
      assert.equal(await remainingOf(handle.database, grantId), 3)
    }
    finally {
      handle.close()
    }
  })

  it('needs_review and submission_unknown do not auto-return', async () => {
    const handle = createHandle()
    try {
      const catalog = await seedWorld(handle.database)
      await seedOrderGrant(handle.database, {
        orderId: 'order-illegal',
        granted: 10,
        providerOrderId: 'ord_illegal',
        ...catalog,
      })
      await seedGeneration(handle.database, 'gen-review', 6)
      assert.equal((await charge(handle.database, 'gen-review', 6)).ok, true)
      await handle.database.update(videoGenerations).set({
        status: 'needs_review',
        errorCode: 'provider_query_error',
        errorAt: NOW,
        updatedAt: NOW,
      }).where(eq(videoGenerations.id, 'gen-review'))
      const review = await returnCreditsForFailedGeneration(handle.database, {
        userId: USER,
        generationId: 'gen-review',
        operationId: videoReturnOperationKey('gen-review'),
        event: 'provider_query_error',
        expectedVersion: 1,
        leaseOwner: LEASE_OWNER,
        leaseToken: LEASE_TOKEN,
        errorCode: 'provider_query_error',
        nowMs: NOW_MS,
      })
      assert.equal(review.ok, false)
      if (review.ok) return
      assert.equal(review.reason, 'illegal_transition')

      await seedGeneration(handle.database, 'gen-unknown', 4)
      assert.equal((await charge(handle.database, 'gen-unknown', 4)).ok, true)
      await handle.database.update(videoGenerations).set({
        status: 'submission_unknown',
        updatedAt: NOW,
      }).where(eq(videoGenerations.id, 'gen-unknown'))
      const unknown = await failGeneration(handle.database, 'gen-unknown')
      assert.equal(unknown.ok, false)
      if (unknown.ok) return
      assert.equal(unknown.reason, 'illegal_transition')
    }
    finally {
      handle.close()
    }
  })
})
