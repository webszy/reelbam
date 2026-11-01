import './webhook-globals.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { createMockProvider } from '../../video-core/src/providers/mock.ts'
import type { MockScenario } from '../../video-core/src/providers/mock.ts'
import { ModelRegistry } from '../../video-core/src/model-registry.ts'
import { ProviderRegistry } from '../../video-core/src/providers/registry.ts'
import type { ProviderAdapter } from '../../video-core/src/provider.ts'
import type { LogicalModel } from '../../video-contracts/src/public.ts'
import type { ProviderRoute } from '../../video-contracts/src/internal.ts'
import {
  applyRefundCreated,
  buildExpectedOrderCreditFulfillment,
  ensureOrderCreditFulfillment,
} from '../../../server/api/webhooks/creem.post.ts'
import { createGeneration } from '../../../server/services/video/create-generation.ts'
import type { Database } from '../src/client.ts'
import { getAvailableCredits } from '../src/credits/spendable.ts'
import { videoAttempts, videoAssets, videoCreditOperations, videoGenerations, videoOutbox, videoProviderCosts } from '../src/schema/video.ts'
import { billingRefundCreditAdjustments, billingRefundCreditSettlements } from '../src/schema/index.ts'
import { dispatchDueOutbox, dispatchOutboxRow } from '../src/video/dispatch.ts'
import { handleVideoMessage, type VideoEngineDeps } from '../src/video/engine.ts'
import { claimAttempt, saveAcceptedAttempt, generationAdvanceStatement, reclaimOutboxLease } from '../src/video/durable.ts'
import { runMaintenance } from '../src/video/maintenance.ts'
import { returnCreditsForFailedGeneration } from '../src/credits/return.ts'
import { videoReturnOperationKey } from '../src/credits/contract.ts'
import { readInflightOutbox } from '../src/video/rows.ts'
import { MOCK_FIXTURE_BYTES, MOCK_FIXTURE_SHA256 } from '../../../workers/video-worker/src/fixture.ts'
import { MOCK_FIXTURE_ID, type VideoQueueMessage } from '../src/video/protocol.ts'
import {
  creditQuote,
  insertCatalog,
  insertPaidOrder,
  insertUser,
  openLedgerDatabase,
  type LedgerHandle,
} from './ledger-harness.ts'

const NOW_MS = Date.UTC(2026, 5, 1, 12)
const NOW = new Date(NOW_MS)
const USER = 'video-user'
const textCapability = {
  id: 'text', mode: 'text-to-video' as const, prompt: 'required' as const,
  durationSeconds: [5], resolutions: ['720p'], optionalParameters: {},
}
const model: LogicalModel = { id: 'model-1', revision: 1, name: 'Mock', capabilities: [textCapability] }
const routeB: ProviderRoute = {
  routeId: 'route-b', revision: 1, modelId: model.id, providerId: 'mock-b', providerModelId: 'mock-b-model',
  adapterVersion: 'mock-v1', enabled: true, priority: 20, capabilityConstraints: [textCapability],
}
const routeA: ProviderRoute = { ...routeB, routeId: 'route-a', providerId: 'mock-a', providerModelId: 'mock-a-model', priority: 10 }
const input = { modelId: model.id, mode: 'text-to-video' as const, prompt: 'a reel', parameters: { durationSeconds: 5, resolution: '720p' } }
const quote = creditQuote(6)

class MemoryQueue {
  readonly messages: VideoQueueMessage[] = []
  failSends = 0
  failPolls = false
  async send(message: VideoQueueMessage): Promise<void> {
    if (this.failPolls && message.eventType === 'poll_status') throw new Error('poll send failed')
    if (this.failSends > 0) {
      this.failSends -= 1
      throw new Error('queue send failed')
    }
    this.messages.push(message)
  }
}

class MemoryStore {
  readonly objects = new Map<string, { body: Uint8Array, contentType: string, contentHash: string }>()
  async put(key: string, body: Uint8Array, contentType: string, contentHash: string): Promise<void> {
    if (!this.objects.has(key)) this.objects.set(key, { body, contentType, contentHash })
  }
  async head(key: string): Promise<{ byteSize: number, contentType: string, contentHash: string } | null> {
    const found = this.objects.get(key)
    return found ? { byteSize: found.body.byteLength, contentType: found.contentType, contentHash: found.contentHash } : null
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }
}

function world(handle: LedgerHandle, scenario: Partial<MockScenario> = {}, routes: readonly ProviderRoute[] = [routeB]) {
  const queue = new MemoryQueue()
  const store = new MemoryStore()
  const clock = { nowMs: () => NOW_MS }
  let submits = 0
  let crashOnce = false
  const inners = routes.map(route => createMockProvider({
    environment: 'test',
    providerId: route.providerId,
    scenario: { fixtureId: MOCK_FIXTURE_ID, completeAfterMs: 0, ...scenario },
  }, clock))
  const wrapped: ProviderAdapter[] = inners.map(inner => ({
    ...inner,
    async submit(value) {
      submits += 1
      const result = await inner.submit(value)
      if (crashOnce) {
        crashOnce = false
        throw new Error('crash-before-save')
      }
      return result
    },
  }))
  const providers = new ProviderRegistry(wrapped)
  const models = new ModelRegistry([model], routes)
  const deps = (): VideoEngineDeps => ({
    database: handle.database,
    providers,
    store,
    clock,
    workerId: 'worker-a',
    environment: 'test',
    fixture: { fixtureId: MOCK_FIXTURE_ID, bytes: MOCK_FIXTURE_BYTES, contentType: 'video/mp4', contentHash: MOCK_FIXTURE_SHA256 },
    limits: { pollDelaySeconds: 0, leaseMs: 60_000, maxPolls: 6, maxSubmitAttempts: 3, outboxMaxDeliveries: 8, maintenanceLimit: 20 },
  })
  return {
    queue, store, providers, models, deps, inners,
    submits: () => submits,
    armCrash() { crashOnce = true },
  }
}

async function seed(database: Database, quantity = 10): Promise<void> {
  await insertUser(database, USER, NOW)
  await insertCatalog(database, NOW)
  await insertPaidOrder(database, {
    id: 'order-1', userId: USER, productId: 'prod-credits', priceId: 'price-credits',
    amount: 1000, grantedQuantity: quantity, providerOrderId: 'provider-order-1', now: NOW,
  })
  const expected = buildExpectedOrderCreditFulfillment({
    orderId: 'order-1', userId: USER, paidAt: NOW,
    entitlementSnapshot: [{
      entitlement_key: 'credits', entitlement_type: 'consumable', quantity,
      grant_cadence: 'purchase', expiration_policy: 'fixed_duration', duration_days: 365,
    }],
  })
  if (!expected.ok) throw new Error(expected.errorCode)
  const granted = await ensureOrderCreditFulfillment(database, expected.fulfillment)
  if (!granted.ok) throw new Error(JSON.stringify(granted))
}

function open(): { handle: LedgerHandle, cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'reelbam-video-engine-'))
  const handle = openLedgerDatabase(join(dir, 'engine.sqlite'))
  return { handle, cleanup: () => { handle.close(); rmSync(dir, { recursive: true, force: true }) } }
}

async function create(handle: LedgerHandle, rig: ReturnType<typeof world>, key = 'idem-1', body: unknown = input, amount = 6) {
  return createGeneration(handle.database, {
    userId: USER,
    idempotencyKey: key,
    input: body,
    quote: amount === 6 ? quote : creditQuote(amount),
    nowMs: NOW_MS,
    deadlineAtMs: NOW_MS + 60 * 60 * 1000,
  }, { models: rig.models, providers: rig.providers, queue: rig.queue, workerId: 'create' })
}

async function drive(handle: LedgerHandle, rig: ReturnType<typeof world>, steps = 12): Promise<void> {
  for (let step = 0; step < steps; step += 1) {
    if (rig.queue.messages.length === 0) {
      await dispatchDueOutbox({
        database: handle.database, queue: rig.queue, workerId: 'dispatch', nowMs: NOW_MS, limits: { pollDelaySeconds: 0, leaseMs: 60_000 },
      })
    }
    const message = rig.queue.messages.shift()
    if (!message) break
    await handleVideoMessage(rig.deps(), message, 'queue')
  }
}

async function generation(database: Database) {
  const rows = await database.select().from(videoGenerations)
  assert.equal(rows.length, 1)
  return rows[0]!
}

test('T01 creates a mock task, charges once, and writes one outbox row', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    const created = await create(handle, rig)
    assert.equal(created.ok, true)
    if (!created.ok) return
    assert.equal(created.replay, false)
    const row = await generation(handle.database)
    assert.equal(row.status, 'queued')
    assert.equal(row.quotedCredits, 6)
    assert.equal((await handle.database.select().from(videoCreditOperations)).length, 1)
    assert.equal((await handle.database.select().from(videoOutbox)).length, 1)
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 4)
    await drive(handle, rig)
    const done = await generation(handle.database)
    assert.equal(done.status, 'succeeded')
    assert.ok(done.outputAssetId)
    assert.equal(rig.submits(), 1)
  }
  finally { cleanup() }
})

test('T02 insufficient credits leaves no generation or outbox', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database, 5)
    const rig = world(handle)
    const created = await create(handle, rig)
    assert.deepEqual(created, { ok: false, reason: 'insufficient_credits' })
    assert.equal((await handle.database.select().from(videoGenerations)).length, 0)
    assert.equal((await handle.database.select().from(videoOutbox)).length, 0)
    assert.equal((await handle.database.select().from(videoCreditOperations)).length, 0)
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 5)
  }
  finally { cleanup() }
})

test('outbox insert failure rolls the charge and generation back', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    const original = handle.database.batch.bind(handle.database)
    handle.database.batch = async (queries) => {
      const text = queries.map(query => {
        const candidate = query as { toSQL?: () => { sql: string } }
        return typeof candidate.toSQL === 'function' ? candidate.toSQL().sql : ''
      }).join('\n')
      if (text.includes('video_outbox')) throw new Error('injected outbox failure')
      return original(queries)
    }
    const created = await create(handle, rig)
    assert.equal(created.ok, false)
    assert.equal((await handle.database.select().from(videoGenerations)).length, 0)
    assert.equal((await handle.database.select().from(videoOutbox)).length, 0)
    assert.equal((await handle.database.select().from(videoCreditOperations)).length, 0)
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 10)
  }
  finally { cleanup() }
})

test('T03 same idempotency key returns the same task and does not charge again', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    const [first, second] = await Promise.all([create(handle, rig), create(handle, rig)])
    assert.equal(first.ok && second.ok, true)
    if (!first.ok || !second.ok) return
    assert.equal(first.generationId, second.generationId)
    assert.equal((await handle.database.select().from(videoGenerations)).length, 1)
    assert.equal((await handle.database.select().from(videoCreditOperations)).length, 1)
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 4)
  }
  finally { cleanup() }
})

test('T04 same key with a different input conflicts', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    const first = await create(handle, rig)
    const second = await create(handle, rig, 'idem-1', { ...input, prompt: 'another reel' })
    assert.equal(first.ok, true)
    assert.deepEqual(second, { ok: false, reason: 'idempotency_conflict' })
    assert.equal((await handle.database.select().from(videoGenerations)).length, 1)
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 4)
  }
  finally { cleanup() }
})

test('T05 a failed queue send keeps the outbox and a later send does not charge again', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    rig.queue.failSends = 1
    const created = await create(handle, rig)
    assert.equal(created.ok, true)
    assert.equal(rig.queue.messages.length, 0)
    const outbox = (await handle.database.select().from(videoOutbox))[0]!
    assert.equal(outbox.deliveryStatus, 'pending')
    await handle.database.update(videoOutbox).set({ nextRetryAt: NOW }).where(eq(videoOutbox.id, outbox.id))
    await drive(handle, rig)
    assert.equal((await generation(handle.database)).status, 'succeeded')
    assert.equal((await handle.database.select().from(videoCreditOperations)).filter(row => row.operationType === 'consume').length, 1)
    assert.equal(rig.submits(), 1)
  }
  finally { cleanup() }
})

test('T06 a send that is not marked delivered can be sent again without a second submit', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    const created = await create(handle, rig, 'idem-1', input, 6)
    assert.equal(created.ok, true)
    if (!created.ok) return
    rig.queue.messages.length = 0
    const outbox = (await handle.database.select().from(videoOutbox))[0]!
    await dispatchOutboxRow({
      database: handle.database,
      queue: rig.queue,
      workerId: 'dispatch',
      nowMs: NOW_MS,
      limits: { leaseMs: 60_000, pollDelaySeconds: 0 },
      afterSend: async () => { throw new Error('crash before outbox update') },
    }, outbox.id, NOW)
    assert.equal(rig.queue.messages.length, 1)
    const leased = (await handle.database.select().from(videoOutbox))[0]!
    assert.equal(leased.deliveryStatus, 'leased')
    await handle.database.update(videoOutbox).set({ leaseUntil: new Date(NOW_MS - 1000) }).where(eq(videoOutbox.id, leased.id))
    await reclaimOutboxLease(handle.database, leased.id, NOW)
    await dispatchOutboxRow({
      database: handle.database, queue: rig.queue, workerId: 'dispatch-2', nowMs: NOW_MS,
      limits: { leaseMs: 60_000, pollDelaySeconds: 0 },
    }, leased.id, NOW)
    assert.equal(rig.queue.messages.length, 2)
    await drive(handle, rig)
    assert.equal((await generation(handle.database)).status, 'succeeded')
    assert.equal(rig.submits(), 1)
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 4)
  }
  finally { cleanup() }
})

test('T07 two consumers leave one submit', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    const created = await create(handle, rig)
    assert.equal(created.ok, true)
    const message = rig.queue.messages[0]!
    await Promise.all([
      handleVideoMessage(rig.deps(), message, 'queue'),
      handleVideoMessage(rig.deps(), message, 'queue'),
    ])
    assert.equal(rig.submits(), 1)
    assert.equal((await handle.database.select().from(videoAttempts)).length, 1)
  }
  finally { cleanup() }
})

test('T08 an expired lease can be taken over and the old token cannot write', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    rig.armCrash()
    const created = await create(handle, rig)
    assert.equal(created.ok, true)
    const message = rig.queue.messages.shift()!
    await assert.rejects(handleVideoMessage(rig.deps(), message, 'queue'))
    const attempt = (await handle.database.select().from(videoAttempts))[0]!
    const oldLease = { owner: attempt.leaseOwner!, token: attempt.leaseToken!, until: attempt.leaseUntil! }
    await handle.database.update(videoAttempts).set({ leaseUntil: new Date(NOW_MS - 1000) }).where(eq(videoAttempts.id, attempt.id))
    await handleVideoMessage(rig.deps(), message, 'queue')
    const saved = (await handle.database.select().from(videoAttempts))[0]!
    assert.ok(saved.providerRequestId)
    const stale = await saveAcceptedAttempt(handle.database, {
      attemptId: saved.id,
      lease: oldLease,
      providerRequestId: 'stale-request',
      metadata: { kind: 'stale' },
      payloadHash: 'b'.repeat(64),
      fromAcceptance: 'not_submitted',
      now: NOW,
    })
    assert.equal(stale, 'conflict')
    const current = (await handle.database.select().from(videoAttempts))[0]!
    assert.equal(current.providerRequestId, saved.providerRequestId)
    assert.notEqual(current.providerRequestId, 'stale-request')
  }
  finally { cleanup() }
})

test('T09 a crash after mock acceptance recovers the same request id', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    rig.armCrash()
    const created = await create(handle, rig)
    assert.equal(created.ok, true)
    const message = rig.queue.messages.shift()!
    await assert.rejects(handleVideoMessage(rig.deps(), message, 'queue'))
    assert.equal(rig.submits(), 1)
    const crashed = (await handle.database.select().from(videoAttempts))[0]!
    assert.equal(crashed.providerRequestId, null)
    await handle.database.update(videoAttempts).set({ leaseUntil: new Date(NOW_MS - 1000) }).where(eq(videoAttempts.id, crashed.id))
    await handleVideoMessage(rig.deps(), message, 'queue')
    assert.equal(rig.submits(), 1)
    const recovered = (await handle.database.select().from(videoAttempts))[0]!
    assert.equal(recovered.providerRequestId, `mock:${encodeURIComponent('mock-b')}:${encodeURIComponent(recovered.submitKey)}`)
  }
  finally { cleanup() }
})

test('T10 a failed poll enqueue does not submit again', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    rig.queue.failPolls = true
    const created = await create(handle, rig)
    assert.equal(created.ok, true)
    await handleVideoMessage(rig.deps(), rig.queue.messages.shift()!, 'queue')
    const attempt = (await handle.database.select().from(videoAttempts))[0]!
    assert.ok(attempt.providerRequestId)
    assert.equal(rig.submits(), 1)
    const polls = (await handle.database.select().from(videoOutbox)).filter(row => row.eventType === 'poll_status')
    assert.equal(polls.length, 1)
    await dispatchDueOutbox({ database: handle.database, queue: rig.queue, workerId: 'dispatch', nowMs: NOW_MS, limits: { pollDelaySeconds: 0, leaseMs: 60_000 } })
    assert.equal(rig.submits(), 1)
    assert.equal(rig.queue.messages.filter(message => message.eventType === 'poll_status').length, 0)
    rig.queue.failPolls = false
    const retryAt = (await handle.database.select().from(videoOutbox)).find(row => row.eventType === 'poll_status')!.nextRetryAt!
    await dispatchDueOutbox({ database: handle.database, queue: rig.queue, workerId: 'dispatch', nowMs: retryAt.getTime() })
    await drive(handle, rig)
    assert.equal(rig.submits(), 1)
    assert.equal((await generation(handle.database)).status, 'succeeded')
  }
  finally { cleanup() }
})

test('T11 pending polls do not increment submits', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle, { outcome: 'hang', completeAfterMs: 60_000 })
    const created = await create(handle, rig)
    assert.equal(created.ok, true)
    await drive(handle, rig, 6)
    assert.equal(rig.submits(), 1)
    assert.equal((await generation(handle.database)).status, 'processing')
    const attempt = (await handle.database.select().from(videoAttempts))[0]!
    assert.equal(attempt.attemptNumber, 1)
  }
  finally { cleanup() }
})

test('T12 a confirmed provider failure refunds once', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle, { outcome: 'failed' })
    const created = await create(handle, rig)
    assert.equal(created.ok, true)
    await drive(handle, rig)
    await drive(handle, rig)
    assert.equal((await generation(handle.database)).status, 'failed')
    assert.equal(rig.submits(), 1)
    const returns = (await handle.database.select().from(videoCreditOperations)).filter(row => row.operationType === 'return')
    assert.equal(returns.length, 1)
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 10)
  }
  finally { cleanup() }
})

test('T13 submission_unknown does not refund or submit twice', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle, { submit: 'unknown', recovery: 'unknown' })
    const created = await create(handle, rig)
    assert.equal(created.ok, true)
    await drive(handle, rig, 4)
    assert.equal((await generation(handle.database)).status, 'submission_unknown')
    assert.equal(rig.submits(), 1)
    assert.equal((await handle.database.select().from(videoCreditOperations)).filter(row => row.operationType === 'return').length, 0)
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 4)
  }
  finally { cleanup() }
})

test('T14 a late failure does not change a succeeded task', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    await create(handle, rig)
    await drive(handle, rig)
    const done = await generation(handle.database)
    assert.equal(done.status, 'succeeded')
    const outcome = await handleVideoMessage(rig.deps(), {
      messageVersion: 1, eventId: 'late', generationId: done.id, eventType: 'poll_status', stepId: 'generate', attemptId: null,
    }, 'queue')
    assert.equal(outcome, 'ack')
    assert.equal((await generation(handle.database)).status, 'succeeded')
    assert.equal((await handle.database.select().from(videoCreditOperations)).filter(row => row.operationType === 'return').length, 0)
  }
  finally { cleanup() }
})

test('R23 unresolved submission parked in needs_review never invents failure evidence or refunds', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle, { submit: 'unknown', recovery: 'unknown' })
    await create(handle, rig)
    await drive(handle, rig, 25)
    const parked = await generation(handle.database)
    assert.equal(parked.status, 'needs_review')
    assert.equal(parked.errorCode, 'recovery_budget_exhausted')
    const attempt = (await handle.database.select().from(videoAttempts))[0]!
    const late = { messageVersion: 1, eventId: 'late-unknown', generationId: parked.id,
      eventType: 'poll_status', stepId: 'generate', attemptId: attempt.id }
    for (const source of ['queue', 'dlq'] as const) {
      assert.equal(await handleVideoMessage(rig.deps(), late, source), 'ack')
    }
    await runMaintenance({ ...rig.deps(), queue: rig.queue })
    assert.equal((await generation(handle.database)).status, 'needs_review')
    const saved = (await handle.database.select().from(videoAttempts))[0]!
    assert.equal(saved.acceptanceStatus, 'unknown')
    assert.equal(saved.settlementEvent, null)
    assert.equal(saved.settlementEvidenceId, null)
    assert.equal(saved.resolvedAt, null)
    assert.equal(rig.submits(), 1)
    assert.equal((await handle.database.select().from(videoCreditOperations)).filter(row => row.operationType === 'return').length, 0)
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 4)
  }
  finally { cleanup() }
})

test('T15 an R2 object is registered again without a second submit when D1 completion fails', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    let armed = true
    const original = handle.database.batch.bind(handle.database)
    handle.database.batch = async (queries) => {
      const text = queries.map(query => {
        const candidate = query as { toSQL?: () => { sql: string } }
        return typeof candidate.toSQL === 'function' ? candidate.toSQL().sql : ''
      }).join('\n')
      if (armed && text.includes('video_assets')) {
        armed = false
        throw new Error('injected asset batch failure')
      }
      return original(queries)
    }
    await create(handle, rig)
    await assert.rejects(drive(handle, rig))
    assert.equal(rig.submits(), 1)
    assert.equal((await generation(handle.database)).status, 'storing')
    assert.ok([...rig.store.objects.keys()].some(key => key.endsWith('/output.mp4')))
    const past = new Date(NOW_MS - 1000)
    await handle.database.update(videoAttempts).set({ leaseUntil: past })
    await handle.database.update(videoOutbox).set({ leaseUntil: past }).where(eq(videoOutbox.deliveryStatus, 'leased'))
    const storing = (await handle.database.select().from(videoOutbox)).find(row => row.eventType === 'store_output')!
    rig.queue.messages.push(storing.payload as unknown as VideoQueueMessage)
    await drive(handle, rig)
    assert.equal((await generation(handle.database)).status, 'succeeded')
    assert.equal(rig.submits(), 1)
    assert.equal((await handle.database.select().from(videoAssets)).length, 1)
  }
  finally { cleanup() }
})

test('T16 one final asset wins when two workers store', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    await create(handle, rig)
    await drive(handle, rig, 2)
    const row = await generation(handle.database)
    assert.equal(row.status, 'storing')
    const message = (await handle.database.select().from(videoOutbox)).find(event => event.eventType === 'store_output')!.payload
    await Promise.all([
      handleVideoMessage(rig.deps(), message, 'queue'),
      handleVideoMessage({ ...rig.deps(), workerId: 'worker-b' }, message, 'queue'),
    ])
    const assets = await handle.database.select().from(videoAssets)
    assert.equal(assets.length, 1)
    const done = await generation(handle.database)
    assert.equal(done.outputAssetId, assets[0]!.id)
    assert.equal(assets[0]!.objectKey.includes('/tmp/'), false)
  }
  finally { cleanup() }
})

test('T17 a dead letter does not refund or submit', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle, { outcome: 'hang', completeAfterMs: 60_000 })
    await create(handle, rig)
    await drive(handle, rig, 3)
    assert.equal((await generation(handle.database)).status, 'processing')
    const before = await getAvailableCredits(handle.database, USER, NOW)
    const outcome = await handleVideoMessage(rig.deps(), rig.queue.messages[0] ?? {
      messageVersion: 1, eventId: 'dlq-1', generationId: (await generation(handle.database)).id,
      eventType: 'poll_status', stepId: 'generate', attemptId: (await handle.database.select().from(videoAttempts))[0]!.id,
    }, 'dlq')
    assert.equal(outcome, 'ack')
    assert.equal(rig.submits(), 1)
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), before)
    assert.equal((await handle.database.select().from(videoCreditOperations)).filter(row => row.operationType === 'return').length, 0)
    assert.notEqual((await generation(handle.database)).status, 'failed')
  }
  finally { cleanup() }
})

test('T18 a new runner object resumes a crashed task', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    rig.armCrash()
    await create(handle, rig)
    const message = rig.queue.messages.shift()!
    await assert.rejects(handleVideoMessage(rig.deps(), message, 'queue'))
    const attempt = (await handle.database.select().from(videoAttempts))[0]!
    await handle.database.update(videoAttempts).set({ leaseUntil: new Date(NOW_MS - 1000) }).where(eq(videoAttempts.id, attempt.id))
    const restarted = { ...rig.deps(), workerId: 'worker-restarted' }
    await handleVideoMessage(restarted, message, 'queue')
    rig.queue.messages.push(message)
    await drive(handle, rig)
    assert.equal((await generation(handle.database)).status, 'succeeded')
    assert.equal(rig.submits(), 1)
  }
  finally { cleanup() }
})

test('T19 an old route snapshot stays on its provider after the default route changes', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle, {}, [routeA, routeB])
    const created = await create(handle, rig)
    assert.equal(created.ok, true)
    const disabledA: ProviderRoute = { ...routeA, enabled: false }
    rig.models = new ModelRegistry([model], [disabledA, routeB])
    const fresh = new (await import('../../video-core/src/router.ts')).ProviderRouter(rig.models, rig.providers)
    assert.equal(fresh.select(input).providerId, 'mock-b')
    await drive(handle, rig)
    const attempt = (await handle.database.select().from(videoAttempts))[0]!
    assert.equal(attempt.providerId, 'mock-a')
    assert.equal((await generation(handle.database)).routeSnapshot.providerId, 'mock-a')
  }
  finally { cleanup() }
})

test('T20 mock provider cost is zero and credits stay on the ledger', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    await create(handle, rig)
    await drive(handle, rig)
    const costs = await handle.database.select().from(videoProviderCosts)
    assert.equal(costs.length, 1)
    assert.equal(costs[0]!.costKind, 'actual')
    assert.equal(costs[0]!.amountMicros, 0)
    assert.equal(costs[0]!.currency, 'USD')
    assert.equal(costs[0]!.source, 'mock')
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 4)
    const consume = (await handle.database.select().from(videoCreditOperations)).find(row => row.operationType === 'consume')
    assert.equal(consume?.intendedQuantity, 6)
  }
  finally { cleanup() }
})

test('T21 a cash refund before a late generation failure keeps the clawback', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle, { outcome: 'failed' })
    await create(handle, rig)
    const historical = await applyRefundCreated(handle.database, {
      kind: 'refund.created', providerEventId: 'event-refund-1', eventType: 'refund.created', payloadHash: 'c'.repeat(64),
      refund: {
        providerRefundId: 'refund-1', providerOrderId: 'provider-order-1', status: 'succeeded', refundAmount: 1000,
        providerPaidAmount: 1000, currency: 'USD', providerTransactionId: 'txn-1', reasonCode: null,
      },
    })
    assert.equal(historical.ok, true)
    const adjustments = await handle.database.select().from(billingRefundCreditAdjustments)
    await drive(handle, rig)
    assert.equal((await generation(handle.database)).status, 'failed')
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 0)
    assert.deepEqual(await handle.database.select().from(billingRefundCreditAdjustments), adjustments)
    const settlements = await handle.database.select().from(billingRefundCreditSettlements)
    assert.equal(settlements.reduce((sum, row) => sum + row.quantity, 0), adjustments.reduce((sum, row) => sum + row.shortfallQuantity, 0))
    assert.equal((await handle.database.select().from(videoCreditOperations)).filter(row => row.operationType === 'return').length, 1)
  }
  finally { cleanup() }
})

test('T22 public preview files do not call the generation engine', () => {
  const root = join(import.meta.dirname, '../../..')
  const files: string[] = []
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else files.push(path)
    }
  }
  walk(join(root, 'app'))
  walk(join(root, 'server/api'))
  const hits = files.filter(path => {
    const text = readFileSync(path, 'utf8')
    return text.includes('create-generation') || text.includes('video-worker') || text.includes('/api/video') || text.includes('VIDEO_QUEUE')
  })
  assert.deepEqual(hits, [])
  const wrangler = readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
  assert.equal(wrangler.includes('queues'), false)
  assert.equal(wrangler.includes('r2_buckets'), false)
  const nuxt = readFileSync(join(root, 'nuxt.config.ts'), 'utf8')
  assert.equal(nuxt.includes('wrangler.video-local'), false)
  const pkg = readFileSync(join(root, 'package.json'), 'utf8')
  assert.equal(pkg.includes('workers/video-worker') && pkg.includes('"build"'), true)
  assert.equal(JSON.parse(pkg).scripts.build.includes('video-worker'), false)
})

async function eventForTest(handle: LedgerHandle, type: 'start_submission' | 'poll_status' | 'store_output') {
  const row = await generation(handle.database)
  const event = await readInflightOutbox(handle.database, row.id, type)
  assert.ok(event, 'missing durable event ' + type)
  return event.payload
}

test('R01 failed, succeeded and needs_review stop all outbox delivery', async () => {
  for (const scenario of [{ outcome: 'failed' as const }, {}, { statusUnavailableForMs: 3_600_000 }]) {
    const { handle, cleanup } = open()
    try {
      await seed(handle.database)
      const rig = world(handle, scenario)
      await create(handle, rig)
      await drive(handle, rig, 25)
      const row = await generation(handle.database)
      assert.ok(['failed', 'succeeded', 'needs_review'].includes(row.status))
      for (let tick = 1; tick <= 10; tick += 1) {
        assert.equal((await dispatchDueOutbox({ database: handle.database, queue: rig.queue,
          workerId: 'cron', nowMs: NOW_MS + tick * 61_000 })).sent, 0)
      }
      assert.equal((await handle.database.select().from(videoOutbox))
        .filter(row => row.deliveryStatus === 'pending' || row.deliveryStatus === 'leased').length, 0)
    } finally { cleanup() }
  }
})

test('R02 replay survives route, quote and deadline changes', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    const first = await create(handle, rig)
    assert.ok(first.ok)
    const replay = await createGeneration(handle.database, {
      userId: USER, idempotencyKey: 'idem-1', input, quote: null, nowMs: NOW_MS + 7_200_000, deadlineAtMs: 0,
    }, { models: new ModelRegistry([model], [{ ...routeB, enabled: false }]), providers: new ProviderRegistry([]) })
    assert.ok(replay.ok)
    if (first.ok && replay.ok) {
      assert.equal(replay.generationId, first.generationId)
      assert.equal(replay.replay, true)
    }
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 4)
    const conflict = await createGeneration(handle.database, {
      userId: USER, idempotencyKey: 'idem-1', input: { ...input, prompt: 'different' },
      quote: null, nowMs: NOW_MS, deadlineAtMs: 0,
    }, { models: rig.models, providers: rig.providers })
    assert.deepEqual(conflict, { ok: false, reason: 'idempotency_conflict' })
  } finally { cleanup() }
})

function barrier() {
  let enter!: () => void, resume!: () => void
  return {
    entered: new Promise<void>(resolve => { enter = resolve }),
    resumed: new Promise<void>(resolve => { resume = resolve }),
    enter: () => enter(), resume: () => resume(),
  }
}

test('R03 expired poll owner cannot advance after takeover or after I/O expiry', async () => {
  for (const takeover of [true, false]) {
    const { handle, cleanup } = open()
    try {
      await seed(handle.database)
      const rig = world(handle)
      await create(handle, rig)
      await handleVideoMessage(rig.deps(), rig.queue.messages.shift(), 'queue')
      const attempt = (await handle.database.select().from(videoAttempts))[0]!
      const gate = barrier()
      const inner = rig.inners[0]!
      let time = NOW_MS
      const providers = new ProviderRegistry([{ ...inner, async getStatus(saved, snapshot) {
        gate.enter(); await gate.resumed; return inner.getStatus(saved, snapshot)
      } }])
      const poll = await eventForTest(handle, 'poll_status')
      const pending = handleVideoMessage({ ...rig.deps(), providers, clock: { nowMs: () => time } }, poll, 'queue')
      await gate.entered
      time += 61_000
      if (takeover) assert.equal(await claimAttempt(handle.database, attempt.id,
        { owner: 'worker-b', token: 'successor', until: new Date(time + 60_000) }, new Date(time)), true)
      gate.resume()
      assert.equal(await pending, 'retry')
      assert.equal((await generation(handle.database)).status, 'processing')
      const owner = (await handle.database.select().from(videoAttempts))[0]!
      if (takeover) assert.equal(owner.leaseToken, 'successor')
      assert.equal((await handle.database.select().from(videoAssets)).length, 0)
    } finally { cleanup() }
  }
})

test('R04 accepted, generation edge and poll event commit together; late worker cannot regress storing', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    await create(handle, rig)
    const gate = barrier()
    const batch = handle.database.batch.bind(handle.database)
    let pause = true
    handle.database.batch = async (queries) => {
      const accepted = pause && queries.some(query => {
        const candidate = query as { toSQL?: () => { sql: string } }
        const sql = candidate.toSQL?.().sql ?? ''
        return sql.startsWith('update "video_attempts"') && sql.includes('"request_payload_hash" =')
      })
      const result = await batch(queries)
      if (accepted) { pause = false; gate.enter(); await gate.resumed }
      return result
    }
    const pending = handleVideoMessage(rig.deps(), rig.queue.messages.shift(), 'queue')
    await gate.entered
    assert.equal((await generation(handle.database)).status, 'processing')
    await handleVideoMessage({ ...rig.deps(), workerId: 'b' }, await eventForTest(handle, 'poll_status'), 'queue')
    assert.equal((await generation(handle.database)).status, 'storing')
    gate.resume()
    assert.equal(await pending, 'ack')
    const storing = await generation(handle.database)
    assert.equal(storing.status, 'storing')
    const currentAttempt = (await handle.database.select().from(videoAttempts))[0]!
    assert.throws(() => generationAdvanceStatement(handle.database, {
      generationId: storing.id, userId: USER, fromStatus: 'storing', event: 'recovered_accepted',
      expectedVersion: storing.statusVersion, now: NOW,
      attemptId: currentAttempt.id,
      lease: { owner: 'a', token: 'stale', until: new Date(NOW_MS + 60_000) },
    }), /Illegal generation transition/)
  } finally { cleanup() }
})

test('R05 recovered absence followed by acceptance and crash never gets deadline refund', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle, { submit: 'unknown', recovery: 'not_found' })
    const unknown = rig.inners[0]!
    const accepted = createMockProvider({ environment: 'test', providerId: routeB.providerId,
      scenario: { fixtureId: MOCK_FIXTURE_ID, completeAfterMs: 0 } }, { nowMs: () => NOW_MS })
    let submits = 0
    let acceptedId: string | null = null
    const providers = new ProviderRegistry([{ ...unknown, async submit(value) {
      submits += 1
      if (submits === 1) return unknown.submit(value)
      const result = await accepted.submit(value)
      if (result.kind === 'accepted') acceptedId = result.handle.jobId
      throw new Error('interrupted-after-acceptance')
    } }])
    const deps = { ...rig.deps(), providers }
    await create(handle, rig)
    await handleVideoMessage(deps, rig.queue.messages.shift(), 'queue')
    await handleVideoMessage(deps, await eventForTest(handle, 'poll_status'), 'queue')
    assert.equal((await generation(handle.database)).status, 'queued')
    assert.equal((await handle.database.select().from(videoAttempts)).length, 1)
    await assert.rejects(handleVideoMessage(deps, await eventForTest(handle, 'start_submission'), 'queue'), /interrupted-after/)
    assert.ok(acceptedId)
    assert.equal((await generation(handle.database)).status, 'submitting')
    const later = { ...deps, clock: { nowMs: () => NOW_MS + 3_601_000 } }
    await runMaintenance({ ...later, queue: rig.queue })
    assert.equal((await generation(handle.database)).status, 'needs_review')
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 4)
    assert.equal((await handle.database.select().from(videoCreditOperations)).filter(r => r.operationType === 'return').length, 0)
    assert.equal(submits, 2)
  } finally { cleanup() }
})

test('R05 ledger itself rejects queued deadline settlement with unresolved dispatch', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    rig.armCrash()
    await create(handle, rig)
    await assert.rejects(handleVideoMessage(rig.deps(), rig.queue.messages.shift(), 'queue'))
    const row = await generation(handle.database)
    // Simulate a malformed historical queued row: the ledger must fail closed.
    await handle.database.update(videoGenerations).set({ status: 'queued' }).where(eq(videoGenerations.id, row.id))
    const now = new Date(NOW_MS + 3_601_000)
    const event = await readInflightOutbox(handle.database, row.id, 'start_submission')
    assert.ok(event)
    await handle.database.update(videoOutbox).set({ deliveryStatus: 'leased', leaseOwner: 'deadline',
      leaseToken: 'deadline', leaseUntil: new Date(now.getTime() + 60_000) }).where(eq(videoOutbox.id, event.id))
    const result = await returnCreditsForFailedGeneration(handle.database, {
      userId: USER, generationId: row.id, operationId: videoReturnOperationKey(row.id),
      event: 'deadline_reached', expectedVersion: row.statusVersion, leaseOwner: 'deadline',
      leaseToken: 'deadline', errorCode: 'deadline', nowMs: now.getTime(),
    })
    assert.equal(result.ok, false)
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 4)
    assert.equal((await generation(handle.database)).status, 'queued')
  } finally { cleanup() }
})

test('R06 persistent storage errors exhaust a durable budget, never Submit or refund', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    let puts = 0
    rig.store.put = async () => { puts += 1; throw new Error('R2 down') }
    await create(handle, rig)
    await drive(handle, rig, 25)
    const row = await generation(handle.database)
    assert.equal(row.status, 'needs_review')
    assert.equal(row.errorCode, 'storage_budget_exhausted')
    assert.equal(puts, 6)
    assert.equal(rig.submits(), 1)
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 4)
    const metadata = (await handle.database.select().from(videoAttempts))[0]!.recoveryMetadata
    assert.equal(metadata?.storageCount, 6)
    assert.equal((await dispatchDueOutbox({ database: handle.database, queue: rig.queue,
      workerId: 'cron', nowMs: NOW_MS + 61_000 })).sent, 0)
  } finally { cleanup() }
})

test('R07 a missing attempt never reports a successful claim', async () => {
  const { handle, cleanup } = open()
  try {
    assert.equal(await claimAttempt(handle.database, 'missing', {
      owner: 'a', token: 'a', until: new Date(NOW_MS + 60_000),
    }, NOW), false)
  } finally { cleanup() }
})

test('R09 dead first event recovers at deadline and settles exactly once', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    rig.queue.failSends = 100
    await create(handle, rig)
    for (let tick = 1; tick <= 7; tick += 1) await dispatchDueOutbox({
      database: handle.database, queue: rig.queue, workerId: 'dispatcher', nowMs: NOW_MS + tick * 301_000,
    })
    assert.equal((await handle.database.select().from(videoOutbox))[0]!.deliveryStatus, 'dead')
    for (let tick = 0; tick < 3; tick += 1) await runMaintenance({
      ...rig.deps(), queue: rig.queue, clock: { nowMs: () => NOW_MS + 3_601_000 + tick * 61_000 },
    })
    assert.equal((await generation(handle.database)).status, 'failed')
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 10)
    assert.equal(rig.submits(), 0)
    assert.equal((await handle.database.select().from(videoCreditOperations)).filter(row => row.operationType === 'return').length, 1)
  } finally { cleanup() }
})

test('R10 different keys racing for the same credits cannot overspend', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    const outcomes = await Promise.all([create(handle, rig, 'a'), create(handle, rig, 'b')])
    assert.equal(outcomes.filter(row => row.ok).length, 1)
    assert.equal((await handle.database.select().from(videoGenerations)).length, 1)
    assert.equal((await handle.database.select().from(videoCreditOperations)).length, 1)
    assert.equal((await handle.database.select().from(videoOutbox)).length, 1)
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 4)
  } finally { cleanup() }
})

test('R11 lost commit response returns the same generation and one charge', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    const batch = handle.database.batch.bind(handle.database)
    let fail = true
    handle.database.batch = async queries => {
      const result = await batch(queries)
      if (fail) { fail = false; throw new Error('commit response lost') }
      return result
    }
    const first = await create(handle, rig)
    const replay = await create(handle, rig)
    assert.ok(first.ok && replay.ok)
    if (first.ok && replay.ok) assert.equal(first.generationId, replay.generationId)
    assert.equal((await handle.database.select().from(videoCreditOperations)).length, 1)
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 4)
  } finally { cleanup() }
})

test('R12 storage deadline survives restarts and does not reuse task scan timestamps', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    await create(handle, rig)
    await drive(handle, rig, 2)
    assert.equal((await generation(handle.database)).status, 'storing')
    const advanced = NOW_MS + 11 * 60_000
    await runMaintenance({ ...rig.deps(), queue: rig.queue, clock: { nowMs: () => advanced } })
    assert.equal((await generation(handle.database)).status, 'needs_review')
    assert.equal((await generation(handle.database)).errorCode, 'storage_deadline_exceeded')
    assert.equal(rig.submits(), 1)
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 4)
  } finally { cleanup() }
})

test('R13 exhausted successful sends stop instead of creating an endless outbox loop', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    await create(handle, rig)
    for (let tick = 1; tick <= 12; tick += 1) {
      await dispatchDueOutbox({ database: handle.database, queue: rig.queue, workerId: 'cron', nowMs: NOW_MS + tick * 61_000 })
    }
    assert.equal((await handle.database.select().from(videoOutbox))[0]!.deliveryStatus, 'dead')
    assert.equal(rig.queue.messages.length, 8)
    assert.equal(rig.submits(), 0)
  } finally { cleanup() }
})

test('R14 a failed accepted batch does not save half of the acceptance protocol', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    await create(handle, rig)
    handle.sqlite.exec("CREATE TRIGGER fail_poll BEFORE INSERT ON video_outbox WHEN NEW.event_type = 'poll_status' BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: poll'); END")
    assert.equal(await handleVideoMessage(rig.deps(), rig.queue.messages.shift(), 'queue'), 'retry')
    assert.equal((await generation(handle.database)).status, 'submitting')
    assert.equal((await handle.database.select().from(videoAttempts))[0]!.providerRequestId, null)
    handle.sqlite.exec('DROP TRIGGER fail_poll')
    await handle.database.update(videoAttempts).set({ leaseUntil: new Date(NOW_MS - 1000) })
    await handleVideoMessage(rig.deps(), await eventForTest(handle, 'start_submission'), 'queue')
    await drive(handle, rig)
    assert.equal((await generation(handle.database)).status, 'succeeded')
    assert.equal(rig.submits(), 1)
  } finally { cleanup() }
})

test('R15 same key replay does not require an input asset to remain available', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    const capability = { ...textCapability, id: 'image', mode: 'image-to-video' as const }
    const models = new ModelRegistry([{ ...model, capabilities: [capability] }], [{ ...routeB, capabilityConstraints: [capability] }])
    await handle.database.insert(videoAssets).values({
      id: 'image', userId: USER, kind: 'image', objectKey: 'private/image', contentType: 'image/png',
      byteSize: 1, contentHash: 'a'.repeat(64), hashAlgorithm: 'sha256', status: 'available', createdAt: NOW,
    })
    const body = { ...input, mode: 'image-to-video', imageAssetId: 'image' }
    const command = { userId: USER, idempotencyKey: 'image-key', input: body, quote, nowMs: NOW_MS, deadlineAtMs: NOW_MS + 3_600_000 }
    const first = await createGeneration(handle.database, command, { models, providers: rig.providers })
    assert.ok(first.ok)
    await handle.database.update(videoAssets).set({ status: 'expired' }).where(eq(videoAssets.id, 'image'))
    const replay = await createGeneration(handle.database, command, { models, providers: rig.providers })
    assert.ok(replay.ok && replay.replay)
    if (first.ok && replay.ok) assert.equal(first.generationId, replay.generationId)
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 4)
  } finally { cleanup() }
})

test('R16 bounded maintenance rotates past twenty tasks without business progress', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    const ids: string[] = []
    for (let i = 0; i < 21; i += 1) {
      const result = await create(handle, rig, 'fair-' + i, input, 0)
      assert.ok(result.ok)
      if (result.ok) ids.push(result.generationId)
    }
    for (const id of ids.slice(0, 20)) await handle.database.update(videoGenerations)
      .set({ updatedAt: new Date(NOW_MS - 60_000) }).where(eq(videoGenerations.id, id))
    const last = ids.at(-1)!
    await handle.database.update(videoGenerations).set({ updatedAt: new Date(NOW_MS - 30_000) }).where(eq(videoGenerations.id, last))
    await runMaintenance({ ...rig.deps(), queue: rig.queue })
    const firstScan = await handle.database.select().from(videoGenerations).where(eq(videoGenerations.id, last))
    assert.equal(firstScan[0]!.updatedAt.getTime(), NOW_MS - 30_000)
    await runMaintenance({ ...rig.deps(), queue: rig.queue, clock: { nowMs: () => NOW_MS + 1000 } })
    const secondScan = await handle.database.select().from(videoGenerations).where(eq(videoGenerations.id, last))
    assert.equal(secondScan[0]!.updatedAt.getTime(), NOW_MS + 1000)
    assert.equal(rig.submits(), 0)
  } finally { cleanup() }
})

test('R17 exhausted poll delivery stops in needs_review without resetting its budget', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    await create(handle, rig)
    await handleVideoMessage(rig.deps(), rig.queue.messages.shift(), 'queue')
    rig.queue.failPolls = true
    await dispatchDueOutbox({ database: handle.database, queue: rig.queue, workerId: 'dispatch',
      nowMs: NOW_MS, limits: { outboxMaxDeliveries: 1 } })
    assert.equal((await generation(handle.database)).status, 'needs_review')
    for (let i = 1; i <= 5; i += 1) await runMaintenance({
      ...rig.deps(), queue: rig.queue, clock: { nowMs: () => NOW_MS + i * 61_000 },
    })
    assert.equal((await handle.database.select().from(videoOutbox)).filter(r => r.eventType === 'poll_status').length, 1)
    assert.equal(rig.submits(), 1)
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 4)
  } finally { cleanup() }
})

test('R18 an old R2 writer cannot replace the winning output or register after lease takeover', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    await create(handle, rig)
    await drive(handle, rig, 2)
    const gate = barrier()
    const put = rig.store.put.bind(rig.store)
    let pause = true
    rig.store.put = async (...args) => {
      if (pause) { pause = false; gate.enter(); await gate.resumed }
      return put(...args)
    }
    let clock = NOW_MS
    const event = await eventForTest(handle, 'store_output')
    const first = handleVideoMessage({ ...rig.deps(), clock: { nowMs: () => clock } }, event, 'queue')
    await gate.entered
    clock += 61_000
    assert.equal(await handleVideoMessage({ ...rig.deps(), workerId: 'b', clock: { nowMs: () => clock } }, event, 'queue'), 'ack')
    const winner = await generation(handle.database)
    assert.equal(winner.status, 'succeeded')
    const object = (await handle.database.select().from(videoAssets))[0]!
    const bytes = rig.store.objects.get(object.objectKey)!.body.slice()
    gate.resume()
    assert.equal(await first, 'retry')
    assert.equal((await generation(handle.database)).outputAssetId, winner.outputAssetId)
    assert.equal((await handle.database.select().from(videoAssets)).length, 1)
    assert.deepEqual(rig.store.objects.get(object.objectKey)!.body, bytes)
  } finally { cleanup() }
})

test('R19 terminal cleanup uses a persisted cursor and protects the referenced asset', async () => {
  const { cleanupTerminalObjects } = await import('../src/video/cleanup.ts')
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    await create(handle, rig)
    await drive(handle, rig)
    const attempt = (await handle.database.select().from(videoAttempts))[0]!
    const asset = (await handle.database.select().from(videoAssets))[0]!
    const prefix = asset.objectKey.split('/outputs/')[0]! + '/'
    const tmp = prefix + 'tmp/old-lease.mp4'
    const orphan = prefix + 'outputs/old-hash/output.mp4'
    await rig.store.put(tmp, MOCK_FIXTURE_BYTES, 'video/mp4', MOCK_FIXTURE_SHA256)
    await rig.store.put(orphan, MOCK_FIXTURE_BYTES, 'video/mp4', MOCK_FIXTURE_SHA256)
    const cursors: (string | undefined)[] = []
    const store = {
      put: rig.store.put.bind(rig.store), head: rig.store.head.bind(rig.store), delete: rig.store.delete.bind(rig.store),
      async list(actualPrefix: string, _limit: number, cursor?: string) {
        assert.equal(actualPrefix, prefix)
        cursors.push(cursor)
        return cursor === 'next'
          ? { objects: [{ key: orphan, uploadedAtMs: NOW_MS }] }
          : { objects: [asset.objectKey, tmp].map(key => ({ key, uploadedAtMs: NOW_MS })), cursor: 'next' }
      },
    }
    const later = new Date(NOW_MS + 25 * 60 * 60_000)
    await cleanupTerminalObjects({ ...rig.deps(), store }, later)
    assert.equal(rig.store.objects.has(tmp), false)
    assert.equal(rig.store.objects.has(asset.objectKey), true)
    assert.equal((await handle.database.select().from(videoAttempts))[0]!.recoveryMetadata?.cleanupCursor, 'next')
    await cleanupTerminalObjects({ ...rig.deps(), store }, later)
    assert.deepEqual(cursors, [undefined, 'next'])
    assert.equal(rig.store.objects.has(orphan), false)
    assert.equal(rig.store.objects.has(asset.objectKey), true)
    assert.deepEqual((await handle.database.select().from(videoAttempts))[0]!.recoveryMetadata?.providerMetadata, attempt.recoveryMetadata?.providerMetadata)
  } finally { cleanup() }
})

test('R20 repeated authoritative absence reaches one refund after the submission budget', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle, { submit: 'unknown', recovery: 'not_found' })
    await create(handle, rig)
    await drive(handle, rig, 30)
    assert.equal((await generation(handle.database)).status, 'failed')
    assert.equal(rig.submits(), 3)
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 10)
    assert.equal((await handle.database.select().from(videoCreditOperations)).filter(r => r.operationType === 'return').length, 1)
    assert.equal((await handle.database.select().from(videoAttempts)).length, 3)
  } finally { cleanup() }
})

test('R21 confirmed retryable rejections exhaust only the submit budget', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle, { submit: 'rejected', failureCode: 'rate_limited' })
    await create(handle, rig)
    await drive(handle, rig, 20)
    assert.equal((await generation(handle.database)).status, 'failed')
    assert.equal(rig.submits(), 3)
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 10)
    assert.equal((await handle.database.select().from(videoProviderCosts)).length, 0)
  } finally { cleanup() }
})

test('R22 concurrent identical creation keys return one generation and one charge', async () => {
  const { handle, cleanup } = open()
  try {
    await seed(handle.database)
    const rig = world(handle)
    const results = await Promise.all([create(handle, rig), create(handle, rig)])
    assert.ok(results.every(r => r.ok))
    const ids = results.flatMap(r => r.ok ? [r.generationId] : [])
    assert.equal(new Set(ids).size, 1)
    assert.equal((await handle.database.select().from(videoGenerations)).length, 1)
    assert.equal((await handle.database.select().from(videoOutbox)).length, 1)
    assert.equal(await getAvailableCredits(handle.database, USER, NOW), 4)
  } finally { cleanup() }
})
