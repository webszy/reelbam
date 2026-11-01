import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Miniflare } from '../../../node_modules/.pnpm/miniflare@4.20260722.0/node_modules/miniflare/dist/src/index.js'
import { createDatabase } from '../../../packages/data/src/client.ts'
import { createGeneration } from '../../../server/services/video/create-generation.ts'
import { dispatchDueOutbox } from '../../../packages/data/src/video/dispatch.ts'
import { getAvailableCredits } from '../../../packages/data/src/credits/spendable.ts'
import { entitlementGrants, entitlementTransactions } from '../../../packages/data/src/schema/billing.ts'
import { localMockRegistries } from '../src/catalog.ts'
import { r2ObjectStore } from '../src/storage.ts'
import { MOCK_FIXTURE_BYTES, MOCK_FIXTURE_SHA256 } from '../src/fixture.ts'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const require = createRequire(realpathSync(join(root, 'node_modules/wrangler/package.json')))
const { build } = require('esbuild')

async function runtimeOptions(directory) {
  const bundle = await build({ entryPoints: [join(root, 'workers/video-worker/src/index.ts')],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:crypto'],
    write: false, tsconfig: join(root, 'tsconfig.video.json') })
  const shared = { modules: true, d1Databases: { DB: 'reliability' }, r2Buckets: { VIDEO_BUCKET: 'output' },
    compatibilityDate: '2026-07-28', compatibilityFlags: ['nodejs_compat'] }
  return {
    d1Persist: join(directory, 'd1'), r2Persist: join(directory, 'r2'),
    workers: [
      { ...shared, name: 'web', script: 'export default { fetch() { return new Response("local only") } }',
        queueProducers: { VIDEO_QUEUE: 'reelbam-video-jobs' } },
      { ...shared, name: 'video', script: bundle.outputFiles[0].text, bindings: { APP_ENVIRONMENT: 'test' },
        queueProducers: { VIDEO_QUEUE: 'reelbam-video-jobs' },
        queueConsumers: {
          'reelbam-video-jobs': { maxBatchTimeout: 0.01, maxRetries: 3, deadLetterQueue: 'reelbam-video-jobs-dlq' },
          'reelbam-video-jobs-dlq': { maxBatchTimeout: 0.01, maxRetries: 1 },
        } },
    ],
  }
}

async function migrate(binding) {
  for (const file of ['0000_fast_magdalene.sql', '0001_video_business.sql', '0002_provider_cost_check.sql', '0003_ledger_integrity.sql']) {
    for (const statement of readFileSync(join(root, 'drizzle', file), 'utf8').split('--> statement-breakpoint')) {
      if (statement.trim()) await binding.prepare(statement).run()
    }
  }
}

async function seed(database) {
  const now = new Date()
  const { users } = await import('../../../packages/data/src/schema/billing.ts')
  await database.insert(users).values({ id: 'runtime-user', clerkUserId: 'runtime-clerk', createdAt: now, updatedAt: now, lastSeenAt: now })
  await database.batch([
    database.insert(entitlementGrants).values({
      id: 'runtime-grant', userId: 'runtime-user', entitlementKey: 'credits', entitlementType: 'consumable',
      sourceType: 'promotion', sourceId: 'runtime-test', periodKey: 'once', grantedQuantity: 10, remainingQuantity: 10,
      effectiveAt: new Date(now.getTime() - 1000), status: 'active', createdAt: now, updatedAt: now,
    }),
    database.insert(entitlementTransactions).values({
      id: 'runtime-initial', userId: 'runtime-user', grantId: 'runtime-grant', transactionType: 'grant', quantity: 10,
      sourceType: 'promotion', sourceId: 'runtime-test', balanceBefore: 0, balanceAfter: 10,
      idempotencyKey: 'runtime-initial', createdAt: now,
    }),
  ])
}

async function waitUntil(check, message, passes = 100) {
  for (let i = 0; i < passes; i += 1) {
    const found = await check()
    if (found) return found
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(message)
}

const quote = { schemaVersion: 1, creditAmount: 6, pricingRuleId: 'runtime', pricingRuleRevision: 1, unit: 'credit' }

test('actual Worker scheduled handler recovers R2 put / D1 registration failure across a workerd restart', { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reelbam-runtime-'))
  const options = await runtimeOptions(directory)
  let mf = new Miniflare(options)
  try {
    let binding = await mf.getD1Database('DB', 'web')
    await migrate(binding)
    let database = createDatabase(binding)
    await seed(database)
    await binding.prepare("CREATE TRIGGER review_block_output BEFORE INSERT ON video_assets WHEN NEW.kind = 'output_video' BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: temporary_storage_registration'); END").run()
    const registries = localMockRegistries('test', { nowMs: () => Date.now() })
    let queue = await mf.getQueueProducer('VIDEO_QUEUE', 'web')
    const nowMs = Date.now()
    const command = { userId: 'runtime-user', idempotencyKey: 'runtime-key',
      input: { modelId: 'mock-motion', mode: 'text-to-video', prompt: 'local mock only',
        parameters: { durationSeconds: 5, resolution: '720p' } },
      quote, nowMs, deadlineAtMs: nowMs + 3_600_000 }
    const created = await createGeneration(database, command, { ...registries, queue })
    assert.ok(created.ok)
    let bucket = await mf.getR2Bucket('VIDEO_BUCKET', 'web')
    const saved = await waitUntil(async () => {
      await dispatchDueOutbox({ database, queue, workerId: 'test-cron', nowMs: Date.now() })
      const row = await binding.prepare('select * from video_generations where id = ?').bind(created.generationId).first()
      const objects = await bucket.list()
      if (row?.status === 'storing' && objects.objects.length) {
        const attempts = await binding.prepare('select * from video_attempts').all()
        return { row, key: objects.objects[0].key, attempt: attempts.results[0] }
      }
      return null
    }, 'object was not stored before the injected D1 failure')
    assert.equal(saved.attempt.acceptance_status, 'accepted')
    assert.ok(saved.attempt.provider_request_id)
    assert.equal((await binding.prepare('select count(*) n from video_assets').first()).n, 0)
    assert.equal(await getAvailableCredits(database, 'runtime-user', new Date()), 4)
    await binding.prepare('DROP TRIGGER review_block_output').run()
    await mf.dispose()

    // New Miniflare and workerd processes share only persisted D1/R2; Queue memory is discarded.
    mf = new Miniflare(options)
    binding = await mf.getD1Database('DB', 'web')
    database = createDatabase(binding)
    bucket = await mf.getR2Bucket('VIDEO_BUCKET', 'web')
    queue = await mf.getQueueProducer('VIDEO_QUEUE', 'web')
    // Deterministically advance the persisted lease, avoiding a 30-second test sleep.
    await binding.prepare("update video_attempts set lease_until = 0 where lease_until is not null").run()
    await binding.prepare("update video_outbox set lease_until = 0 where delivery_status = 'leased'").run()
    await binding.prepare("update video_outbox set next_retry_at = 0 where delivery_status = 'pending'").run()
    const restartedWorker = await mf.getWorker('video')
    const done = await waitUntil(async () => {
      const scheduled = await restartedWorker.scheduled({ cron: '*/1 * * * *' })
      assert.equal(scheduled.outcome, 'ok')
      const row = await binding.prepare('select * from video_generations where id = ?').bind(created.generationId).first()
      return row?.status === 'succeeded' ? row : null
    }, 'worker did not register its existing object after restart')

    const assets = (await binding.prepare('select * from video_assets').all()).results
    assert.equal(assets.length, 1)
    assert.equal(assets[0].id, done.output_asset_id)
    assert.equal(assets[0].object_key, saved.key)
    assert.equal(assets[0].content_hash, MOCK_FIXTURE_SHA256)
    const output = await bucket.get(saved.key)
    assert.ok(output)
    const bytes = new Uint8Array(await output.arrayBuffer())
    assert.deepEqual(bytes, MOCK_FIXTURE_BYTES)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), MOCK_FIXTURE_SHA256)
    const attempts = (await binding.prepare('select * from video_attempts').all()).results
    assert.equal(attempts.length, 1)
    assert.equal(attempts[0].provider_request_id, saved.attempt.provider_request_id)
    assert.equal(await getAvailableCredits(database, 'runtime-user', new Date()), 4)
    const costs = (await binding.prepare('select * from video_provider_costs').all()).results
    assert.equal(costs.length, 1)
    assert.equal(costs[0].amount_micros, 0)
    assert.equal(costs[0].currency, 'USD')
    const replay = await createGeneration(database, { ...command, quote: null, deadlineAtMs: 0 }, registries)
    assert.ok(replay.ok && replay.replay)
    assert.equal(replay.generationId, created.generationId)

    // Conditional writes protect the referenced object even from a stale writer.
    const store = r2ObjectStore(bucket)
    await store.put(saved.key, new Uint8Array([1, 2, 3]), 'video/mp4',
      createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'))
    assert.deepEqual(new Uint8Array(await (await bucket.get(saved.key)).arrayBuffer()), MOCK_FIXTURE_BYTES)
    assert.equal((await store.head(saved.key)).contentHash, MOCK_FIXTURE_SHA256)

    await binding.prepare("CREATE TRIGGER fail_outbox BEFORE INSERT ON video_outbox BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: test_outbox'); END").run()
    const rejected = await createGeneration(database, { ...command, idempotencyKey: 'rollback', quote: { ...quote, creditAmount: 2 } }, registries)
    assert.equal(rejected.ok, false)
    assert.equal((await binding.prepare('select count(*) n from video_generations').first()).n, 1)
    assert.equal(await getAvailableCredits(database, 'runtime-user', new Date()), 4)
  } finally {
    await mf.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('actual Worker rejects an invalid environment and production never executes a saved Mock route', { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reelbam-environment-'))
  const options = await runtimeOptions(directory)
  options.workers[1].bindings.APP_ENVIRONMENT = 'staging'
  let mf = new Miniflare(options)
  try {
    let binding = await mf.getD1Database('DB', 'web')
    await migrate(binding)
    let database = createDatabase(binding)
    await seed(database)
    const registries = localMockRegistries('test', { nowMs: () => Date.now() })
    const nowMs = Date.now()
    const created = await createGeneration(database, {
      userId: 'runtime-user', idempotencyKey: 'environment-boundary',
      input: { modelId: 'mock-motion', mode: 'text-to-video', prompt: 'environment boundary',
        parameters: { durationSeconds: 5, resolution: '720p' } },
      quote, nowMs, deadlineAtMs: nowMs + 3_600_000,
    }, registries)
    assert.ok(created.ok)
    const invalid = await (await mf.getWorker('video')).scheduled({ cron: '*/1 * * * *' })
    assert.equal(invalid.outcome, 'exception')
    assert.equal((await binding.prepare('select status from video_generations where id = ?').bind(created.generationId).first()).status, 'queued')
    assert.equal((await binding.prepare('select count(*) n from video_attempts').first()).n, 0)
    await mf.dispose()

    options.workers[1].bindings.APP_ENVIRONMENT = 'production'
    mf = new Miniflare(options)
    binding = await mf.getD1Database('DB', 'web')
    database = createDatabase(binding)
    const production = await (await mf.getWorker('video')).scheduled({ cron: '*/1 * * * *' })
    assert.equal(production.outcome, 'ok')
    const parked = await waitUntil(async () => {
      const row = await binding.prepare('select * from video_generations where id = ?').bind(created.generationId).first()
      return row?.status === 'needs_review' ? row : null
    }, 'production unexpectedly executed the saved Mock route')
    assert.equal(parked.error_code, 'provider_adapter_missing')
    const attempts = (await binding.prepare('select * from video_attempts').all()).results
    assert.equal(attempts.length, 1)
    assert.equal(attempts[0].acceptance_status, 'not_submitted')
    assert.equal(attempts[0].provider_request_id, null)
    assert.equal(attempts[0].submitted_at, null)
    assert.equal((await binding.prepare('select count(*) n from video_credit_operations where operation_type = ?').bind('return').first()).n, 0)
    assert.equal((await binding.prepare('select count(*) n from video_provider_costs').first()).n, 0)
    assert.equal((await (await mf.getR2Bucket('VIDEO_BUCKET', 'web')).list()).objects.length, 0)
    assert.equal(await getAvailableCredits(database, 'runtime-user', new Date()), 4)
  }
  finally {
    await mf.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})
