import type { JsonObject } from '@reelbam/video-contracts/internal'

export const VIDEO_STEP_ID = 'generate'
export const VIDEO_MESSAGE_VERSION = 1
export const MOCK_FIXTURE_ID = 'reelbam/mock-video-v1'
export const MAX_OUTPUT_BYTES = 5_000_000
export const OUTBOX_MAX_DELIVERIES = 8
export const MAX_SUBMIT_ATTEMPTS = 3
export const MAX_POLLS = 20
export const LEASE_MS = 30_000
export const MAINTENANCE_LIMIT = 20
export const MAIN_QUEUE_NAME = 'reelbam-video-jobs'
export const DLQ_QUEUE_NAME = 'reelbam-video-jobs-dlq'

export type VideoOutboxEventType = 'start_submission' | 'poll_status' | 'store_output'

/** Queue payload. It is a pointer. Balance, price, secrets, and status are not accepted. */
export interface VideoQueueMessage {
  readonly messageVersion: 1
  readonly eventId: string
  readonly generationId: string
  readonly eventType: VideoOutboxEventType
  readonly stepId: typeof VIDEO_STEP_ID
  readonly attemptId: string | null
}

export interface VideoQueueSender {
  send(message: VideoQueueMessage, options?: { readonly delaySeconds?: number }): Promise<void>
}

export interface VideoObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
  head(key: string): Promise<{ readonly byteSize: number, readonly contentType: string } | null>
  delete(key: string): Promise<void>
}

export interface VideoLimits {
  readonly outboxMaxDeliveries: number
  readonly maxSubmitAttempts: number
  readonly maxPolls: number
  readonly leaseMs: number
  readonly maintenanceLimit: number
  readonly pollDelaySeconds: number
}

export const DEFAULT_LIMITS: VideoLimits = {
  outboxMaxDeliveries: OUTBOX_MAX_DELIVERIES,
  maxSubmitAttempts: MAX_SUBMIT_ATTEMPTS,
  maxPolls: MAX_POLLS,
  leaseMs: LEASE_MS,
  maintenanceLimit: MAINTENANCE_LIMIT,
  pollDelaySeconds: 1,
}

const EVENT_TYPES: readonly VideoOutboxEventType[] = ['start_submission', 'poll_status', 'store_output']

export function videoMessage(input: {
  readonly eventId: string
  readonly generationId: string
  readonly eventType: VideoOutboxEventType
  readonly attemptId: string | null
}): VideoQueueMessage {
  return {
    messageVersion: VIDEO_MESSAGE_VERSION,
    eventId: input.eventId,
    generationId: input.generationId,
    eventType: input.eventType,
    stepId: VIDEO_STEP_ID,
    attemptId: input.attemptId,
  }
}

export function messagePayload(message: VideoQueueMessage): JsonObject {
  return {
    messageVersion: message.messageVersion,
    eventId: message.eventId,
    generationId: message.generationId,
    eventType: message.eventType,
    stepId: message.stepId,
    attemptId: message.attemptId,
  }
}

export function parseVideoQueueMessage(value: unknown): VideoQueueMessage | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.messageVersion !== VIDEO_MESSAGE_VERSION) return null
  if (typeof record.eventId !== 'string' || record.eventId.trim() === '') return null
  if (typeof record.generationId !== 'string' || record.generationId.trim() === '') return null
  if (typeof record.eventType !== 'string' || !EVENT_TYPES.includes(record.eventType as VideoOutboxEventType)) return null
  if (record.stepId !== VIDEO_STEP_ID) return null
  if (record.attemptId !== null && (typeof record.attemptId !== 'string' || record.attemptId.trim() === '')) return null
  return videoMessage({
    eventId: record.eventId,
    generationId: record.generationId,
    eventType: record.eventType as VideoOutboxEventType,
    attemptId: record.attemptId === null ? null : record.attemptId,
  })
}

export function submitKey(generationId: string, attemptNumber: number): string {
  return `video_submit:${generationId}:${VIDEO_STEP_ID}:${attemptNumber}`
}

export function finalOutputKey(environment: string, generationId: string, attemptId: string): string {
  return `private/${environment}/generations/${generationId}/attempts/${attemptId}/output.mp4`
}

export function tempOutputKey(environment: string, generationId: string, attemptId: string, leaseToken: string): string {
  return `private/${environment}/generations/${generationId}/attempts/${attemptId}/tmp/${leaseToken}.mp4`
}

export type DeadLetterDecision =
  | { readonly action: 'ignore' }
  | { readonly action: 'requeue', readonly eventType: VideoOutboxEventType }
  | { readonly action: 'needs_review', readonly errorCode: string }

/**
 * DLQ classification from durable rows. It does not call a provider or settle credits.
 * A newer attempt makes the old message obsolete.
 */
export function assessDeadLetter(input: {
  readonly message: VideoQueueMessage
  readonly status: string
  readonly latestAttemptId: string | null
  readonly latestAttemptNumber: number
  readonly messageAttemptNumber: number | null
  readonly acceptanceStatus: string | null
  readonly hasProviderRequestId: boolean
}): DeadLetterDecision {
  if (input.status === 'succeeded' || input.status === 'failed') return { action: 'ignore' }
  if (input.message.attemptId && input.latestAttemptId && input.message.attemptId !== input.latestAttemptId
    && input.messageAttemptNumber !== null && input.messageAttemptNumber < input.latestAttemptNumber) {
    return { action: 'ignore' }
  }
  if (input.status === 'storing') return { action: 'requeue', eventType: 'store_output' }
  if (input.status === 'processing' && input.hasProviderRequestId) return { action: 'requeue', eventType: 'poll_status' }
  if (input.status === 'submission_unknown') return { action: 'requeue', eventType: 'poll_status' }
  if (input.status === 'submitting' && input.acceptanceStatus === 'not_submitted' && !input.hasProviderRequestId) {
    return { action: 'requeue', eventType: 'start_submission' }
  }
  if (input.status === 'queued') return { action: 'requeue', eventType: 'start_submission' }
  return { action: 'needs_review', errorCode: 'dlq_unrecoverable' }
}
