import { and, eq } from 'drizzle-orm'
import { floorToSqliteMs } from '../credits/runtime.ts'
import { videoGenerations } from '../schema/video.ts'
import { dispatchDueOutbox, type DispatchReport } from './dispatch.ts'
import { ensureEvent, eventFor, handleVideoMessage, type VideoEngineDeps } from './engine.ts'
import { videoMessage, type VideoQueueSender } from './protocol.ts'
import { readActiveGenerations, readAttempts, readGeneration } from './rows.ts'
import { cleanupTerminalObjects } from './cleanup.ts'

export async function runMaintenance(
  deps: VideoEngineDeps & { readonly queue: VideoQueueSender },
): Promise<{ readonly dispatched: DispatchReport, readonly inspected: number }> {
  const ms = floorToSqliteMs(deps.clock.nowMs())
  if (ms === null) return { dispatched: { sent: 0, retained: 0 }, inspected: 0 }
  const generations = await readActiveGenerations(deps.database, deps.limits?.maintenanceLimit ?? 20)
  for (const generation of generations) {
    try {
      // This source is restricted to deadline/budget handling, never Provider I/O.
      await handleVideoMessage(deps, videoMessage({
        eventId: 'maintenance:' + generation.id, generationId: generation.id,
        eventType: 'start_submission', attemptId: null,
      }), 'maintenance')
      const current = await readGeneration(deps.database, generation.id)
      if (current && !['succeeded', 'failed', 'needs_review'].includes(current.status)) {
        const latest = (await readAttempts(deps.database, current.id)).at(-1)
        const event = eventFor(current)
        await ensureEvent(deps, current, event, event === 'start_submission' ? null : latest?.id ?? null)
      }
    }
    finally {
      // Rotate the bounded scan even when a task has not made business progress.
      // status_version remains the concurrency fence; this is only scan scheduling.
      const now = floorToSqliteMs(deps.clock.nowMs())
      if (now !== null) await deps.database.update(videoGenerations).set({ updatedAt: new Date(now) })
        .where(and(eq(videoGenerations.id, generation.id), eq(videoGenerations.statusVersion, generation.statusVersion)))
    }
  }
  const dispatched = await dispatchDueOutbox({
    database: deps.database, queue: deps.queue, workerId: deps.workerId,
    nowMs: deps.clock.nowMs(), clock: deps.clock, ...(deps.limits ? { limits: deps.limits } : {}),
  })
  await cleanupTerminalObjects(deps, new Date(ms))
  return { dispatched, inspected: generations.length }
}
