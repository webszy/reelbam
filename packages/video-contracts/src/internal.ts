/** 仅供服务端/核心使用；不可将此入口作为浏览器 DTO barrel。 */
import type { Capability, GenerationInput, LogicalModel } from './public.ts'

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonObject = { readonly [key: string]: JsonValue }
export type ProviderId = string

export interface ProviderRoute {
  readonly routeId: string
  readonly revision: number
  readonly modelId: string
  readonly providerId: ProviderId
  readonly providerModelId: string
  readonly adapterVersion: string
  readonly enabled: boolean
  /** 数字越小优先级越高；同优先级按 routeId 的字符顺序选择。 */
  readonly priority: number
  readonly capabilityConstraints: readonly Capability[]
}

export interface RouteSnapshot {
  readonly schemaVersion: 1
  readonly routeId: string
  readonly revision: number
  readonly model: Pick<LogicalModel, 'id' | 'revision'>
  readonly providerId: ProviderId
  readonly providerModelId: string
  readonly adapterVersion: string
  readonly capability: Capability
  readonly input: GenerationInput
}

export interface ProviderJobHandle {
  readonly providerId: ProviderId
  readonly providerModelId: string
  readonly adapterVersion: string
  readonly jobId: string
  readonly metadata: JsonObject
}

export type InternalGenerationStatus =
  | 'queued' | 'submitting' | 'submission_unknown' | 'processing' | 'storing'
  | 'succeeded' | 'failed' | 'needs_review'

export interface InternalGeneration {
  readonly id: string
  readonly route: RouteSnapshot
  readonly status: InternalGenerationStatus
  readonly errorCode: string | null
  readonly outputAssetId: string | null
  readonly handle?: ProviderJobHandle
}

