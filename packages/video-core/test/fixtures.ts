import type { Capability, GenerationInput, LogicalModel } from '../../video-contracts/src/public.ts'
import type { ProviderRoute } from '../../video-contracts/src/internal.ts'
import type { MockScenario } from '../src/providers/mock.ts'
import { createMockProvider } from '../src/providers/mock.ts'
import { ProviderRegistry } from '../src/providers/registry.ts'
import { ModelRegistry } from '../src/model-registry.ts'
import { ProviderRouter } from '../src/router.ts'

export const textCapability: Capability = {
  id: 'text', mode: 'text-to-video', prompt: 'required', durationSeconds: [4, 8], resolutions: ['480p', '720p'],
  optionalParameters: { aspectRatios: ['9:16', '16:9'], seedRange: { min: 0, max: 100 }, generateAudio: [false] },
}
export const imageCapability: Capability = { ...textCapability, id: 'image', mode: 'image-to-video', prompt: 'optional' }
export const referenceCapability: Capability = { ...textCapability, id: 'reference', mode: 'reference-to-video', prompt: 'optional' }
export const model: LogicalModel = {
  id: 'mock-motion', revision: 1, name: 'Mock Motion',
  capabilities: [textCapability, imageCapability, referenceCapability],
}

// 仅测试配置：A 只接 4 秒/480p；B 覆盖完整三种模式。两个 Provider 均使用 Mock adapter。
export const routeA: ProviderRoute = {
  routeId: 'route-a', revision: 1, modelId: model.id, providerId: 'mock-provider-a',
  providerModelId: 'mock-motion-a', adapterVersion: 'mock-v1', enabled: true, priority: 10,
  capabilityConstraints: [{ ...referenceCapability, durationSeconds: [4], resolutions: ['480p'] }],
}
export const routeB: ProviderRoute = {
  routeId: 'route-b', revision: 1, modelId: model.id, providerId: 'mock-provider-b',
  providerModelId: 'mock-motion-b', adapterVersion: 'mock-v1', enabled: true, priority: 20,
  capabilityConstraints: model.capabilities,
}
export const input: GenerationInput = {
  modelId: model.id, mode: 'reference-to-video', imageAssetId: 'asset-image', referenceVideoAssetId: 'asset-video',
  parameters: { durationSeconds: 4, resolution: '480p' },
}

export function setup(options: { routes?: readonly ProviderRoute[]; scenario?: Partial<MockScenario>; nowMs?: number } = {}) {
  const time = { value: options.nowMs ?? 1000 }
  const clock = { nowMs: () => time.value }
  const providers = new ProviderRegistry([routeA, routeB].map(route => createMockProvider({
    environment: 'test', providerId: route.providerId,
    ...(options.scenario ? { scenario: options.scenario } : {}),
  }, clock)))
  const models = new ModelRegistry([model], options.routes ?? [routeA, routeB])
  const router = new ProviderRouter(models, providers)
  // Invalid-route fixtures must reach the assertion before selecting a route.
  let snapshot: ReturnType<ProviderRouter['select']> | undefined
  const selectSnapshot = () => snapshot ??= router.select(input)
  return {
    time, clock, models, providers, router,
    get snapshot() { return selectSnapshot() },
    get adapter() { return providers.forSnapshot(selectSnapshot()) },
  }
}
