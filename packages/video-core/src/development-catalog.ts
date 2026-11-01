import type { LogicalModel } from '@reelbam/video-contracts'
import type { ProviderRoute } from '@reelbam/video-contracts/internal'
import type { Clock } from './provider.ts'
import { ModelRegistry } from './model-registry.ts'
import { createMockProvider } from './providers/mock.ts'
import { ProviderRegistry } from './providers/registry.ts'
import { frozenCopy } from './value.ts'

const text = {
  id: 'text',
  mode: 'text-to-video' as const,
  prompt: 'required' as const,
  durationSeconds: [5, 6],
  resolutions: ['720p'],
  optionalParameters: { aspectRatios: ['9:16'] },
}

/** Simulated capabilities only. The output fixture remains approximately 1 s. */
export const LOCAL_MOCK_MODEL: LogicalModel = frozenCopy({
  id: 'mock-motion', revision: 2, name: 'Mock Motion', capabilities: [text],
})

export const LOCAL_MOCK_ROUTE: ProviderRoute = frozenCopy({
  routeId: 'mock-motion-local', revision: 2, modelId: LOCAL_MOCK_MODEL.id,
  providerId: 'mock-local', providerModelId: 'mock-motion', adapterVersion: 'mock-v1',
  enabled: true, priority: 1, capabilityConstraints: [text],
})

/** One catalog for the server and Worker. Production/unknown environments throw. */
export function createLocalMockRegistries(environment: string, clock: Clock, fixtureId = 'reelbam/mock-video-v1') {
  const providers = new ProviderRegistry([
    createMockProvider({
      environment,
      providerId: LOCAL_MOCK_ROUTE.providerId,
      adapterVersion: LOCAL_MOCK_ROUTE.adapterVersion,
      scenario: { fixtureId, completeAfterMs: 0 },
    }, clock),
  ])
  return { models: new ModelRegistry([LOCAL_MOCK_MODEL], [LOCAL_MOCK_ROUTE]), providers }
}
