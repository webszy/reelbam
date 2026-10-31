import type { PublicGeneration, PublicGenerationStatus } from '@reelbam/video-contracts'
import type { InternalGeneration, InternalGenerationStatus } from '@reelbam/video-contracts/internal'

const PUBLIC_STATUS: Record<InternalGenerationStatus, PublicGenerationStatus> = {
  queued: 'queued', submitting: 'processing', submission_unknown: 'processing', processing: 'processing',
  storing: 'processing', succeeded: 'succeeded', failed: 'failed', needs_review: 'needs_review',
}

/** 逐项投影，禁止使用对象 spread 泄露路由/handle/恢复数据。 */
export function toPublicGeneration(generation: InternalGeneration): PublicGeneration {
  return {
    id: generation.id,
    modelId: generation.route.model.id,
    mode: generation.route.input.mode,
    status: PUBLIC_STATUS[generation.status],
    errorCode: generation.errorCode,
    outputAssetId: generation.status === 'succeeded' ? generation.outputAssetId : null,
  }
}
