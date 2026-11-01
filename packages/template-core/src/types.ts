import type { GenerationInput, GenerationMode, GenerationParameters } from '@reelbam/video-contracts'
import type { RouteSnapshot } from '@reelbam/video-contracts/internal'
import type { ModelRegistry } from '../../video-core/src/model-registry.ts'
import type { ProviderRegistry } from '../../video-core/src/providers/registry.ts'

export type TemplateEnvironment = 'development' | 'test' | 'production'
export type TemplateStatus = 'published' | 'draft' | 'archived'

/** Structural contract: the application owns the actual public field data. */
export interface TemplateInputField {
  readonly key: string
  readonly type: 'text' | 'textarea' | 'select'
  readonly required: boolean
  readonly defaultValue?: string
  readonly minLength?: number
  readonly maxLength?: number
  readonly options?: readonly { readonly value: string }[]
}

export interface TemplateDefinition {
  readonly templateId: string
  readonly slug: string
  readonly version: number
  readonly status: TemplateStatus
  readonly generationMode: GenerationMode
  /** Production binding. "unassigned" deliberately fails closed. */
  readonly modelId: string
  /** Explicit offline overrides, never consulted in production. */
  readonly offlineModelIds?: Readonly<Partial<Record<'development' | 'test', string>>>
  readonly promptTemplate: string
  readonly defaultParameters: GenerationParameters
  readonly inputFields: readonly TemplateInputField[]
}

export type NormalizedTemplateInputs = Readonly<Record<string, string>>

export interface TemplateSnapshot {
  readonly schemaVersion: 1
  readonly source: 'template'
  readonly templateId: string
  readonly templateSlug: string
  readonly templateVersion: number
  readonly normalizedInputs: NormalizedTemplateInputs
  readonly generationMode: GenerationMode
  readonly modelId: string
  readonly resolvedParameters: GenerationParameters
}

/** P2.6 persistence contract only; no database writer is introduced here. */
export type GenerationSourceMetadata =
  | {
    readonly source: 'template'
    readonly templateId: string
    readonly templateVersion: number
    readonly templateInputsSnapshot: NormalizedTemplateInputs
  }
  | { readonly source: 'freeform' }

export interface TemplateGenerationResolution {
  /** Trusted internal result. Never serialize this as a public template response. */
  readonly generationInput: GenerationInput
  readonly templateSnapshot: TemplateSnapshot
  readonly routeSnapshot: RouteSnapshot
}

export interface TemplateModelContext {
  readonly modelRegistry: ModelRegistry
  readonly environment: unknown
}

export interface TemplateResolverContext extends TemplateModelContext {
  readonly providerRegistry: ProviderRegistry
}

export type TemplateIdentity =
  | { readonly templateId: string, readonly slug?: never }
  | { readonly slug: string, readonly templateId?: never }
