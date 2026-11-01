import type { InternalGenerationStatus } from '@reelbam/video-contracts/internal'

export type GenerationEvent =
  | 'start_submission' | 'submission_accepted' | 'submission_rejected' | 'submission_unknown'
  | 'submission_call_failed' | 'recovered_accepted' | 'recovery_confirmed_absent' | 'recovery_unavailable'
  | 'provider_pending' | 'provider_completed' | 'provider_failed' | 'poll_call_failed'
  | 'output_stored' | 'storage_call_failed' | 'storage_irrecoverable' | 'deadline_reached'
  | 'submission_retry' | 'execution_blocked'

const TRANSITIONS: Readonly<Record<InternalGenerationStatus, Partial<Record<GenerationEvent, InternalGenerationStatus>>>> = {
  queued: { start_submission: 'submitting', deadline_reached: 'failed', execution_blocked: 'needs_review' },
  submitting: {
    submission_accepted: 'processing', submission_rejected: 'failed',
    submission_unknown: 'submission_unknown', submission_call_failed: 'submission_unknown',
    deadline_reached: 'needs_review',
    submission_retry: 'queued', execution_blocked: 'needs_review',
  },
  submission_unknown: {
    recovered_accepted: 'processing', recovery_confirmed_absent: 'queued',
    recovery_unavailable: 'submission_unknown', deadline_reached: 'needs_review',
    execution_blocked: 'needs_review',
  },
  processing: {
    provider_pending: 'processing', poll_call_failed: 'processing',
    provider_completed: 'storing', provider_failed: 'failed', deadline_reached: 'needs_review',
    execution_blocked: 'needs_review',
  },
  storing: {
    output_stored: 'succeeded', storage_call_failed: 'storing',
    storage_irrecoverable: 'failed', deadline_reached: 'needs_review',
    execution_blocked: 'needs_review',
  },
  needs_review: {
    recovered_accepted: 'processing', recovery_confirmed_absent: 'failed',
    recovery_unavailable: 'needs_review', provider_completed: 'storing', provider_failed: 'failed',
  },
  succeeded: {},
  failed: {},
}

export class InvalidTransitionError extends Error {
  constructor(status: InternalGenerationStatus, event: GenerationEvent) {
    super(`Illegal generation transition: ${status} + ${event}`)
    this.name = 'InvalidTransitionError'
  }
}

export function isTerminal(status: InternalGenerationStatus): boolean {
  return status === 'succeeded' || status === 'failed'
}

/** 只返回规则结果；不提交任务/重试/扣费/退款。事件证据由未来执行器校验并持久化。 */
export function transitionGeneration(status: InternalGenerationStatus, event: GenerationEvent): InternalGenerationStatus {
  const transitions = Object.hasOwn(TRANSITIONS, status) ? TRANSITIONS[status] : undefined
  const next = transitions && Object.hasOwn(transitions, event) ? transitions[event] : undefined
  if (!next) throw new InvalidTransitionError(status, event)
  return next
}
