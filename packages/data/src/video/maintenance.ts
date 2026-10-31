import type { Database } from '../client.ts'
import { floorToSqliteMs } from '../credits/runtime.ts'
import { dispatchDueOutbox, type DispatchReport } from './dispatch.ts'
import { enqueueOutbox } from './durable.ts'
import { handleVideoMessage, type VideoEngineDeps } from './engine.ts'
import { videoMessage, type VideoQueueSender } from './protocol.ts'
import { readActiveGenerations, readAttempts, readInflightOutbox } from './rows.ts'

export async function runMaintenance(
  deps: VideoEngineDeps & { readonly queue: VideoQueueSender },
): Promise<{ readonly dispatched: DispatchReport, readonly inspected: number }> {
  const nowMs = floorToSqliteMs(deps.clock.nowMs())
  if (nowMs === null) return { dispatched: { sent: 0, retained: 0 }, inspected: 0 }
  const now = new Date(nowMs)
  const dispatched = await dispatchDueOutbox({
    database: deps.database,
    queue: deps.queue,
    workerId: deps.workerId,
    nowMs,
    ...(deps.limits ? { limits: deps.limits } : {}),
  })
  const generations = await readActiveGenerations(deps.database, deps.limits?.maintenanceLimit ?? 20)
  for (const generation of generations) {
    if (now >= generation.deadlineAt && generation.status !== 'storing') {
      await handleVideoMessage(deps, videoMessage({
        eventId: `maintenance:${generation.id}`,
        generationId: generation.id,
        eventType: 'start_submission',
        attemptId: null,
      }), 'queue')
      continue
    }
    const attempts = await readAttempts(deps.database, generation.id)
    const latest = attempts.at(-1) ?? null
    if (generation.status === 'storing' || generation.status === 'processing' || generation.status === 'submission_unknown') {
      const eventType = generation.status === 'storing' ? 'store_output' : 'poll_status'
      await ensure(deps.database, generation.id, eventType, latest?.id ?? null, now)
    }
    else if (generation.status === 'queued' || generation.status === 'submitting') {
      await ensure(deps.database, generation.id, 'start_submission', latest?.id ?? null, now)
    }
  }
  return { dispatched, inspected: generations.length }
}

async function ensure(
  database: Database,
  generationId: string,
  eventType: 'start_submission' | 'poll_status' | 'store_output',
  attemptId: string | null,
  now: Date,
): Promise<void> {
  const existing = await readInflightOutbox(database, generationId, eventType)
  if (existing) return
  await enqueueOutbox(database, {
    id: `obx_${crypto.randomUUID()}`,
    generationId,
    eventType,
    attemptId,
    notBefore: now,
    now,
  })
}
