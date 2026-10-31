/** 浏览器可见的合同；此入口不重导出内部类型或 Provider 配置。 */
export type GenerationMode = 'text-to-video' | 'image-to-video' | 'reference-to-video'
export type ModelId = string
export type CapabilityId = string

export interface GenerationParameters {
  readonly durationSeconds: number
  readonly resolution: string
  readonly aspectRatio?: string
  readonly seed?: number
  readonly generateAudio?: boolean
}

interface GenerationBase {
  readonly modelId: ModelId
  readonly parameters: GenerationParameters
}

export type GenerationInput = GenerationBase & (
  | { readonly mode: 'text-to-video'; readonly prompt: string }
  | { readonly mode: 'image-to-video'; readonly imageAssetId: string; readonly prompt?: string }
  | {
    readonly mode: 'reference-to-video'
    readonly imageAssetId: string
    readonly referenceVideoAssetId: string
    readonly prompt?: string
  }
)

/** 每种模式的素材要求由 GenerationInput 固定；模型/Route 另外约束 Prompt 和参数。 */
export interface Capability {
  readonly id: CapabilityId
  readonly mode: GenerationMode
  readonly prompt: 'required' | 'optional' | 'unsupported'
  readonly durationSeconds: readonly number[]
  readonly resolutions: readonly string[]
  /** 缺席的可选参数表示不支持，不能静默传给供应商。 */
  readonly optionalParameters: {
    readonly aspectRatios?: readonly string[]
    readonly seedRange?: { readonly min: number; readonly max: number }
    readonly generateAudio?: readonly boolean[]
  }
}

export interface LogicalModel {
  readonly id: ModelId
  readonly revision: number
  readonly name: string
  readonly capabilities: readonly Capability[]
}

export type PublicGenerationStatus = 'queued' | 'processing' | 'succeeded' | 'failed' | 'needs_review'

export interface PublicGeneration {
  readonly id: string
  readonly modelId: ModelId
  readonly mode: GenerationMode
  readonly status: PublicGenerationStatus
  readonly errorCode: string | null
  readonly outputAssetId: string | null
}
