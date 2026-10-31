import './webhook-globals.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import type { Database } from '../src/client.ts'
import { consumeCreditsForGeneration, planConsumeForGeneration, commitConsumePlan, prepareConsumeCharge } from '../src/credits/consume.ts'
import { returnCreditsForFailedGeneration, planReturnForFailedGeneration, commitReturnPlan, type ReturnRequest } from '../src/credits/return.ts'
import { LedgerCommitUnknown } from '../src/credits/runtime.ts'
import { reconcileGrantLedger } from '../src/credits/reconcile.ts'
import { getAvailableCredits, listChargeCandidates } from '../src/credits/spendable.ts'
import { planCreditConsumption, videoConsumeOperationKey, videoReturnOperationKey } from '../src/credits/contract.ts'
import { billingRefundCreditAdjustments, billingRefunds } from '../src/schema/billing.ts'
import { applyCheckoutCompleted, applyRefundCreated, buildExpectedOrderCreditFulfillment, ensureOrderCreditFulfillment } from '../../../server/api/webhooks/creem.post.ts'
import {
  billingOrders, billingRefundCreditSettlements, entitlementGrants, entitlementTransactions,
  videoAttempts, videoCreditOperations, videoGenerations, videoOutbox,
  creditQuote, insertAttempt, insertCatalog, insertLeasedOutbox, insertOutputAsset, insertPaidOrder,
  insertQueuedGeneration, insertUser, openLedgerDatabase, queuedGenerationInsert,
} from './ledger-harness.ts'

const NOW_MS = Date.UTC(2026, 5, 1, 12)
const NOW = new Date(NOW_MS)
const USER = 'integrity-user'
const OWNER = 'worker-1'
const TOKEN = 'token-1'

async function fixture(run: (db: Database, sqlite: ReturnType<typeof openLedgerDatabase>['sqlite'], path: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'reelbam-integrity-'))
  const handle = openLedgerDatabase(join(dir, 'ledger.sqlite'))
  try {
    await insertUser(handle.database, USER, NOW)
    await insertCatalog(handle.database, NOW)
    await run(handle.database, handle.sqlite, handle.path)
  }
  finally { handle.close(); rmSync(dir, { recursive: true, force: true }) }
}

async function orderGrant(db: Database, orderId = 'order', quantity = 10) {
  await insertPaidOrder(db, { id: orderId, userId: USER, productId: 'prod-credits', priceId: 'price-credits',
    amount: 1000, grantedQuantity: quantity, providerOrderId: `provider-${orderId}`, now: NOW })
  const expected = buildExpectedOrderCreditFulfillment({ orderId, userId: USER, paidAt: NOW,
    entitlementSnapshot: [{ entitlement_key: 'credits', entitlement_type: 'consumable', quantity,
      grant_cadence: 'purchase', expiration_policy: 'fixed_duration', duration_days: 365 }] })
  if (!expected.ok) assert.fail(expected.errorCode)
  assert.deepEqual(await ensureOrderCreditFulfillment(db, expected.fulfillment), { ok: true })
  return expected.fulfillment.grant.id
}

async function generation(db: Database, id = 'gen', amount = 6) {
  await insertQueuedGeneration(db, { id, userId: USER, credits: amount, now: NOW })
  await insertLeasedOutbox(db, { id: `outbox-${id}`, generationId: id, eventType: 'start_submission', now: NOW })
}
function consumeRequest(id = 'gen', amount = 6) {
  return { userId: USER, generationId: id, operationId: videoConsumeOperationKey(id), creditAmount: amount, nowMs: NOW_MS }
}
function returnRequest(id = 'gen'): ReturnRequest {
  return { userId: USER, generationId: id, operationId: videoReturnOperationKey(id), event: 'deadline_reached',
    expectedVersion: 1, leaseOwner: OWNER, leaseToken: TOKEN, errorCode: 'deadline', nowMs: NOW_MS }
}
function refund(db: Database, amount = 1000, orderId = 'order', refundId = 'refund') {
  return applyRefundCreated(db, { kind: 'refund.created', providerEventId: `event-${refundId}`, eventType: 'refund.created', payloadHash: 'a'.repeat(64),
    refund: { providerRefundId: refundId, providerOrderId: `provider-${orderId}`, status: 'succeeded', refundAmount: amount,
      providerPaidAmount: 1000, currency: 'USD', providerTransactionId: `txn-${orderId}`, reasonCode: null } })
}
async function remaining(db: Database, grantId: string) {
  return (await db.select().from(entitlementGrants).where(eq(entitlementGrants.id, grantId)))[0]!.remainingQuantity
}
async function noReturn(db: Database, grantId: string, expected = 4) {
  assert.equal(await remaining(db, grantId), expected)
  assert.equal((await db.select().from(videoCreditOperations)).filter(row => row.operationType === 'return').length, 0)
  assert.equal((await db.select().from(entitlementTransactions)).filter(row => row.transactionType === 'refund').length, 0)
}
async function assertReconciled(db: Database, grantId: string) {
  const result = await reconcileGrantLedger(db, grantId)
  assert.equal(result.ok, true, JSON.stringify(result))
}

it('missing initial grant and a missing middle row cannot pass reconciliation', async () => {
  await fixture(async (db) => {
    const grant = await orderGrant(db)
    await generation(db)
    assert.equal((await consumeCreditsForGeneration(db, consumeRequest())).ok, true)
    const initial = (await db.select().from(entitlementTransactions)).find(row => row.transactionType === 'grant')!
    await db.delete(entitlementTransactions).where(eq(entitlementTransactions.id, initial.id))
    const result = await reconcileGrantLedger(db, grant)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'missing_initial_grant')
  })
  await fixture(async (db) => {
    const grant = await orderGrant(db)
    await generation(db)
    assert.equal((await consumeCreditsForGeneration(db, consumeRequest())).ok, true)
    assert.equal((await returnCreditsForFailedGeneration(db, returnRequest())).ok, true)
    const consumed = (await db.select().from(entitlementTransactions)).find(row => row.transactionType === 'consume')!
    await db.delete(entitlementTransactions).where(eq(entitlementTransactions.id, consumed.id))
    assert.equal((await reconcileGrantLedger(db, grant)).ok, false)
  })
})

it('same-second reverse lexical generations, returns, and cash reclaim retain write order', async () => {
  await fixture(async (db) => {
    const grant = await orderGrant(db)
    await generation(db, 'gen-z', 3)
    await generation(db, 'gen-a', 2)
    assert.equal((await consumeCreditsForGeneration(db, consumeRequest('gen-z', 3))).ok, true)
    assert.equal((await consumeCreditsForGeneration(db, consumeRequest('gen-a', 2))).ok, true)
    assert.equal((await returnCreditsForFailedGeneration(db, returnRequest('gen-z'))).ok, true)
    assert.deepEqual(await refund(db), { ok: true })
    assert.equal((await returnCreditsForFailedGeneration(db, returnRequest('gen-a'))).ok, true)
    assert.equal(await remaining(db, grant), 0)
    await assertReconciled(db, grant)
    const rows = await db.select().from(entitlementTransactions)
    assert.deepEqual(rows.map(row => row.ledgerSequence).sort((a, b) => a! - b!), rows.map((_, i) => i + 1))
  })
})

it('strict grant triggers reject NULL, fractional, negative, and excess quantities', async () => {
  await fixture(async (db, sqlite) => {
    const grant = await orderGrant(db)
    for (const patch of ['granted_quantity = NULL', 'remaining_quantity = NULL', 'granted_quantity = 10.5',
      'remaining_quantity = 1.5', 'remaining_quantity = -1', 'remaining_quantity = 11']) {
      assert.throws(() => sqlite.prepare(`update entitlement_grants set ${patch} where id = ?`).run(grant), /credit_grant_quantity_invalid/)
      assert.equal(await remaining(db, grant), 10)
    }
    assert.throws(() => sqlite.prepare(`insert into entitlement_grants
      (id,user_id,entitlement_key,entitlement_type,source_type,source_id,period_key,granted_quantity,remaining_quantity,effective_at,status,created_at,updated_at)
      values ('invalid',?,'credits','consumable','promotion','invalid','purchase',NULL,10,0,'active',0,0)`).run(USER), /credit_grant_quantity_invalid/)
    const candidates = await listChargeCandidates(db, USER, NOW)
    const invalid = { ...candidates[0]!, granted: null }
    assert.deepEqual(planCreditConsumption({ userId: USER, generationId: 'invalid', amount: 6, nowMs: NOW_MS, grants: [invalid] }),
      { ok: false, reason: 'invalid_grant' })
    // Simulate an invalid legacy row before 0003: both balance and charge must fail closed.
    sqlite.exec('drop trigger entitlement_grants_strict_quantity_update')
    sqlite.prepare('update entitlement_grants set granted_quantity = NULL where id = ?').run(grant)
    assert.equal(await getAvailableCredits(db, USER, NOW), 0)
    await generation(db)
    assert.deepEqual(await consumeCreditsForGeneration(db, consumeRequest()), { ok: false, reason: 'invalid_grant' })
    assert.equal((await db.select().from(videoCreditOperations)).length, 0)
  })
})

it('unknown/accepted attempts cannot claim submission_rejected; evidence can compose atomically', async () => {
  for (const status of ['unknown', 'accepted'] as const) {
    await fixture(async (db) => {
      const grant = await orderGrant(db)
      await generation(db)
      assert.equal((await consumeCreditsForGeneration(db, consumeRequest())).ok, true)
      await insertAttempt(db, { id: 'attempt', generationId: 'gen', now: NOW })
      if (status === 'unknown') await db.update(videoAttempts).set({ acceptanceStatus: 'unknown', providerRequestId: null }).where(eq(videoAttempts.id, 'attempt'))
      await db.update(videoGenerations).set({ status: 'submitting', statusVersion: 2 }).where(eq(videoGenerations.id, 'gen'))
      const request = { ...returnRequest(), event: 'submission_rejected', expectedVersion: 2, attemptId: 'attempt', evidenceId: 'observation' }
      assert.equal((await returnCreditsForFailedGeneration(db, request)).ok, false)
      await noReturn(db, grant)
      assert.equal((await db.select().from(videoGenerations))[0]!.status, 'submitting')
      if (status === 'unknown') {
        const evidence = db.update(videoAttempts).set({ acceptanceStatus: 'rejected', providerRequestId: null,
          settlementEvent: 'submission_rejected', settlementEvidenceId: 'observation', resolvedAt: NOW }).where(eq(videoAttempts.id, 'attempt'))
        assert.equal((await returnCreditsForFailedGeneration(db, { ...request, composeBefore: [evidence] })).ok, true)
        assert.equal(await remaining(db, grant), 10)
        await assertReconciled(db, grant)
      }
    })
  }
})

it('old attempt, wrong evidence, and replaced lease cannot settle a current generation', async () => {
  await fixture(async (db) => {
    const grant = await orderGrant(db)
    await generation(db)
    assert.equal((await consumeCreditsForGeneration(db, consumeRequest())).ok, true)
    await insertAttempt(db, { id: 'old', generationId: 'gen', now: NOW })
    await db.update(videoAttempts).set({ acceptanceStatus: 'rejected', providerRequestId: null,
      settlementEvent: 'submission_rejected', settlementEvidenceId: 'old-evidence', resolvedAt: NOW }).where(eq(videoAttempts.id, 'old'))
    const old = (await db.select().from(videoAttempts))[0]!
    await db.insert(videoAttempts).values({ id: 'new', generationId: 'gen', stepId: old.stepId, attemptNumber: 2,
      submitKey: 'new-submit', providerId: 'mock', acceptanceStatus: 'unknown', leaseOwner: OWNER, leaseToken: TOKEN,
      leaseUntil: new Date(NOW_MS + 60_000), createdAt: NOW, updatedAt: NOW })
    await db.update(videoGenerations).set({ status: 'submitting', statusVersion: 2 }).where(eq(videoGenerations.id, 'gen'))
    assert.equal((await returnCreditsForFailedGeneration(db, { ...returnRequest(), event: 'submission_rejected', expectedVersion: 2,
      attemptId: 'old', evidenceId: 'old-evidence' })).ok, false)
    await noReturn(db, grant)
  })
  await fixture(async (db) => {
    const grant = await orderGrant(db)
    await generation(db)
    assert.equal((await consumeCreditsForGeneration(db, consumeRequest())).ok, true)
    await insertAttempt(db, { id: 'attempt', generationId: 'gen', now: NOW })
    await db.update(videoAttempts).set({ settlementEvent: 'provider_failed', settlementEvidenceId: 'evidence', resolvedAt: NOW }).where(eq(videoAttempts.id, 'attempt'))
    await db.update(videoGenerations).set({ status: 'processing', statusVersion: 2 }).where(eq(videoGenerations.id, 'gen'))
    const request = { ...returnRequest(), event: 'provider_failed', expectedVersion: 2, attemptId: 'attempt',
      evidenceId: 'wrong', providerRequestId: 'req-attempt' }
    assert.equal((await returnCreditsForFailedGeneration(db, request)).ok, false)
    const planned = await planReturnForFailedGeneration(db, { ...request, evidenceId: 'evidence' })
    if (!planned.ok || planned.kind !== 'settle') assert.fail('missing return plan')
    await db.update(videoAttempts).set({ leaseToken: 'replacement' }).where(eq(videoAttempts.id, 'attempt'))
    assert.equal((await commitReturnPlan(db, planned.plan)).ok, false)
    await noReturn(db, grant)
  })
})

it('a success committed after return planning rolls the entire stale return back', async () => {
  await fixture(async (db) => {
    const grant = await orderGrant(db)
    await generation(db)
    assert.equal((await consumeCreditsForGeneration(db, consumeRequest())).ok, true)
    const planned = await planReturnForFailedGeneration(db, returnRequest())
    if (!planned.ok || planned.kind !== 'settle') assert.fail('missing plan')
    await insertOutputAsset(db, { id: 'output', userId: USER, now: NOW })
    await db.update(videoGenerations).set({ status: 'succeeded', outputAssetId: 'output', terminalAt: NOW }).where(eq(videoGenerations.id, 'gen'))
    assert.equal((await commitReturnPlan(db, planned.plan)).ok, false)
    await noReturn(db, grant)
    assert.equal((await db.select().from(billingOrders))[0]!.refundVersion, 0)
  })
})

it('cross-grant stale second write rolls back the first grant and every charge row', async () => {
  await fixture(async (db) => {
    const first = await orderGrant(db, 'a', 3)
    const second = await orderGrant(db, 'b', 7)
    await generation(db)
    const planned = await planConsumeForGeneration(db, consumeRequest())
    if (!planned.ok || planned.kind !== 'charge') assert.fail('missing plan')
    await db.batch([
      db.update(entitlementGrants).set({ remainingQuantity: 6 }).where(eq(entitlementGrants.id, second)),
      db.insert(entitlementTransactions).values({ id: 'adjustment', userId: USER, grantId: second, transactionType: 'adjustment', quantity: -1,
        sourceType: 'admin', sourceId: 'adjustment', balanceBefore: 7, balanceAfter: 6, idempotencyKey: 'adjustment', createdAt: NOW }),
    ])
    assert.equal((await commitConsumePlan(db, planned.plan)).ok, false)
    assert.equal(await remaining(db, first), 3)
    assert.equal(await remaining(db, second), 6)
    assert.equal((await db.select().from(videoCreditOperations)).length, 0)
    assert.equal((await db.select().from(entitlementTransactions)).filter(row => row.transactionType === 'consume').length, 0)
    await assertReconciled(db, first); await assertReconciled(db, second)
  })
})

it('composeAfter failure rolls back task, outbox, operation, ledger, and grant', async () => {
  await fixture(async (db) => {
    const grant = await orderGrant(db)
    const prepared = prepareConsumeCharge({ ...consumeRequest(), generation: {
      userId: USER, status: 'queued', statusVersion: 1, quotedCredits: 6, quote: creditQuote(6),
    }, grants: await listChargeCandidates(db, USER, NOW) })
    if (!prepared.ok) assert.fail('missing plan')
    const outbox = db.insert(videoOutbox).values({ id: 'outbox', generationId: 'gen', eventType: 'start_submission', payloadVersion: 1,
      payload: {}, notBefore: NOW, deliveryStatus: 'pending', createdAt: NOW, updatedAt: NOW })
    const broken = db.insert(videoOutbox).values({ id: 'bad-outbox', generationId: 'absent', eventType: 'poll_status', payloadVersion: 1,
      payload: {}, notBefore: NOW, deliveryStatus: 'pending', createdAt: NOW, updatedAt: NOW })
    assert.equal((await commitConsumePlan(db, prepared.plan, {
      composeBefore: [queuedGenerationInsert(db, { id: 'gen', userId: USER, credits: 6, now: NOW })], composeAfter: [outbox, broken],
    })).ok, false)
    assert.equal(await remaining(db, grant), 10)
    assert.equal((await db.select().from(videoGenerations)).length, 0)
    assert.equal((await db.select().from(videoOutbox)).length, 0)
    assert.equal((await db.select().from(videoCreditOperations)).length, 0)
    assert.equal((await db.select().from(entitlementTransactions)).length, 1)
  })
})

it('changing a generation operation key cannot charge again; zero charges create no credit rows', async () => {
  await fixture(async (db) => {
    const grant = await orderGrant(db)
    await generation(db)
    assert.equal((await consumeCreditsForGeneration(db, consumeRequest())).ok, true)
    assert.deepEqual(await consumeCreditsForGeneration(db, { ...consumeRequest(), operationId: 'different-key' }), { ok: false, reason: 'operation_mismatch' })
    await generation(db, 'zero', 0)
    assert.equal((await consumeCreditsForGeneration(db, consumeRequest('zero', 0))).ok, true)
    assert.equal((await returnCreditsForFailedGeneration(db, returnRequest('zero'))).ok, true)
    assert.equal(await remaining(db, grant), 4)
    assert.equal((await db.select().from(entitlementTransactions)).filter(row => row.sourceId === 'zero').length, 0)
    assert.equal((await db.select().from(videoCreditOperations)).filter(row => row.generationId === 'zero').length, 2)
  })
})

it('40% and 50% refunds preserve exactly 6 and 5 credits after return', async () => {
  for (const percent of [40, 50]) await fixture(async (db) => {
    const grant = await orderGrant(db)
    await generation(db)
    assert.equal((await consumeCreditsForGeneration(db, consumeRequest())).ok, true)
    assert.deepEqual(await refund(db, percent * 10), { ok: true })
    const before = await db.select().from(billingRefundCreditAdjustments)
    const result = await returnCreditsForFailedGeneration(db, returnRequest())
    assert.equal(result.ok, true)
    assert.equal(await getAvailableCredits(db, USER, NOW), 10 - percent / 10)
    assert.equal(await remaining(db, grant), 10 - percent / 10)
    assert.deepEqual(await db.select().from(billingRefundCreditAdjustments), before)
    const settlements = await db.select().from(billingRefundCreditSettlements)
    assert.equal(settlements.reduce((sum, row) => sum + row.quantity, 0), percent === 50 ? 1 : 0)
    await assertReconciled(db, grant)
  })
})

it('cash-reclaimed credits return only to the refunded order; the other order is restored', async () => {
  await fixture(async (db) => {
    const a = await orderGrant(db, 'a', 3)
    const b = await orderGrant(db, 'b', 7)
    await generation(db)
    assert.equal((await consumeCreditsForGeneration(db, consumeRequest())).ok, true)
    assert.deepEqual(await refund(db, 1000, 'a'), { ok: true })
    const historical = await db.select().from(billingRefundCreditAdjustments)
    assert.equal((await returnCreditsForFailedGeneration(db, returnRequest())).ok, true)
    assert.equal(await remaining(db, a), 0); assert.equal(await remaining(db, b), 7)
    assert.equal(await getAvailableCredits(db, USER, NOW), 7)
    assert.deepEqual(await db.select().from(billingRefundCreditAdjustments), historical)
    const settlements = await db.select().from(billingRefundCreditSettlements)
    assert.equal(settlements.length, 1)
    assert.equal(settlements[0]!.grantId, a)
    assert.equal(settlements[0]!.adjustmentId, historical[0]!.id)
    assert.equal(settlements[0]!.quantity, 3)
    await assertReconciled(db, a); await assertReconciled(db, b)
  })
})

function faultyDatabase(db: Database, fault: 'response' | 'read' | 'both'): Database {
  let committed = false
  return new Proxy(db, { get(target, property) {
    if (property === 'batch') return async (queries: Parameters<Database['batch']>[0]) => {
      const result = await target.batch(queries)
      committed = true
      if (fault !== 'read') throw new Error('injected lost batch response')
      return result
    }
    if (property === 'select' && committed && fault !== 'response') return () => { throw new Error('injected outcome read failure') }
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}

it('commit response/read loss preserves operation identity and never repeats a charge or return', async () => {
  for (const fault of ['response', 'read', 'both'] as const) await fixture(async (db) => {
    const grant = await orderGrant(db)
    await generation(db)
    if (fault === 'response') assert.equal((await consumeCreditsForGeneration(faultyDatabase(db, fault), consumeRequest())).ok, true)
    else await assert.rejects(consumeCreditsForGeneration(faultyDatabase(db, fault), consumeRequest()),
      (error: unknown) => error instanceof LedgerCommitUnknown && error.operationId === videoConsumeOperationKey('gen'))
    assert.equal((await consumeCreditsForGeneration(db, consumeRequest())).ok, true)
    assert.equal(await remaining(db, grant), 4)
    if (fault === 'response') assert.equal((await returnCreditsForFailedGeneration(faultyDatabase(db, fault), returnRequest())).ok, true)
    else await assert.rejects(returnCreditsForFailedGeneration(faultyDatabase(db, fault), returnRequest()),
      (error: unknown) => error instanceof LedgerCommitUnknown && error.operationId === videoReturnOperationKey('gen'))
    assert.equal((await returnCreditsForFailedGeneration(db, returnRequest())).ok, true)
    assert.equal(await remaining(db, grant), 10)
    const ops = await db.select().from(videoCreditOperations)
    assert.equal(ops.length, 2)
    const transactions = await db.select().from(entitlementTransactions)
    assert.equal(transactions.filter(row => row.transactionType === 'consume').length, 1)
    assert.equal(transactions.filter(row => row.transactionType === 'refund').length, 1)
    await assertReconciled(db, grant)
  })
})

function worker(data: Record<string, unknown>): Promise<{ ok: boolean, result?: { ok: boolean }, error?: string }> {
  const alias = fileURLToPath(new URL('../../../scripts/alias-register.mjs', import.meta.url))
  return new Promise((resolve, reject) => {
    const instance = new Worker(new URL('./ledger-worker.ts', import.meta.url), { workerData: data,
      execArgv: ['--experimental-transform-types', '--import', alias] })
    const timer = setTimeout(() => { void instance.terminate(); reject(new Error('ledger worker timeout')) }, 15_000)
    instance.once('message', result => { clearTimeout(timer); resolve(result) })
    instance.once('error', error => { clearTimeout(timer); reject(error) })
    instance.once('exit', code => { if (code !== 0) { clearTimeout(timer); reject(new Error(`worker exited ${code}`)) } })
  })
}

it('two real connections returning the same generation settle exactly once', async () => {
  await fixture(async (db, _sqlite, path) => {
    const grant = await orderGrant(db)
    await generation(db)
    assert.equal((await consumeCreditsForGeneration(db, consumeRequest())).ok, true)
    const barrier = new SharedArrayBuffer(4)
    const job = { kind: 'return', path, ...returnRequest(), barrier }
    const results = await Promise.all([worker(job), worker(job)])
    assert.ok(results.some(result => result.ok && result.result?.ok), JSON.stringify(results))
    assert.equal((await returnCreditsForFailedGeneration(db, returnRequest())).ok, true)
    assert.equal(await remaining(db, grant), 10)
    assert.equal((await db.select().from(videoCreditOperations)).filter(row => row.operationType === 'return').length, 1)
    assert.equal((await db.select().from(entitlementTransactions)).filter(row => row.transactionType === 'refund').length, 1)
    await assertReconciled(db, grant)
  })
})

it('refund and return races on separate connections converge without changing historical shortfall', async () => {
  for (const amount of [6, 10]) await fixture(async (db, _sqlite, path) => {
    const grant = await orderGrant(db)
    await generation(db, 'gen', amount)
    assert.equal((await consumeCreditsForGeneration(db, consumeRequest('gen', amount))).ok, true)
    const barrier = new SharedArrayBuffer(4)
    const results = await Promise.all([
      worker({ kind: 'return', path, ...returnRequest(), barrier }),
      worker({ kind: 'refund', path, providerOrderId: 'provider-order', providerRefundId: 'race-refund',
        refundAmount: 1000, providerPaidAmount: 1000, providerEventId: 'race-event', barrier }),
    ])
    assert.ok(results.some(result => result.ok && result.result?.ok), JSON.stringify(results))
    assert.deepEqual(await refund(db, 1000, 'order', 'race-refund'), { ok: true })
    const history = await db.select().from(billingRefundCreditAdjustments)
    assert.equal((await returnCreditsForFailedGeneration(db, returnRequest())).ok, true)
    assert.equal(await remaining(db, grant), 0)
    assert.equal(await getAvailableCredits(db, USER, NOW), 0)
    assert.deepEqual(await db.select().from(billingRefundCreditAdjustments), history)
    const settled = await db.select().from(billingRefundCreditSettlements)
    assert.equal(history[0]!.appliedQuantity + settled.reduce((sum, row) => sum + row.quantity, 0), 10)
    assert.equal((await db.select().from(billingRefunds)).length, 1)
    assert.equal((await db.select().from(videoCreditOperations)).filter(row => row.operationType === 'return').length, 1)
    await assertReconciled(db, grant)
  })
})

it('expired return excludes value and preserves the historical expiry and full ledger', async () => {
  await fixture(async (db) => {
    const grant = await orderGrant(db)
    await generation(db)
    assert.equal((await consumeCreditsForGeneration(db, consumeRequest())).ok, true)
    const expiry = (await db.select().from(entitlementGrants))[0]!.expiresAt!
    const later = expiry.getTime() + 1000
    await db.update(videoOutbox).set({ leaseUntil: new Date(later + 60_000) }).where(eq(videoOutbox.generationId, 'gen'))
    const result = await returnCreditsForFailedGeneration(db, { ...returnRequest(), nowMs: later })
    assert.equal(result.ok, true)
    assert.equal(await remaining(db, grant), 0)
    assert.equal(await getAvailableCredits(db, USER, new Date(later)), 0)
    const row = (await db.select().from(entitlementGrants))[0]!
    assert.equal(row.status, 'expired'); assert.equal(row.expiresAt!.getTime(), expiry.getTime())
    const expired = (await db.select().from(entitlementTransactions)).find(row => row.transactionType === 'expire')!
    assert.equal(expired.quantity, -10)
    await assertReconciled(db, grant)
  })
})

it('full refund then late return then duplicate/late checkout never issues again', async () => {
  await fixture(async (db) => {
    const grant = await orderGrant(db)
    await generation(db)
    assert.equal((await consumeCreditsForGeneration(db, consumeRequest())).ok, true)
    const checkout = { kind: 'checkout.completed' as const, providerEventId: 'replay', eventType: 'checkout.completed' as const, payloadHash: 'b'.repeat(64),
      checkout: { checkoutId: 'ch_provider-order', providerOrderId: 'provider-order', orderStatus: 'paid', amount: 1000, currency: 'USD', requestId: 'order' } }
    assert.deepEqual(await applyCheckoutCompleted(db, checkout), { ok: true })
    assert.deepEqual(await refund(db), { ok: true })
    const history = await db.select().from(billingRefundCreditAdjustments)
    assert.equal(history[0]!.shortfallQuantity, 6)
    assert.equal((await returnCreditsForFailedGeneration(db, returnRequest())).ok, true)
    assert.equal((await returnCreditsForFailedGeneration(db, returnRequest())).ok, true)
    assert.deepEqual(await applyCheckoutCompleted(db, { ...checkout, providerEventId: 'late' }), { ok: true })
    assert.deepEqual(await applyCheckoutCompleted(db, checkout), { ok: true })
    assert.equal(await remaining(db, grant), 0)
    assert.deepEqual(await db.select().from(billingRefundCreditAdjustments), history)
    const settlements = await db.select().from(billingRefundCreditSettlements)
    assert.equal(settlements.length, 1); assert.equal(settlements[0]!.quantity, 6)
    assert.equal(settlements[0]!.adjustmentId, history[0]!.id)
    assert.equal(settlements[0]!.returnOperationId, videoReturnOperationKey('gen'))
    assert.equal((await db.select().from(entitlementGrants)).length, 1)
    assert.equal((await db.select().from(entitlementTransactions)).filter(row => row.transactionType === 'grant').length, 1)
    await assertReconciled(db, grant)
  })
})

it('a refund planned before return aborts and retries with the restored balance', async () => {
  await fixture(async (db) => {
    const grant = await orderGrant(db)
    await generation(db)
    assert.equal((await consumeCreditsForGeneration(db, consumeRequest())).ok, true)
    let intercepted = false
    const interleaved = new Proxy(db, { get(target, property) {
      if (property === 'batch') return async (queries: Parameters<Database['batch']>[0]) => {
        if (!intercepted) {
          intercepted = true
          assert.equal((await returnCreditsForFailedGeneration(db, returnRequest())).ok, true)
        }
        return target.batch(queries)
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    const stale = await refund(interleaved)
    assert.equal(stale.ok, false)
    assert.equal((await db.select().from(billingRefunds)).length, 0)
    assert.equal((await db.select().from(billingRefundCreditAdjustments)).length, 0)
    assert.equal(await remaining(db, grant), 10)
    assert.deepEqual(await refund(db), { ok: true })
    const adjustment = (await db.select().from(billingRefundCreditAdjustments))[0]!
    assert.equal(adjustment.appliedQuantity, 10); assert.equal(adjustment.shortfallQuantity, 0)
    assert.equal(await remaining(db, grant), 0)
    await assertReconciled(db, grant)
  })
})

it('zero recovery and two zero-net returns still serialize against the shared order fence', async () => {
  await fixture(async (db) => {
    const grant = await orderGrant(db)
    await generation(db, 'a', 6); await generation(db, 'b', 4)
    assert.equal((await consumeCreditsForGeneration(db, consumeRequest('a', 6))).ok, true)
    assert.equal((await consumeCreditsForGeneration(db, consumeRequest('b', 4))).ok, true)
    const stale = await planReturnForFailedGeneration(db, returnRequest('a'))
    if (!stale.ok || stale.kind !== 'settle') assert.fail('missing plan')
    assert.deepEqual(await refund(db), { ok: true })
    const history = await db.select().from(billingRefundCreditAdjustments)
    assert.equal(history[0]!.appliedQuantity, 0); assert.equal(history[0]!.shortfallQuantity, 10)
    assert.equal((await commitReturnPlan(db, stale.plan)).ok, false)
    const a = await planReturnForFailedGeneration(db, returnRequest('a'))
    const b = await planReturnForFailedGeneration(db, returnRequest('b'))
    if (!a.ok || a.kind !== 'settle' || !b.ok || b.kind !== 'settle') assert.fail('missing plans')
    assert.equal((await commitReturnPlan(db, a.plan)).ok, true)
    assert.equal(await remaining(db, grant), 0)
    assert.equal((await commitReturnPlan(db, b.plan)).ok, false)
    assert.equal((await returnCreditsForFailedGeneration(db, returnRequest('b'))).ok, true)
    assert.equal(await remaining(db, grant), 0)
    assert.deepEqual(await db.select().from(billingRefundCreditAdjustments), history)
    const settlements = await db.select().from(billingRefundCreditSettlements)
    assert.equal(settlements.reduce((sum, row) => sum + row.quantity, 0), 10)
    await assertReconciled(db, grant)
  })
})
