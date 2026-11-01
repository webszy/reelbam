import { TemplateEngineError } from '../src/errors.ts'
import type { TemplateDefinition } from '../src/types.ts'
import { createLocalMockRegistries } from '../../video-core/src/development-catalog.ts'

export function definition(overrides: Partial<TemplateDefinition> = {}): TemplateDefinition {
  return {
    templateId: 'test-template', slug: 'test-template', version: 1, status: 'published',
    generationMode: 'text-to-video', modelId: 'unassigned',
    offlineModelIds: { development: 'mock-motion', test: 'mock-motion' },
    defaultParameters: { durationSeconds: 6, resolution: '720p', aspectRatio: '9:16' },
    inputFields: [
      { key: 'subject', type: 'text', required: true, minLength: 2, maxLength: 80 },
      { key: 'style', type: 'select', required: false, defaultValue: 'quiet', options: [{ value: 'quiet' }, { value: 'bright' }] },
      { key: 'details', type: 'textarea', required: false, maxLength: 280 },
    ],
    promptTemplate: 'Subject: {{subject}}. Style: {{style}}. Details: {{details}}.',
    ...overrides,
  }
}

export function context() {
  const { models, providers } = createLocalMockRegistries('test', { nowMs: () => 1000 })
  return { modelRegistry: models, providerRegistry: providers, environment: 'test' as const }
}

export function errorCode(code: TemplateEngineError['code']) {
  return (error: unknown): boolean => error instanceof TemplateEngineError && error.code === code
}
