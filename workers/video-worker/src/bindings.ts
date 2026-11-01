import type { createDatabase } from '../../../packages/data/src/client.ts'
import { DLQ_QUEUE_NAME, MAIN_QUEUE_NAME } from '../../../packages/data/src/video/protocol.ts'

export { DLQ_QUEUE_NAME, MAIN_QUEUE_NAME }

export type VideoWorkerEnvironment = 'development' | 'test' | 'production'

export function parseVideoWorkerEnvironment(value: unknown): VideoWorkerEnvironment {
  if (value === 'development' || value === 'test' || value === 'production') return value
  throw new Error('INVALID_APP_ENVIRONMENT: expected development, test or production')
}

type DatabaseBinding = Parameters<typeof createDatabase>[0]

export interface VideoObjectBinding {
  put(key: string, value: ArrayBuffer | Uint8Array, options?: {
    httpMetadata?: { contentType?: string }, onlyIf?: { etagDoesNotMatch?: string }, sha256?: string,
  }): Promise<unknown>
  head(key: string): Promise<{ size: number, httpMetadata?: { contentType?: string }, checksums: { sha256?: ArrayBuffer } } | null>
  delete(key: string): Promise<void>
  list(options: { prefix: string, limit: number, cursor?: string }): Promise<{
    objects: { key: string, uploaded: Date }[], truncated: boolean, cursor?: string,
  }>
}

export interface VideoQueueBinding {
  send(body: unknown, options?: { delaySeconds?: number }): Promise<unknown>
}

export interface VideoWorkerEnv {
  DB: DatabaseBinding
  VIDEO_BUCKET: VideoObjectBinding
  VIDEO_QUEUE: VideoQueueBinding
  APP_ENVIRONMENT?: string
}

export interface VideoQueueBatch {
  readonly queue: string
  readonly messages: readonly VideoQueueBatchMessage[]
}

export interface VideoQueueBatchMessage {
  readonly body: unknown
  ack(): void
  retry(options?: { delaySeconds?: number }): void
}
