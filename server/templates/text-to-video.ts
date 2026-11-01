import { getPublishedTemplateBySlug } from '../../shared/templates.ts'
import { getPrivateTemplateConfig } from './private.ts'

export interface TextToVideoPrepareResult {
  available: false
  reason: 'generation_not_open' | 'unknown_template'
}

/**
 * Boundary for a future text-to-video route.
 * Looks up the server prompt and then drops it. The result never includes a video, a prompt, or a credit charge.
 */
export function prepareTextToVideo(slug: string): TextToVideoPrepareResult {
  const template = getPublishedTemplateBySlug(slug)
  if (!template) return { available: false, reason: 'unknown_template' }
  getPrivateTemplateConfig(slug)
  return { available: false, reason: 'generation_not_open' }
}
