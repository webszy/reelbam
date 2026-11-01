/** Server-only template prompts. Do not import this module from app code or shared catalog data. */
import type { GenerationMode, GenerationParameters } from '../../packages/video-contracts/src/public.ts'
import { compileTemplatePrompt, TemplateEngineError, validateTemplateInputs } from '../../packages/template-core/src/index.ts'
import { getPublishedTemplateBySlug } from '../../shared/templates.ts'

export interface PrivateTemplateConfig {
  readonly templateId: string
  readonly slug: string
  readonly templateVersion: number
  readonly generationMode: GenerationMode
  /** No production model is assigned. Generation stays closed until a real route exists. */
  readonly modelId: string
  readonly offlineModelIds?: Readonly<Partial<Record<'development' | 'test', string>>>
  readonly defaultParameters: Omit<GenerationParameters, 'durationSeconds' | 'aspectRatio'>
  readonly prompt: string
}

const PRIVATE_TEMPLATES: Readonly<Record<string, PrivateTemplateConfig>> = {
  'night-walk': prompt('tmpl_01_night_walk', 'night-walk', 'Quiet neon street, wet pavement, slow walk. Subject: {{character}}. Action: {{action}}. Detail: {{details}}.'),
  'product-orbit': prompt('tmpl_02_product_orbit', 'product-orbit', 'Dark studio turnaround of one object. Subject: {{character}}. Action: {{action}}. Detail: {{details}}.'),
  'steam-kitchen': prompt('tmpl_03_steam_kitchen', 'steam-kitchen', 'Close-up cooking, steam, warm counter light. Subject: {{character}}. Action: {{action}}. Detail: {{details}}.'),
  'soft-portrait': prompt('tmpl_04_soft_portrait', 'soft-portrait', 'Window-lit portrait, gentle push-in. Subject: {{character}}. Action: {{action}}. Detail: {{details}}.'),
  'desk-ritual': prompt('tmpl_05_desk_ritual', 'desk-ritual', 'Top-down morning desk, coffee and paper. Subject: {{character}}. Action: {{action}}. Detail: {{details}}.'),
  'coastal-haze': prompt('tmpl_06_coastal_haze', 'coastal-haze', 'Golden-hour coast, drifting haze, wide hold. Subject: {{character}}. Action: {{action}}. Detail: {{details}}.'),
  'neon-night': prompt('tmpl_07_neon_night', 'neon-night', 'Vertical night street, wet asphalt, colored signs, slow pace. Subject: {{character}}. Action: {{action}}. Mood: {{mood}}. Detail: {{details}}.'),
}

function prompt(templateId: string, slug: string, body: string): PrivateTemplateConfig {
  return {
    templateId,
    slug,
    templateVersion: 1,
    generationMode: 'text-to-video',
    modelId: 'unassigned',
    offlineModelIds: { development: 'mock-motion', test: 'mock-motion' },
    defaultParameters: { resolution: '720p' },
    prompt: `internal-template-prompt ${slug}. ${body} No readable text. No logos.`,
  }
}

export function getPrivateTemplateConfig(slug: string): PrivateTemplateConfig | undefined {
  return Object.hasOwn(PRIVATE_TEMPLATES, slug) ? PRIVATE_TEMPLATES[slug] : undefined
}

export function listPrivateTemplateConfigs(): readonly PrivateTemplateConfig[] {
  return Object.values(PRIVATE_TEMPLATES)
}

export function renderPrivatePrompt(slug: string, fields: unknown): string | undefined {
  const config = getPrivateTemplateConfig(slug)
  const template = getPublishedTemplateBySlug(slug)
  if (!config || !template) return undefined
  if (config.templateId !== template.id || config.slug !== template.slug) {
    throw new TemplateEngineError('invalid_template', 'Public/private template identity mismatch')
  }
  return compileTemplatePrompt(config.prompt, validateTemplateInputs(template, fields), template.inputFields)
}
