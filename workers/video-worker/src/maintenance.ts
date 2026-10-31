import { runMaintenance } from '../../../packages/data/src/video/maintenance.ts'
import type { VideoWorkerEnv } from './bindings.ts'
import { engineDeps } from './generation-runner.ts'

export async function runScheduledMaintenance(env: VideoWorkerEnv): Promise<void> {
  const deps = engineDeps(env)
  await runMaintenance({
    ...deps,
    queue: {
      async send(message, options) {
        await env.VIDEO_QUEUE.send(message, options)
      },
    },
  })
}
