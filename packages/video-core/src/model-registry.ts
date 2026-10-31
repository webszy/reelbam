import type { LogicalModel } from '@reelbam/video-contracts'
import type { ProviderRoute } from '@reelbam/video-contracts/internal'
import { assertCapabilityDefinition, assertRouteCapability } from './validation.ts'
import { frozenCopy, isNonBlank } from './value.ts'

export class ModelRegistry {
  readonly #models: readonly LogicalModel[]
  readonly #routes: readonly ProviderRoute[]

  constructor(models: readonly LogicalModel[], routes: readonly ProviderRoute[]) {
    const ids = new Set<string>()
    for (const model of models) {
      if (!isNonBlank(model.id) || !isNonBlank(model.name) || ids.has(model.id)
        || !Number.isSafeInteger(model.revision) || model.revision < 1 || !model.capabilities.length) {
        throw new Error('Invalid or duplicate logical model')
      }
      ids.add(model.id)
      const modes = new Set<string>()
      const capabilities = new Set<string>()
      for (const capability of model.capabilities) {
        assertCapabilityDefinition(capability)
        if (modes.has(capability.mode) || capabilities.has(capability.id)) throw new Error('Duplicate model capability')
        modes.add(capability.mode)
        capabilities.add(capability.id)
      }
    }
    const routeIds = new Set<string>()
    for (const route of routes) {
      const model = models.find(m => m.id === route.modelId)
      if (!model || !isNonBlank(route.routeId) || routeIds.has(route.routeId)
        || !isNonBlank(route.providerId) || !isNonBlank(route.providerModelId) || !isNonBlank(route.adapterVersion)
        || !Number.isSafeInteger(route.revision) || route.revision < 1 || !Number.isSafeInteger(route.priority)
        || typeof route.enabled !== 'boolean' || !route.capabilityConstraints.length) {
        throw new Error('Invalid or duplicate provider route')
      }
      routeIds.add(route.routeId)
      const routeModes = new Set<string>()
      for (const constraint of route.capabilityConstraints) {
        const capability = model.capabilities.find(c => c.id === constraint.id && c.mode === constraint.mode)
        if (!capability || routeModes.has(constraint.mode)) throw new Error('Invalid route capability reference')
        routeModes.add(constraint.mode)
        assertRouteCapability(capability, constraint)
      }
    }
    this.#models = frozenCopy(models)
    this.#routes = frozenCopy(routes)
  }

  getModel(id: string): LogicalModel | undefined {
    return this.#models.find(model => model.id === id)
  }

  listModels(): readonly LogicalModel[] {
    return this.#models
  }

  routesFor(modelId: string): readonly ProviderRoute[] {
    return this.#routes.filter(route => route.modelId === modelId)
  }
}
