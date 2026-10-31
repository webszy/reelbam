import type { LogicalModel } from '../../../packages/video-contracts/src/public.ts'
import type { ProviderRoute } from '../../../packages/video-contracts/src/internal.ts'
import { ModelRegistry } from '../../../packages/video-core/src/model-registry.ts'
import { createMockProvider } from '../../../packages/video-core/src/providers/mock.ts'
import { ProviderRegistry } from '../../../packages/video-core/src/providers/registry.ts'
import { MOCK_FIXTURE_ID } from '../../../packages/data/src/video/protocol.ts'

const text = {
  id: 'text',
  mode: 'text-to-video' as const,
  prompt: 'required' as const,
  durationSeconds: [5],
  resolutions: ['720p'],
  optionalParameters: {},
}

const model: LogicalModel = {
  id: 'mock-motion',
  revision: 1,
  name: 'Mock Motion',
  capabilities: [text],
}

const route: ProviderRoute = {
  routeId: 'mock-motion-local',
  revision: 1,
  modelId: model.id,
  providerId: 'mock-local',
  providerModelId: 'mock-motion',
  adapterVersion: 'mock-v1',
  enabled: true,
  priority: 1,
  capabilityConstraints: [text],
}

/** Development and test only. Production does not construct a provider. */
export function localMockRegistries(environment: string, clock: { nowMs(): number }): { models: ModelRegistry, providers: ProviderRegistry } {
  const providers = new ProviderRegistry([
    createMockProvider({
      environment,
      providerId: route.providerId,
      scenario: { fixtureId: MOCK_FIXTURE_ID, completeAfterMs: 0 },
    }, clock),
  ])
  return { models: new ModelRegistry([model], [route]), providers }
}
