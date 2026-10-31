import { DLQ_QUEUE_NAME, MAIN_QUEUE_NAME } from '../../../packages/data/src/video/protocol.ts'
import type { VideoQueueBatch, VideoWorkerEnv } from './bindings.ts'
import { runQueueMessage } from './generation-runner.ts'

/** DLQ is not a generation failure. Unknown queues are acknowledged and ignored. */
export async function consumeQueueBatch(batch: VideoQueueBatch, env: VideoWorkerEnv): Promise<void> {
  const source = batch.queue === DLQ_QUEUE_NAME ? 'dlq' : batch.queue === MAIN_QUEUE_NAME ? 'queue' : null
  for (const message of batch.messages) {
    if (!source) {
      message.ack()
      continue
    }
    try {
      const outcome = await runQueueMessage(env, message.body, source)
      if (outcome === 'retry') message.retry()
      else message.ack()
    }
    catch {
      message.retry()
    }
  }
}
