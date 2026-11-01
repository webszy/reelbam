import { DLQ_QUEUE_NAME, MAIN_QUEUE_NAME, parseVideoQueueMessage } from '../../../packages/data/src/video/protocol.ts'
import type { VideoQueueBatch, VideoWorkerEnv } from './bindings.ts'
import { runQueueMessage } from './generation-runner.ts'

/** DLQ is not a generation failure. Unknown queues are acknowledged and ignored. */
export async function consumeQueueBatch(batch: VideoQueueBatch, env: VideoWorkerEnv, run = runQueueMessage): Promise<void> {
  const source = batch.queue === DLQ_QUEUE_NAME ? 'dlq' : batch.queue === MAIN_QUEUE_NAME ? 'queue' : null
  for (const message of batch.messages) {
    if (!source) {
      message.ack()
      continue
    }
    try {
      const outcome = await run(env, message.body, source)
      if (outcome === 'retry') message.retry({ delaySeconds: 30 })
      else message.ack()
    }
    catch {
      const pointer = parseVideoQueueMessage(message.body)
      console.error(JSON.stringify({ event: 'video_message_failed', source,
        generationId: pointer?.generationId, attemptId: pointer?.attemptId, eventId: pointer?.eventId }))
      message.retry({ delaySeconds: 30 })
    }
  }
}
