import type { JsonObject, ProviderJobHandle, RouteSnapshot } from '@reelbam/video-contracts/internal'

export type ProviderErrorCode =
  | 'authentication_error' | 'rate_limited' | 'invalid_input' | 'provider_unavailable'
  | 'provider_timeout' | 'content_policy' | 'unknown'

/** 调用异常：分类只描述原因，不包含 retryable/resubmitAllowed 等隐含计费决策。 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  constructor(code: ProviderErrorCode, message: string) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
  }
}

/** 上游任务明确失败，和一次 HTTP/轮询调用异常是不同事件。 */
export interface ProviderFailure {
  readonly code: ProviderErrorCode
  readonly message: string
}

export type ProviderCost =
  | { readonly kind: 'unknown' }
  | {
    readonly kind: 'estimated' | 'actual'
    readonly amountMicros: number
    readonly currency: string
    readonly source: string
  }

export interface ProviderSubmission {
  readonly snapshot: RouteSnapshot
  /** 调用方在首次尝试前保存；后续重放不能更换 key、时间或快照。 */
  readonly submissionKey: string
  readonly submittedAtMs: number
}

export type SubmitResult =
  | { readonly kind: 'accepted'; readonly handle: ProviderJobHandle }
  | { readonly kind: 'rejected'; readonly failure: ProviderFailure }
  | { readonly kind: 'unknown'; readonly recoveryMetadata: JsonObject }

export type ProviderStatus =
  | { readonly state: 'pending' }
  | { readonly state: 'completed'; readonly output: ProviderOutput; readonly cost: ProviderCost }
  | { readonly state: 'failed'; readonly failure: ProviderFailure; readonly cost: ProviderCost }

export type ProviderOutput =
  | { readonly kind: 'fixture'; readonly fixtureId: string }
  | { readonly kind: 'remote'; readonly url: string }

export type RecoveryResult =
  | { readonly kind: 'accepted'; readonly handle: ProviderJobHandle }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unknown'; readonly recoveryMetadata: JsonObject }

export type CancelResult = { readonly kind: 'confirmed' | 'unknown' }

export interface ProviderAdapter {
  readonly id: string
  readonly adapterVersion: string
  readonly submissionIdempotency: 'provider_guarantee' | 'deterministic_mock' | 'unsupported'
  submit(input: ProviderSubmission): Promise<SubmitResult>
  getStatus(handle: ProviderJobHandle, snapshot: RouteSnapshot): Promise<ProviderStatus>
  /**
   * Local recomputation of a deterministic mock identity.
   * This is not a billed submit. Real adapters leave it unset.
   */
  projectSubmission?(input: ProviderSubmission): Promise<SubmitResult>
  recoverSubmission?(input: ProviderSubmission, recoveryMetadata: JsonObject): Promise<RecoveryResult>
  cancel?(handle: ProviderJobHandle, snapshot: RouteSnapshot): Promise<CancelResult>
}

export interface Clock { nowMs(): number }

/** 未来网络适配器的显式依赖；本阶段 Mock 不使用网络。 */
export interface ProviderDependencies {
  readonly clock: Clock
  readonly request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}
