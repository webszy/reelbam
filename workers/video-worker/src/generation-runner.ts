import { createDatabase } from '../../../packages/data/src/client.ts'
import { handleVideoMessage, type VideoEngineDeps } from '../../../packages/data/src/video/engine.ts'
import { MOCK_FIXTURE_ID } from '../../../packages/data/src/video/protocol.ts'
import { ProviderRegistry } from '../../../packages/video-core/src/providers/registry.ts'
import { parseVideoWorkerEnvironment, type VideoWorkerEnv } from './bindings.ts'
import { localMockRegistries } from './catalog.ts'
import { MOCK_FIXTURE_BYTES, MOCK_FIXTURE_SHA256 } from './fixture.ts'
import { r2ObjectStore } from './storage.ts'

export function engineDeps(env: VideoWorkerEnv): VideoEngineDeps {
  const environment = parseVideoWorkerEnvironment(env.APP_ENVIRONMENT)
  return {
    database: createDatabase(env.DB),
    providers: environment === 'production' ? new ProviderRegistry([]) : localMockRegistries(environment, { nowMs: () => Date.now() }).providers,
    store: r2ObjectStore(env.VIDEO_BUCKET),
    clock: { nowMs: () => Date.now() },
    workerId: 'reelbam-video-worker',
    environment,
    fixture: { fixtureId: MOCK_FIXTURE_ID, bytes: MOCK_FIXTURE_BYTES, contentType: 'video/mp4', contentHash: MOCK_FIXTURE_SHA256 },
  }
}

export async function runQueueMessage(env: VideoWorkerEnv, body: unknown, source: 'queue' | 'dlq') {
  return handleVideoMessage(engineDeps(env), body, source)
}
