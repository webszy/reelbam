import type { Database } from '../client.ts'
import { floorToSqliteMs } from '../credits/runtime.ts'
import {
  advanceGeneration,
  claimOutbox,
  reclaimOutboxLease,
  releaseOutbox,
  retireObsoleteOutbox,
  type Lease,
} from './durable.ts'
import {
  DEFAULT_LIMITS,
  parseVideoQueueMessage,
  type VideoLimits,
  type VideoQueueSender,
} from './protocol.ts'
import { readDueOutbox, readExpiredOutboxLeases, readGeneration, readOutbox } from './rows.ts'

export interface DispatchDeps {
  readonly database: Database
  readonly queue: VideoQueueSender
  readonly workerId: string
  readonly nowMs: number
  readonly clock?: { nowMs(): number }
  readonly limits?: Partial<VideoLimits>
  /** Test seam: runs after a successful send and before the outbox is released. */
  readonly afterSend?: () => Promise<void>
}

export interface DispatchReport {
  readonly sent: number
  readonly retained: number
}

function limitsOf(input: Partial<VideoLimits> | undefined): VideoLimits {
  return { ...DEFAULT_LIMITS, ...input }
}

function lease(workerId: string, now: Date, leaseMs: number): Lease {
  return { owner: workerId, token: `lease_${crypto.randomUUID()}`, until: new Date(now.getTime() + leaseMs) }
}

/** Send durable outbox rows. A failed send leaves the row for a later pass. */
export async function dispatchDueOutbox(deps: DispatchDeps): Promise<DispatchReport> {
  const limits = limitsOf(deps.limits)
  const floored = floorToSqliteMs(deps.nowMs)
  if (floored === null) return { sent: 0, retained: 0 }
  const now = new Date(floored)
  const expired = await readExpiredOutboxLeases(deps.database, now, limits.maintenanceLimit)
  for (const row of expired) await reclaimOutboxLease(deps.database, row.id, now)
  const due = await readDueOutbox(deps.database, now, limits.maintenanceLimit)
  let sent = 0
  let retained = 0
  for (const row of due) {
    const outcome = await dispatchOutboxRow(deps, row.id, now, limits)
    if (outcome === 'sent') sent += 1
    else retained += 1
  }
  return { sent, retained }
}

export async function dispatchOutboxRow(
  deps: DispatchDeps,
  outboxId: string,
  now: Date,
  limits: VideoLimits = limitsOf(deps.limits),
): Promise<'sent' | 'retained' | 'absent'> {
  const original = await readOutbox(deps.database, outboxId)
  if (!original) return 'absent'
  const generation = await readGeneration(deps.database, original.generationId)
  if (!generation) return 'absent'
  await retireObsoleteOutbox(deps.database, generation.id, now)
  const current = await readOutbox(deps.database, outboxId)
  if (!current || current.deliveryStatus === 'delivered' || current.deliveryStatus === 'dead') return 'absent'
  const park = async () => {
    // No upstream work exists for a well-formed queued task. Its deadline
    // settlement recovers a dead start event without Queue availability.
    if (generation.status === 'queued') return
    await advanceGeneration(deps.database, {
      generationId: generation.id, userId: generation.userId, fromStatus: generation.status,
      expectedVersion: generation.statusVersion, event: 'execution_blocked',
      errorCode: 'outbox_delivery_exhausted', now: freshNow(deps, now),
    })
    await retireObsoleteOutbox(deps.database, generation.id, freshNow(deps, now))
  }
  const held = lease(deps.workerId, now, limits.leaseMs)
  const claimed = await claimOutbox(deps.database, outboxId, held, now)
  if (!claimed) return 'retained'
  const row = await readOutbox(deps.database, outboxId)
  if (!row) return 'absent'
  const message = parseVideoQueueMessage(row.payload)
  if (!message) {
    await releaseOutbox(deps.database, {
      outboxId,
      lease: held,
      now,
      nextRetryAt: now,
      errorCode: 'invalid_outbox_payload',
      dead: true,
    })
    await park()
    return 'retained'
  }
  if (row.deliveryAttemptCount > limits.outboxMaxDeliveries) {
    await releaseOutbox(deps.database, { outboxId, lease: held, now: freshNow(deps, now),
      nextRetryAt: now, errorCode: 'delivery_budget_exhausted', dead: true })
    await park()
    return 'retained'
  }
  const delaySeconds = Math.max(0, Math.ceil((row.notBefore.getTime() - now.getTime()) / 1000))
  try {
    await deps.queue.send(message, { delaySeconds })
  }
  catch {
    const dead = row.deliveryAttemptCount >= limits.outboxMaxDeliveries
    const released = await releaseOutbox(deps.database, {
      outboxId,
      lease: held,
      now: freshNow(deps, now),
      nextRetryAt: new Date(freshNow(deps, now).getTime() + Math.min(300, Math.max(1, limits.pollDelaySeconds) * 2 ** Math.min(row.deliveryAttemptCount - 1, 8)) * 1000),
      errorCode: 'queue_send_failed',
      dead,
    })
    if (dead && released === 'ok') await park()
    return 'retained'
  }
  // The consumer marks the row delivered when the step is durable.
  // Releasing the claim records that the send returned. A crash here leaves the lease
  // for expiry and a duplicate, idempotent send.
  try {
    if (deps.afterSend) await deps.afterSend()
    const released = await releaseOutbox(deps.database, {
      outboxId,
      lease: held,
      now: freshNow(deps, now),
      nextRetryAt: new Date(freshNow(deps, now).getTime() + limits.leaseMs),
      errorCode: 'sent',
      dead: row.deliveryAttemptCount >= limits.outboxMaxDeliveries,
    })
    if (released === 'ok' && row.deliveryAttemptCount >= limits.outboxMaxDeliveries) await park()
    if (released === 'conflict') return 'retained'
  }
  catch {
    return 'retained'
  }
  return 'sent'
}

function freshNow(deps: DispatchDeps, fallback: Date): Date {
  const value = floorToSqliteMs(deps.clock?.nowMs() ?? fallback.getTime())
  if (value === null) throw new Error('INVALID_VIDEO_CLOCK')
  return new Date(value)
}
