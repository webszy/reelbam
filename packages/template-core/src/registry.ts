import { assertInputMatchesCapability, validateGenerationInput, VideoValidationError } from '../../video-core/src/validation.ts'
import { frozenCopy } from '../../video-core/src/value.ts'
import { templatePromptVariables } from './compiler.ts'
import { TemplateEngineError } from './errors.ts'
import type { TemplateDefinition, TemplateEnvironment, TemplateModelContext } from './types.ts'

export function parseTemplateEnvironment(value: unknown): TemplateEnvironment {
  if (value === 'development' || value === 'test' || value === 'production') return value
  throw new TemplateEngineError('invalid_environment', 'Expected explicit development, test or production environment')
}

export function templateModelId(definition: TemplateDefinition, environment: TemplateEnvironment): string {
  return environment === 'production' ? definition.modelId : definition.offlineModelIds?.[environment] ?? definition.modelId
}

export function assertTemplateModel(definition: TemplateDefinition, context: TemplateModelContext): string {
  const environment = parseTemplateEnvironment(context.environment)
  const modelId = templateModelId(definition, environment)
  if (modelId === 'unassigned') {
    throw new TemplateEngineError('generation_unavailable', 'Template generation is unavailable', { reason: 'model_unassigned' })
  }
  const model = context.modelRegistry.getModel(modelId)
  if (!model) throw new TemplateEngineError('generation_unavailable', 'Template model is unavailable', { reason: 'model_not_found' })
  const capability = model.capabilities.find(item => item.mode === definition.generationMode)
  if (!capability) throw new TemplateEngineError('generation_unavailable', 'Template mode is unavailable', { reason: 'mode_not_supported' })
  try {
    const input = validateGenerationInput({ modelId, mode: definition.generationMode, prompt: 'Template capability check', parameters: definition.defaultParameters })
    assertInputMatchesCapability(input, capability)
  }
  catch (error) {
    if (!(error instanceof VideoValidationError)) throw error
    throw new TemplateEngineError('generation_unavailable', 'Template parameters are unsupported', { reason: error.field })
  }
  return modelId
}

/** Structural validation always runs. Passing context also checks current model capabilities. */
export function validateTemplateRegistry(definitions: readonly TemplateDefinition[], context?: TemplateModelContext): void {
  const ids = new Set<string>()
  const slugs = new Set<string>()
  if (context) parseTemplateEnvironment(context.environment)
  for (const definition of definitions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(definition.templateId) || ids.has(definition.templateId)
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(definition.slug) || slugs.has(definition.slug)
      || !Number.isSafeInteger(definition.version) || definition.version < 1
      || !['published', 'draft', 'archived'].includes(definition.status)
      || definition.generationMode !== 'text-to-video'
      || typeof definition.modelId !== 'string' || !definition.modelId.trim()) {
      throw new TemplateEngineError('invalid_template', 'Invalid or duplicate template identity, version or mode')
    }
    ids.add(definition.templateId)
    slugs.add(definition.slug)
    if (definition.offlineModelIds) {
      for (const [environment, modelId] of Object.entries(definition.offlineModelIds)) {
        if (!['development', 'test'].includes(environment) || typeof modelId !== 'string' || !modelId.trim()) {
          throw new TemplateEngineError('invalid_template', 'Invalid offline model binding')
        }
      }
    }
    templatePromptVariables(definition.promptTemplate, definition.inputFields)
    try {
      validateGenerationInput({ modelId: definition.modelId, mode: definition.generationMode, prompt: 'Template configuration check', parameters: definition.defaultParameters })
    }
    catch (error) {
      if (!(error instanceof VideoValidationError)) throw error
      throw new TemplateEngineError('invalid_template', 'Invalid template default parameters', { field: error.field })
    }
    if (context && definition.status === 'published') assertTemplateModel(definition, context)
  }
}

export class TemplateRegistry {
  readonly #definitions: readonly TemplateDefinition[]

  constructor(definitions: readonly TemplateDefinition[]) {
    validateTemplateRegistry(definitions)
    this.#definitions = frozenCopy(definitions)
  }

  getTemplateDefinitionById(templateId: string): TemplateDefinition | undefined {
    return this.#definitions.find(definition => definition.templateId === templateId)
  }

  getTemplateDefinitionBySlug(slug: string): TemplateDefinition | undefined {
    return this.#definitions.find(definition => definition.slug === slug)
  }

  listDefinitions(): readonly TemplateDefinition[] {
    return this.#definitions
  }
}
