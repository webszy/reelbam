import type { GenerationInput } from '@reelbam/video-contracts'
import type { RouteSnapshot } from '@reelbam/video-contracts/internal'
import type { ModelRegistry } from './model-registry.ts'
import type { ProviderRegistry } from './providers/registry.ts'
import { assertInputMatchesCapability, validateGenerationInput, VideoValidationError } from './validation.ts'
import { frozenCopy } from './value.ts'

export class RoutingError extends Error {
  readonly code: 'model_not_found' | 'mode_not_supported' | 'no_compatible_route'
  constructor(code: RoutingError['code'], message: string) {
    super(message)
    this.name = 'RoutingError'
    this.code = code
  }
}

export class ProviderRouter {
  readonly #models: ModelRegistry
  readonly #providers: ProviderRegistry
  constructor(models: ModelRegistry, providers: ProviderRegistry) {
    this.#models = models
    this.#providers = providers
  }

  select(value: unknown): RouteSnapshot {
    const input: GenerationInput = validateGenerationInput(value)
    const model = this.#models.getModel(input.modelId)
    if (!model) throw new RoutingError('model_not_found', 'Logical model does not exist')
    const capability = model.capabilities.find(c => c.mode === input.mode)
    if (!capability) throw new RoutingError('mode_not_supported', 'Model does not support this generation mode')
    assertInputMatchesCapability(input, capability)
    const routes = [...this.#models.routesFor(model.id)].sort((a, b) =>
      a.priority - b.priority || (a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0),
    )
    for (const route of routes) {
      if (!route.enabled || !this.#providers.get(route.providerId, route.adapterVersion)) continue
      const actual = route.capabilityConstraints.find(c => c.id === capability.id && c.mode === input.mode)
      if (!actual) continue
      try {
        assertInputMatchesCapability(input, actual)
      }
      catch (error) {
        if (error instanceof VideoValidationError) continue
        throw error
      }
      return frozenCopy({
        schemaVersion: 1 as const,
        routeId: route.routeId,
        revision: route.revision,
        model: { id: model.id, revision: model.revision },
        providerId: route.providerId,
        providerModelId: route.providerModelId,
        adapterVersion: route.adapterVersion,
        capability: actual,
        input,
      })
    }
    throw new RoutingError('no_compatible_route', 'No enabled, registered Route accepts these parameters')
  }
}
