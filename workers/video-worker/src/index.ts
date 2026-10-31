import type { VideoQueueBatch, VideoWorkerEnv } from './bindings.ts'
import { runScheduledMaintenance } from './maintenance.ts'
import { consumeQueueBatch } from './queue.ts'

export default {
  async queue(batch: VideoQueueBatch, env: VideoWorkerEnv): Promise<void> {
    await consumeQueueBatch(batch, env)
  },
  async scheduled(_controller: unknown, env: VideoWorkerEnv): Promise<void> {
    await runScheduledMaintenance(env)
  },
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 })
  },
}
