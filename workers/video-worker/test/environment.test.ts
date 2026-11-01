import assert from 'node:assert/strict'
import test from 'node:test'
import { openLedgerDatabase } from '../../../packages/data/test/ledger-harness.ts'
import { ProviderRouter } from '../../../packages/video-core/src/router.ts'
import type { VideoWorkerEnv } from '../src/bindings.ts'
import { localMockRegistries } from '../src/catalog.ts'
import { engineDeps } from '../src/generation-runner.ts'
import { runScheduledMaintenance } from '../src/maintenance.ts'

const invalidEnvironments = [undefined, '', ' ', 'staging', 'Production', 'development ', 'dev']

for (const environment of invalidEnvironments) {
  test(`Worker rejects APP_ENVIRONMENT=${JSON.stringify(environment)} before accessing bindings`, async () => {
    const env: VideoWorkerEnv = {
      ...(environment === undefined ? {} : { APP_ENVIRONMENT: environment }),
      get DB(): VideoWorkerEnv['DB'] { throw new Error('DB_ACCESSED_BEFORE_VALIDATION') },
      get VIDEO_BUCKET(): VideoWorkerEnv['VIDEO_BUCKET'] { throw new Error('R2_ACCESSED_BEFORE_VALIDATION') },
      get VIDEO_QUEUE(): VideoWorkerEnv['VIDEO_QUEUE'] { throw new Error('QUEUE_ACCESSED_BEFORE_VALIDATION') },
    }
    assert.throws(() => engineDeps(env), /INVALID_APP_ENVIRONMENT/)
    await assert.rejects(runScheduledMaintenance(env), /INVALID_APP_ENVIRONMENT/)
  })
}

test('Worker enables Mock only in development/test and registers no production fallback', () => {
  const ledger = openLedgerDatabase(':memory:')
  const bindings: Omit<VideoWorkerEnv, 'APP_ENVIRONMENT'> = {
    DB: ledger.database.$client,
    VIDEO_BUCKET: {
      async put() { assert.fail('unexpected R2 write') },
      async head() { assert.fail('unexpected R2 read') },
      async delete() { assert.fail('unexpected R2 delete') },
      async list() { assert.fail('unexpected R2 list') },
    },
    VIDEO_QUEUE: { async send() { assert.fail('unexpected Queue send') } },
  }
  try {
    const registries = localMockRegistries('test', { nowMs: () => 0 })
    const snapshot = new ProviderRouter(registries.models, registries.providers).select({
      modelId: 'mock-motion', mode: 'text-to-video', prompt: 'environment regression',
      parameters: { durationSeconds: 5, resolution: '720p' },
    })
    for (const environment of ['development', 'test'] as const) {
      const deps = engineDeps({ ...bindings, APP_ENVIRONMENT: environment })
      assert.equal(deps.environment, environment)
      assert.equal(deps.providers.forSnapshot(snapshot).id, 'mock-local')
    }
    const production = engineDeps({ ...bindings, APP_ENVIRONMENT: 'production' })
    assert.equal(production.environment, 'production')
    assert.throws(() => production.providers.forSnapshot(snapshot), /Provider adapter unavailable/)
    assert.throws(() => localMockRegistries('production', { nowMs: () => 0 }), /explicit development or test/)
  }
  finally {
    ledger.close()
  }
})
