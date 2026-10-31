/** Server-only template prompts. Do not import this module from app code or shared catalog data. */

export interface PrivateTemplateConfig {
  templateId: string
  slug: string
  /** No production model is assigned. Generation stays closed until a real route exists. */
  modelId: 'unassigned'
  prompt: string
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
    modelId: 'unassigned',
    prompt: `internal-template-prompt ${slug}. ${body} No readable text. No logos.`,
  }
}

export function getPrivateTemplateConfig(slug: string): PrivateTemplateConfig | undefined {
  return PRIVATE_TEMPLATES[slug]
}

export function renderPrivatePrompt(slug: string, fields: Readonly<Record<string, string>>): string | undefined {
  const config = PRIVATE_TEMPLATES[slug]
  if (!config) return undefined
  return config.prompt.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => fields[key]?.trim() ?? '')
}
