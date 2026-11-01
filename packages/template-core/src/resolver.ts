import { ProviderRouter, RoutingError } from '../../video-core/src/router.ts'
import { VideoValidationError } from '../../video-core/src/validation.ts'
import { frozenCopy } from '../../video-core/src/value.ts'
import { compileTemplatePrompt } from './compiler.ts'
import { TemplateEngineError } from './errors.ts'
import { assertTemplateModel, parseTemplateEnvironment } from './registry.ts'
import type { TemplateRegistry } from './registry.ts'
import type { TemplateDefinition, TemplateGenerationResolution, TemplateIdentity, TemplateResolverContext } from './types.ts'
import { validateTemplateInputs } from './validator.ts'

function definitionFor(registry: TemplateRegistry, identity: TemplateIdentity): TemplateDefinition {
  if ((typeof identity.templateId === 'string') === (typeof identity.slug === 'string')) {
    throw new TemplateEngineError('template_not_found', 'Supply exactly one template identity')
  }
  const definition = identity.templateId === undefined
    ? registry.getTemplateDefinitionBySlug(identity.slug)
    : registry.getTemplateDefinitionById(identity.templateId)
  if (!definition) throw new TemplateEngineError('template_not_found', 'Template does not exist')
  if (definition.status !== 'published') throw new TemplateEngineError('template_not_published', 'Template is not published')
  return definition
}

function routeFor(definition: TemplateDefinition, context: TemplateResolverContext, prompt: string) {
  const environment = parseTemplateEnvironment(context.environment)
  const modelId = assertTemplateModel(definition, context)
  try {
    const snapshot = new ProviderRouter(context.modelRegistry, context.providerRegistry).select({
      modelId,
      mode: definition.generationMode,
      prompt,
      parameters: definition.defaultParameters,
    })
    // Defense in depth for incorrectly injected development registries. The Mock
    // factory and the application composition root retain their existing guards.
    if (environment === 'production'
      && context.providerRegistry.forSnapshot(snapshot).submissionIdempotency === 'deterministic_mock') {
      throw new TemplateEngineError('generation_unavailable', 'Mock generation is unavailable in production', { reason: 'mock_not_allowed' })
    }
    return snapshot
  }
  catch (error) {
    if (error instanceof RoutingError || error instanceof VideoValidationError) {
      throw new TemplateEngineError('generation_unavailable', 'No compatible template route is available', { reason: error instanceof RoutingError ? error.code : error.field })
    }
    throw error
  }
}

export function resolveTemplateGeneration(
  command: TemplateIdentity & TemplateResolverContext & {
    readonly templateRegistry: TemplateRegistry
    readonly userInputs: unknown
  },
): TemplateGenerationResolution {
  parseTemplateEnvironment(command.environment)
  const definition = definitionFor(command.templateRegistry, command)
  const normalizedInputs = validateTemplateInputs(definition, command.userInputs)
  const prompt = compileTemplatePrompt(definition.promptTemplate, normalizedInputs, definition.inputFields)
  const routeSnapshot = routeFor(definition, command, prompt)
  return frozenCopy({
    generationInput: routeSnapshot.input,
    templateSnapshot: {
      schemaVersion: 1,
      source: 'template',
      templateId: definition.templateId,
      templateSlug: definition.slug,
      templateVersion: definition.version,
      normalizedInputs,
      generationMode: definition.generationMode,
      modelId: routeSnapshot.input.modelId,
      resolvedParameters: routeSnapshot.input.parameters,
    },
    routeSnapshot,
  })
}

/** Availability is internal readiness, independent of the still-closed product UI. */
export function getTemplateGenerationAvailability(
  command: TemplateIdentity & TemplateResolverContext & { readonly templateRegistry: TemplateRegistry },
): { readonly generatable: true } | { readonly generatable: false, readonly reason: string } {
  try {
    parseTemplateEnvironment(command.environment)
    routeFor(definitionFor(command.templateRegistry, command), command, 'Template availability check')
    return { generatable: true }
  }
  catch (error) {
    if (!(error instanceof TemplateEngineError)) throw error
    return { generatable: false, reason: error.code }
  }
}
