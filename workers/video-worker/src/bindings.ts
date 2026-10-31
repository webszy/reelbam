import type { createDatabase } from '../../../packages/data/src/client.ts'
import { DLQ_QUEUE_NAME, MAIN_QUEUE_NAME } from '../../../packages/data/src/video/protocol.ts'

export { DLQ_QUEUE_NAME, MAIN_QUEUE_NAME }

type DatabaseBinding = Parameters<typeof createDatabase>[0]

export interface VideoObjectBinding {
  put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>
  head(key: string): Promise<{ size: number, httpMetadata?: { contentType?: string } } | null>
  delete(key: string): Promise<void>
}

export interface VideoQueueBinding {
  send(body: unknown, options?: { delaySeconds?: number }): Promise<void>
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
  retry(): void
}
