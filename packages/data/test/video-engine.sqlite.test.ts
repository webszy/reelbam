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
import { saveAcceptedAttempt } from '../src/video/durable.ts'
import { MOCK_FIXTURE_BYTES } from '../../../workers/video-worker/src/fixture.ts'
import { MOCK_FIXTURE_ID, type VideoQueueMessage } from '../src/video/protocol.ts'
import { reclaimOutboxLease } from '../src/video/durable.ts'
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
  readonly objects = new Map<string, { body: Uint8Array, contentType: string }>()
  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType })
  }
  async head(key: string): Promise<{ byteSize: number, contentType: string } | null> {
    const found = this.objects.get(key)
    return found ? { byteSize: found.body.byteLength, contentType: found.contentType } : null
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
    fixture: { fixtureId: MOCK_FIXTURE_ID, bytes: MOCK_FIXTURE_BYTES, contentType: 'video/mp4' },
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
    const message = {
      messageVersion: 1 as const, eventId: 'store-race', generationId: row.id, eventType: 'store_output' as const,
      stepId: 'generate' as const, attemptId: (await handle.database.select().from(videoAttempts))[0]!.id,
    }
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
