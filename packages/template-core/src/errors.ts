export type TemplateErrorCode =
  | 'invalid_template' | 'invalid_inputs' | 'invalid_prompt' | 'invalid_environment'
  | 'template_not_found' | 'template_not_published' | 'generation_unavailable'

export class TemplateEngineError extends Error {
  readonly code: TemplateErrorCode
  readonly field: string | undefined
  readonly reason: string | undefined

  constructor(code: TemplateErrorCode, message: string, details: { field?: string, reason?: string } = {}) {
    super(message)
    this.name = 'TemplateEngineError'
    this.code = code
    this.field = details.field
    this.reason = details.reason
  }
}
