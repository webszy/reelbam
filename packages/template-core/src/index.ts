/** Server-only engine; public pages must continue to import shared/templates. */
export type {
  TemplateDefinition, TemplateEnvironment, TemplateStatus, TemplateInputField,
  NormalizedTemplateInputs, TemplateSnapshot, GenerationSourceMetadata,
  TemplateGenerationResolution, TemplateIdentity, TemplateModelContext, TemplateResolverContext,
} from './types.ts'
export { TemplateEngineError } from './errors.ts'
export type { TemplateErrorCode } from './errors.ts'
export { validateTemplateInputs, assertTemplateInputFields } from './validator.ts'
export { compileTemplatePrompt, templatePromptVariables } from './compiler.ts'
export { TemplateRegistry, validateTemplateRegistry } from './registry.ts'
export { resolveTemplateGeneration, getTemplateGenerationAvailability } from './resolver.ts'
