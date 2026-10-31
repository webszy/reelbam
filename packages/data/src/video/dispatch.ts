import type { Database } from '../client.ts'
import { floorToSqliteMs } from '../credits/runtime.ts'
import {
  claimOutbox,
  reclaimOutboxLease,
  releaseOutbox,
  type Lease,
} from './durable.ts'
import {
  DEFAULT_LIMITS,
  parseVideoQueueMessage,
  type VideoLimits,
  type VideoQueueSender,
} from './protocol.ts'
import { readDueOutbox, readExpiredOutboxLeases, readOutbox } from './rows.ts'

export interface DispatchDeps {
  readonly database: Database
  readonly queue: VideoQueueSender
  readonly workerId: string
  readonly nowMs: number
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
    return 'retained'
  }
  const delaySeconds = Math.max(0, Math.ceil((row.notBefore.getTime() - now.getTime()) / 1000))
  try {
    await deps.queue.send(message, { delaySeconds })
  }
  catch {
    const dead = row.deliveryAttemptCount >= limits.outboxMaxDeliveries
    await releaseOutbox(deps.database, {
      outboxId,
      lease: held,
      now,
      nextRetryAt: new Date(now.getTime() + limits.pollDelaySeconds * 1000),
      errorCode: 'queue_send_failed',
      dead,
    })
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
      now,
      nextRetryAt: new Date(now.getTime() + limits.leaseMs),
      errorCode: 'sent',
      dead: false,
    })
    if (released === 'conflict') return 'retained'
  }
  catch {
    return 'retained'
  }
  return 'sent'
}
