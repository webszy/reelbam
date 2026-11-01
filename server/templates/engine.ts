/** Server adapter. Public catalog data and private prompts are combined only here. */
import {
  getTemplateGenerationAvailability,
  resolveTemplateGeneration,
  TemplateEngineError,
  TemplateRegistry,
} from '../../packages/template-core/src/index.ts'
import type {
  TemplateDefinition, TemplateGenerationResolution, TemplateIdentity, TemplateResolverContext,
} from '../../packages/template-core/src/index.ts'
import { DEMO_TEMPLATES } from '../../shared/templates.ts'
import type { PublicTemplate } from '../../shared/templates.ts'
import { listPrivateTemplateConfigs } from './private.ts'
import type { PrivateTemplateConfig } from './private.ts'

export interface ServerTemplateCatalog {
  readonly publicTemplates?: readonly PublicTemplate[]
  readonly privateConfigs?: readonly PrivateTemplateConfig[]
}

export function createServerTemplateRegistry(catalog: ServerTemplateCatalog = {}): TemplateRegistry {
  const publicTemplates = catalog.publicTemplates ?? DEMO_TEMPLATES
  const privateConfigs = catalog.privateConfigs ?? listPrivateTemplateConfigs()
  const ids = new Set<string>()
  const slugs = new Set<string>()
  const fail = (message: string): never => { throw new TemplateEngineError('invalid_template', message) }
  for (const template of publicTemplates) {
    if (!template.id || !template.slug || ids.has(template.id) || slugs.has(template.slug)) fail('Duplicate or missing public template identity')
    ids.add(template.id)
    slugs.add(template.slug)
  }
  const configs = new Map<string, PrivateTemplateConfig>()
  const privateIds = new Set<string>()
  for (const config of privateConfigs) {
    if (configs.has(config.slug) || privateIds.has(config.templateId)) fail('Duplicate private template identity')
    const template = publicTemplates.find(item => item.slug === config.slug || item.id === config.templateId)
    if (!template || template.id !== config.templateId || template.slug !== config.slug) fail('Public/private template identity mismatch')
    privateIds.add(config.templateId)
    configs.set(config.slug, config)
  }
  const definitions: TemplateDefinition[] = []
  for (const template of publicTemplates) {
    const config = configs.get(template.slug)
    if (!config) {
      if (template.status === 'published') fail('Published template has no private configuration')
      continue
    }
    definitions.push({
      templateId: template.id,
      slug: template.slug,
      version: config.templateVersion,
      status: template.status,
      generationMode: config.generationMode,
      modelId: config.modelId,
      ...(config.offlineModelIds ? { offlineModelIds: config.offlineModelIds } : {}),
      promptTemplate: config.prompt,
      defaultParameters: {
        ...config.defaultParameters,
        durationSeconds: template.generationOptions.duration,
        aspectRatio: template.generationOptions.aspectRatio,
      },
      inputFields: template.inputFields,
    })
  }
  return new TemplateRegistry(definitions)
}

function assertPublicIdentity(identity: TemplateIdentity, catalog: ServerTemplateCatalog): void {
  if ((typeof identity.templateId === 'string') === (typeof identity.slug === 'string')) {
    throw new TemplateEngineError('template_not_found', 'Supply exactly one template identity')
  }
  const template = (catalog.publicTemplates ?? DEMO_TEMPLATES).find(item => identity.templateId === undefined
    ? item.slug === identity.slug
    : item.id === identity.templateId)
  if (!template) throw new TemplateEngineError('template_not_found', 'Template does not exist')
  if (template.status !== 'published') throw new TemplateEngineError('template_not_published', 'Template is not published')
}

/** No DB, billing, submission, runtime-config lookup, or HTTP response. */
export function resolvePublicTemplateGeneration(
  command: TemplateIdentity & TemplateResolverContext & { readonly userInputs: unknown },
  catalog: ServerTemplateCatalog = {},
): TemplateGenerationResolution {
  assertPublicIdentity(command, catalog)
  return resolveTemplateGeneration({ ...command, templateRegistry: createServerTemplateRegistry(catalog) })
}

export function getServerTemplateGenerationAvailability(
  command: TemplateIdentity & TemplateResolverContext,
  catalog: ServerTemplateCatalog = {},
): { readonly generatable: true } | { readonly generatable: false, readonly reason: string } {
  try {
    assertPublicIdentity(command, catalog)
    return getTemplateGenerationAvailability({ ...command, templateRegistry: createServerTemplateRegistry(catalog) })
  }
  catch (error) {
    if (!(error instanceof TemplateEngineError)) throw error
    return { generatable: false, reason: error.code }
  }
}
