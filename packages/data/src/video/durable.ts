import { and, eq, inArray, sql } from 'drizzle-orm'
import type { InternalGenerationStatus, JsonObject, RouteSnapshot } from '@reelbam/video-contracts/internal'
import type { GenerationInput } from '@reelbam/video-contracts'
import type { CreditQuoteSnapshot } from '../credits/contract.ts'
import type { Database } from '../client.ts'
import { videoAssets, videoAttempts, videoGenerations, videoOutbox, videoProviderCosts } from '../schema/video.ts'
import { commitVideoBatch, type VideoBatchResult } from './batch.ts'
import { messagePayload, submitKey, VIDEO_STEP_ID, videoMessage, type VideoOutboxEventType } from './protocol.ts'
import { readGeneration, readOutbox, secondsOf } from './rows.ts'
import { transitionGeneration, type GenerationEvent } from '../../../video-core/src/state-machine.ts'

export interface Lease {
  readonly owner: string
  readonly token: string
  readonly until: Date
}

export async function claimOutbox(
  database: Database,
  outboxId: string,
  lease: Lease,
  now: Date,
): Promise<boolean> {
  const current = await readOutbox(database, outboxId)
  if (!current) return false
  if (current.deliveryStatus === 'leased' && current.leaseToken === lease.token && current.leaseUntil && current.leaseUntil > now) {
    return true
  }
  if (current.deliveryStatus !== 'pending') return false
  const result = await commitVideoBatch(database, [
    database.update(videoOutbox).set({
      deliveryStatus: 'leased',
      leaseOwner: lease.owner,
      leaseToken: lease.token,
      leaseUntil: lease.until,
      updatedAt: now,
      nextRetryAt: null,
      deliveryAttemptCount: sql`case
        when ${videoOutbox.deliveryStatus} = 'pending'
        then ${videoOutbox.deliveryAttemptCount} + 1
        else -1
      end`,
    }).where(eq(videoOutbox.id, outboxId)),
  ])
  if (result === 'conflict') return false
  const saved = await readOutbox(database, outboxId)
  return saved?.leaseToken === lease.token && saved.deliveryStatus === 'leased'
}

export async function markOutboxDelivered(
  database: Database,
  input: { readonly outboxId: string, readonly generationId: string, readonly eventType: VideoOutboxEventType, readonly lease: Lease, readonly now: Date },
): Promise<VideoBatchResult> {
  const seconds = secondsOf(input.now)
  return commitVideoBatch(database, [
    database.update(videoOutbox).set({
      deliveryStatus: 'delivered',
      deliveredAt: input.now,
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
      updatedAt: input.now,
      deliveryAttemptCount: sql`case
        when ${videoOutbox.generationId} = ${input.generationId}
         and ${videoOutbox.deliveryStatus} = 'leased'
         and ${videoOutbox.eventType} = ${input.eventType}
         and ${videoOutbox.leaseOwner} = ${input.lease.owner}
         and ${videoOutbox.leaseToken} = ${input.lease.token}
         and ${videoOutbox.leaseUntil} > ${seconds}
        then ${videoOutbox.deliveryAttemptCount}
        else -1
      end`,
    }).where(eq(videoOutbox.id, input.outboxId)),
  ])
}

export async function releaseOutbox(
  database: Database,
  input: {
    readonly outboxId: string
    readonly lease: Lease
    readonly now: Date
    readonly nextRetryAt: Date
    readonly errorCode: string
    readonly dead: boolean
  },
): Promise<VideoBatchResult> {
  const seconds = secondsOf(input.now)
  return commitVideoBatch(database, [
    database.update(videoOutbox).set({
      deliveryStatus: input.dead ? 'dead' : 'pending',
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
      nextRetryAt: input.dead ? null : input.nextRetryAt,
      lastErrorCode: input.errorCode,
      updatedAt: input.now,
      deliveryAttemptCount: sql`case
        when ${videoOutbox.deliveryStatus} = 'leased'
         and ${videoOutbox.leaseOwner} = ${input.lease.owner}
         and ${videoOutbox.leaseToken} = ${input.lease.token}
         and ${videoOutbox.leaseUntil} > ${seconds}
        then ${videoOutbox.deliveryAttemptCount}
        else -1
      end`,
    }).where(eq(videoOutbox.id, input.outboxId)),
  ])
}

export async function reclaimOutboxLease(database: Database, outboxId: string, now: Date): Promise<VideoBatchResult> {
  const seconds = secondsOf(now)
  return commitVideoBatch(database, [
    database.update(videoOutbox).set({
      deliveryStatus: 'pending',
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
      updatedAt: now,
      nextRetryAt: now,
      deliveryAttemptCount: sql`case
        when ${videoOutbox.deliveryStatus} = 'leased' and ${videoOutbox.leaseUntil} <= ${seconds}
        then ${videoOutbox.deliveryAttemptCount}
        else -1
      end`,
    }).where(eq(videoOutbox.id, outboxId)),
  ])
}

export function outboxInsert(
  database: Database,
  input: {
    readonly id: string
    readonly generationId: string
    readonly eventType: VideoOutboxEventType
    readonly attemptId: string | null
    readonly notBefore: Date
    readonly now: Date
  },
) {
  const message = videoMessage({
    eventId: input.id,
    generationId: input.generationId,
    eventType: input.eventType,
    attemptId: input.attemptId,
  })
  return database.insert(videoOutbox).values({
    id: input.id,
    generationId: input.generationId,
    eventType: input.eventType,
    payloadVersion: 1,
    payload: messagePayload(message),
    notBefore: input.notBefore,
    deliveryStatus: 'pending',
    deliveryAttemptCount: 0,
    createdAt: input.now,
    updatedAt: input.now,
  })
}

export async function enqueueOutbox(
  database: Database,
  input: Parameters<typeof outboxInsert>[1],
): Promise<'created' | 'exists' | 'conflict'> {
  const result = await commitVideoBatch(database, [outboxInsert(database, input)])
  if (result === 'ok') return 'created'
  return 'exists'
}

export interface NewGenerationRow {
  readonly id: string
  readonly userId: string
  readonly idempotencyKey: string
  readonly canonicalInput: GenerationInput
  readonly canonicalHash: string
  readonly route: RouteSnapshot
  readonly quote: CreditQuoteSnapshot
  readonly deadlineAt: Date
  readonly now: Date
}

export function generationInsert(database: Database, row: NewGenerationRow) {
  return database.insert(videoGenerations).values({
    id: row.id,
    userId: row.userId,
    idempotencyKey: row.idempotencyKey,
    canonicalInputHash: row.canonicalHash,
    canonicalInput: JSON.parse(JSON.stringify(row.canonicalInput)) as GenerationInput,
    routeSnapshotVersion: row.route.schemaVersion,
    routeSnapshot: row.route,
    quotedCredits: row.quote.creditAmount,
    quoteSnapshot: row.quote,
    mode: row.canonicalInput.mode,
    imageAssetId: row.canonicalInput.mode === 'text-to-video' ? null : row.canonicalInput.imageAssetId,
    referenceVideoAssetId: row.canonicalInput.mode === 'reference-to-video' ? row.canonicalInput.referenceVideoAssetId : null,
    status: 'queued',
    statusVersion: 1,
    deadlineAt: row.deadlineAt,
    createdAt: row.now,
    updatedAt: row.now,
  })
}

export async function claimAttempt(
  database: Database,
  attemptId: string,
  lease: Lease,
  now: Date,
): Promise<boolean> {
  const seconds = secondsOf(now)
  const result = await commitVideoBatch(database, [
    database.update(videoAttempts).set({
      leaseOwner: lease.owner,
      leaseToken: lease.token,
      leaseUntil: lease.until,
      updatedAt: now,
      attemptNumber: sql`case
        when (${videoAttempts.leaseUntil} is null or ${videoAttempts.leaseUntil} <= ${seconds} or ${videoAttempts.leaseToken} = ${lease.token})
         and ${latestAttemptFence()}
         and exists (select 1 from video_generations g where g.id = ${videoAttempts.generationId}
           and g.status in ('queued', 'submitting', 'submission_unknown', 'processing', 'storing'))
        then ${videoAttempts.attemptNumber}
        else -1
      end`,
    }).where(eq(videoAttempts.id, attemptId)),
  ])
  if (result !== 'ok') return false
  const rows = await database.select().from(videoAttempts).where(eq(videoAttempts.id, attemptId)).limit(1)
  const saved = rows[0]
  return saved?.leaseToken === lease.token && saved.leaseOwner === lease.owner
    && saved.leaseUntil !== null && saved.leaseUntil > now
}

export async function openAttempt(
  database: Database,
  input: {
    readonly generationId: string
    readonly userId: string
    readonly attemptId: string
    readonly attemptNumber: number
    readonly providerId: string
    readonly expectedVersion: number
    readonly lease: Lease
    readonly now: Date
  },
): Promise<VideoBatchResult> {
  const key = submitKey(input.generationId, input.attemptNumber)
  return commitVideoBatch(database, [
    database.insert(videoAttempts).values({
      id: input.attemptId,
      generationId: input.generationId,
      stepId: VIDEO_STEP_ID,
      attemptNumber: input.attemptNumber,
      submitKey: key,
      providerId: input.providerId,
      acceptanceStatus: 'not_submitted',
      leaseOwner: input.lease.owner,
      leaseToken: input.lease.token,
      leaseUntil: input.lease.until,
      createdAt: input.now,
      updatedAt: input.now,
    }),
    database.update(videoGenerations).set({
      status: 'submitting',
      updatedAt: input.now,
      statusVersion: sql`case
        when ${videoGenerations.userId} = ${input.userId}
         and ${videoGenerations.status} = 'queued'
         and ${videoGenerations.statusVersion} = ${input.expectedVersion}
        then ${input.expectedVersion + 1}
        else -1
      end`,
    }).where(eq(videoGenerations.id, input.generationId)),
  ])
}

export async function markDispatchStarted(
  database: Database,
  input: { readonly attemptId: string, readonly lease: Lease, readonly submissionKey: string, readonly now: Date },
): Promise<VideoBatchResult> {
  return commitVideoBatch(database, [dispatchStartedStatement(database, input)])
}

export function dispatchStartedStatement(
  database: Database,
  input: { readonly attemptId: string, readonly lease: Lease, readonly submissionKey: string, readonly now: Date },
) {
  const seconds = secondsOf(input.now)
  const metadata: JsonObject = {
    phase: 'dispatch_started',
    submissionKey: input.submissionKey,
    submittedAtMs: input.now.getTime(),
  }
  return database.update(videoAttempts).set({
    submittedAt: input.now,
    recoveryMetadata: metadata,
    updatedAt: input.now,
    attemptNumber: sql`case
      when ${videoAttempts.leaseToken} = ${input.lease.token}
       and ${videoAttempts.leaseOwner} = ${input.lease.owner}
       and ${videoAttempts.leaseUntil} > ${seconds}
       and ${latestAttemptFence()}
       and ${videoAttempts.acceptanceStatus} = 'not_submitted'
       and ${videoAttempts.providerRequestId} is null
       and json_extract(${videoAttempts.recoveryMetadata}, '$.phase') is null
      then ${videoAttempts.attemptNumber}
      else -1
    end`,
  }).where(eq(videoAttempts.id, input.attemptId))
}


export function attemptFence(lease: Lease, seconds: number) {
  return sql`${videoAttempts.leaseToken} = ${lease.token}
    and ${videoAttempts.leaseOwner} = ${lease.owner}
    and ${videoAttempts.leaseUntil} > ${seconds}
    and ${latestAttemptFence()}`
}

export async function saveAcceptedAttempt(
  database: Database,
  input: {
    readonly attemptId: string
    readonly lease: Lease
    readonly providerRequestId: string
    readonly metadata: JsonObject
    readonly payloadHash: string
    readonly fromAcceptance: 'not_submitted' | 'unknown'
    readonly now: Date
  },
): Promise<VideoBatchResult> {
  return commitVideoBatch(database, [acceptedAttemptStatement(database, input)])
}

export function acceptedAttemptStatement(
  database: Database,
  input: {
    readonly attemptId: string
    readonly lease: Lease
    readonly providerRequestId: string
    readonly metadata: JsonObject
    readonly payloadHash: string
    readonly fromAcceptance: 'not_submitted' | 'unknown'
    readonly now: Date
  },
) {
  const seconds = secondsOf(input.now)
  const metadata = sql`json_set(coalesce(${videoAttempts.recoveryMetadata}, '{}'), '$.phase', 'accepted', '$.providerMetadata', json(${JSON.stringify(input.metadata)}))`
  return database.update(videoAttempts).set({
    acceptanceStatus: 'accepted',
    providerRequestId: input.providerRequestId,
    recoveryMetadata: metadata,
    requestPayloadHash: input.payloadHash,
    updatedAt: input.now,
    attemptNumber: sql`case
      when ${attemptFence(input.lease, seconds)}
       and ${videoAttempts.acceptanceStatus} = ${input.fromAcceptance}
       and ${videoAttempts.providerRequestId} is null
      then ${videoAttempts.attemptNumber}
      else -1
    end`,
  }).where(eq(videoAttempts.id, input.attemptId))
}


export async function saveUnknownAttempt(
  database: Database,
  input: { readonly attemptId: string, readonly lease: Lease, readonly metadata: JsonObject, readonly now: Date },
): Promise<VideoBatchResult> {
  return commitVideoBatch(database, [unknownAttemptStatement(database, input)])
}

export function unknownAttemptStatement(
  database: Database,
  input: { readonly attemptId: string, readonly lease: Lease, readonly metadata: JsonObject, readonly now: Date },
) {
  const seconds = secondsOf(input.now)
  const metadata = sql`json_set(coalesce(${videoAttempts.recoveryMetadata}, '{}'), '$.phase', 'unknown', '$.providerMetadata', json(${JSON.stringify(input.metadata)}))`
  return database.update(videoAttempts).set({
    acceptanceStatus: 'unknown',
    providerRequestId: null,
    recoveryMetadata: metadata,
    updatedAt: input.now,
    attemptNumber: sql`case
      when ${attemptFence(input.lease, seconds)}
       and ${videoAttempts.acceptanceStatus} = 'not_submitted'
       and ${videoAttempts.providerRequestId} is null
      then ${videoAttempts.attemptNumber}
      else -1
    end`,
  }).where(eq(videoAttempts.id, input.attemptId))
}


export interface GenerationAdvance {
  readonly generationId: string
  readonly userId: string
  readonly fromStatus: InternalGenerationStatus
  readonly event: GenerationEvent
  readonly expectedVersion: number
  readonly now: Date
  readonly attemptId?: string
  readonly lease?: Lease
  readonly errorCode?: string
}

/** Only operational parking may run without an attempt lease; it never refunds. */
export function generationAdvanceStatement(database: Database, input: GenerationAdvance) {
  const toStatus = transitionGeneration(input.fromStatus, input.event)
  if (toStatus === 'failed' || toStatus === 'succeeded') throw new Error('USE_VIDEO_SETTLEMENT')
  if (toStatus !== 'needs_review' && (!input.attemptId || !input.lease)) throw new Error('VIDEO_ATTEMPT_FENCE_REQUIRED')
  const held = input.attemptId && input.lease
    ? generationAttemptFence(input.attemptId, input.lease, input.now)
    : sql`1 = 1`
  const evidence = input.event === 'execution_blocked' ? sql`1 = 1`
    : sql`exists (select 1 from video_attempts evidence where evidence.id = ${input.attemptId ?? null}
      and (
        (${input.event} = 'start_submission' and evidence.acceptance_status = 'not_submitted'
          and evidence.submitted_at is null and evidence.provider_request_id is null
          and json_extract(evidence.recovery_metadata, '$.phase') is null)
        or (${input.event} in ('submission_accepted', 'recovered_accepted', 'provider_completed', 'provider_pending', 'poll_call_failed', 'storage_call_failed')
          and evidence.acceptance_status = 'accepted' and evidence.provider_request_id is not null)
        or (${input.event} in ('submission_unknown', 'recovery_unavailable')
          and evidence.acceptance_status in ('not_submitted', 'unknown') and evidence.provider_request_id is null)
        or (${input.event} in ('submission_retry', 'recovery_confirmed_absent')
          and evidence.acceptance_status = 'rejected' and evidence.provider_request_id is null
          and evidence.settlement_event in ('submission_rejected', 'recovery_confirmed_absent')
          and evidence.settlement_evidence_id is not null and evidence.resolved_at is not null)
      ))`
  return database.update(videoGenerations).set({
    status: toStatus,
    errorCode: toStatus === 'needs_review' ? input.errorCode ?? 'needs_review' : null,
    errorAt: toStatus === 'needs_review' ? input.now : null,
    terminalAt: null,
    updatedAt: input.now,
    statusVersion: sql`case
      when ${videoGenerations.userId} = ${input.userId}
       and ${videoGenerations.status} = ${input.fromStatus}
       and ${videoGenerations.statusVersion} = ${input.expectedVersion}
       and ${held}
       and ${evidence}
      then ${input.expectedVersion + 1} else -1 end`,
  }).where(eq(videoGenerations.id, input.generationId))
}

export async function advanceGeneration(database: Database, input: GenerationAdvance): Promise<VideoBatchResult> {
  const result = await commitVideoBatch(database, [generationAdvanceStatement(database, input)])
  if (result === 'conflict') return result
  return await readGeneration(database, input.generationId) ? 'ok' : 'conflict'
}

export function latestAttemptFence() {
  return sql`not exists (select 1 from video_attempts newer
    where newer.generation_id = ${videoAttempts.generationId}
      and newer.step_id = ${videoAttempts.stepId}
      and newer.attempt_number > ${videoAttempts.attemptNumber})`
}

export function generationAttemptFence(attemptId: string, lease: Lease, now: Date) {
  return sql`exists (select 1 from video_attempts a
    where a.id = ${attemptId} and a.generation_id = ${videoGenerations.id}
      and a.step_id = ${VIDEO_STEP_ID}
      and a.lease_owner = ${lease.owner} and a.lease_token = ${lease.token}
      and a.lease_until > ${secondsOf(now)}
      and not exists (select 1 from video_attempts newer
        where newer.generation_id = a.generation_id and newer.step_id = a.step_id
          and newer.attempt_number > a.attempt_number))`
}

/** Checkpoint before external I/O. No state change, but stale/missing attempts abort the batch. */
export function generationCheckpoint(database: Database, input: {
  readonly generationId: string, readonly expectedVersion: number, readonly status: InternalGenerationStatus,
  readonly attemptId: string, readonly lease: Lease, readonly now: Date,
}) {
  return database.update(videoGenerations).set({
    statusVersion: sql`case when ${videoGenerations.statusVersion} = ${input.expectedVersion}
      and ${videoGenerations.status} = ${input.status}
      and ${generationAttemptFence(input.attemptId, input.lease, input.now)}
      then ${videoGenerations.statusVersion} else -1 end`,
  }).where(eq(videoGenerations.id, input.generationId))
}

/** A completed step closes all its transport copies, including a dispatcher-held lease. */
export function completeEventStatement(database: Database, generationId: string, eventType: VideoOutboxEventType, now: Date) {
  return database.update(videoOutbox).set({
    deliveryStatus: 'delivered', deliveredAt: now, updatedAt: now,
    leaseOwner: null, leaseToken: null, leaseUntil: null, nextRetryAt: null,
  }).where(and(eq(videoOutbox.generationId, generationId), eq(videoOutbox.eventType, eventType),
    inArray(videoOutbox.deliveryStatus, ['pending', 'leased'])))
}

/** D1 decides obsolescence inside the UPDATE, so this cannot retire current work from a stale read. */
export async function retireObsoleteOutbox(database: Database, generationId: string, now: Date): Promise<void> {
  await commitVideoBatch(database, [database.update(videoOutbox).set({
    deliveryStatus: 'delivered', deliveredAt: now, updatedAt: now,
    leaseOwner: null, leaseToken: null, leaseUntil: null, nextRetryAt: null,
  }).where(and(eq(videoOutbox.generationId, generationId), inArray(videoOutbox.deliveryStatus, ['pending', 'leased']),
    sql`exists (select 1 from video_generations g where g.id = ${videoOutbox.generationId} and (
      g.status in ('succeeded', 'failed', 'needs_review')
      or (${videoOutbox.eventType} = 'start_submission' and g.status not in ('queued', 'submitting'))
      or (${videoOutbox.eventType} = 'poll_status' and g.status not in ('submission_unknown', 'processing'))
      or (${videoOutbox.eventType} = 'store_output' and g.status != 'storing')
      or (json_extract(${videoOutbox.payload}, '$.attemptId') is not null and exists (
        select 1 from video_attempts newest where newest.generation_id = g.id and newest.step_id = ${VIDEO_STEP_ID}
          and newest.attempt_number = (select max(attempt_number) from video_attempts where generation_id = g.id and step_id = ${VIDEO_STEP_ID})
          and newest.id != json_extract(${videoOutbox.payload}, '$.attemptId')))
    ))`))])
}

/** Reserve budgets before I/O, including requests that end in process interruption. */
export function reserveAttemptWork(database: Database, input: {
  readonly attemptId: string, readonly lease: Lease, readonly now: Date,
  readonly counter: 'pollCount' | 'recoveryCount' | 'storageCount', readonly expectedCount: number, readonly maxCount: number,
}) {
  const path = `$.${input.counter}`
  return database.update(videoAttempts).set({
    updatedAt: input.now,
    recoveryMetadata: sql`json_set(coalesce(${videoAttempts.recoveryMetadata}, '{}'),
      ${path}, ${input.expectedCount + 1},
      '$.storageStartedAtMs', case when ${input.counter} = 'storageCount'
        then coalesce(json_extract(${videoAttempts.recoveryMetadata}, '$.storageStartedAtMs'), ${input.now.getTime()})
        else json_extract(${videoAttempts.recoveryMetadata}, '$.storageStartedAtMs') end)`,
    attemptNumber: sql`case when ${attemptFence(input.lease, secondsOf(input.now))}
      and ${latestAttemptFence()}
      and coalesce(json_extract(${videoAttempts.recoveryMetadata}, ${path}), 0) = ${input.expectedCount}
      and ${input.expectedCount} < ${input.maxCount}
      then ${videoAttempts.attemptNumber} else -1 end`,
  }).where(eq(videoAttempts.id, input.attemptId))
}

export function startStorageStatement(database: Database, attemptId: string, lease: Lease, now: Date) {
  return database.update(videoAttempts).set({
    recoveryMetadata: sql`json_set(coalesce(${videoAttempts.recoveryMetadata}, '{}'),
      '$.storageStartedAtMs', ${now.getTime()}, '$.storageCount', 0)`,
    attemptNumber: sql`case when ${attemptFence(lease, secondsOf(now))}
      then ${videoAttempts.attemptNumber} else -1 end`,
  }).where(eq(videoAttempts.id, attemptId))
}

export function releaseAttemptStatement(database: Database, attemptId: string, lease: Lease, now: Date) {
  return database.update(videoAttempts).set({
    leaseOwner: null, leaseToken: null, leaseUntil: null, updatedAt: now,
    attemptNumber: sql`case when ${attemptFence(lease, secondsOf(now))} and ${latestAttemptFence()}
      then ${videoAttempts.attemptNumber} else -1 end`,
  }).where(eq(videoAttempts.id, attemptId))
}

/** Store completion/irrecoverable settlement needs both leases. The attempt lease
 * authorizes taking a transport row even while its dispatcher is finishing send(). */
export async function claimStoreOutbox(database: Database, input: {
  readonly generationId: string, readonly expectedVersion: number, readonly attemptId: string,
  readonly outboxId: string, readonly lease: Lease, readonly now: Date,
}): Promise<boolean> {
  const result = await commitVideoBatch(database, [
    generationCheckpoint(database, { ...input, status: 'storing' }),
    database.update(videoOutbox).set({
      deliveryStatus: 'leased', leaseOwner: input.lease.owner, leaseToken: input.lease.token,
      leaseUntil: input.lease.until, updatedAt: input.now,
      deliveryAttemptCount: sql`case when ${videoOutbox.generationId} = ${input.generationId}
        and ${videoOutbox.eventType} = 'store_output'
        and ${videoOutbox.deliveryStatus} in ('pending', 'leased')
        then ${videoOutbox.deliveryAttemptCount} else -1 end`,
    }).where(eq(videoOutbox.id, input.outboxId)),
  ])
  if (result !== 'ok') return false
  return (await readOutbox(database, input.outboxId))?.leaseToken === input.lease.token
}

export async function queueNextAttempt(database: Database, input: {
  readonly generationId: string, readonly userId: string, readonly expectedVersion: number,
  readonly fromStatus: 'submitting' | 'submission_unknown', readonly attemptId: string,
  readonly lease: Lease, readonly now: Date,
}): Promise<VideoBatchResult> {
  const event = input.fromStatus === 'submitting' ? 'submission_retry' : 'recovery_confirmed_absent'
  const observation = input.fromStatus === 'submitting' ? 'submission_rejected' : 'recovery_confirmed_absent'
  return commitVideoBatch(database, [
    settlementEvidenceUpdate(database, { attemptId: input.attemptId, lease: input.lease,
      event: observation, evidenceId: `evidence:${input.attemptId}:${observation}`, providerRequestId: null, now: input.now }),
    generationAdvanceStatement(database, { ...input, event }),
    releaseAttemptStatement(database, input.attemptId, input.lease, input.now),
    completeEventStatement(database, input.generationId, 'start_submission', input.now),
    completeEventStatement(database, input.generationId, 'poll_status', input.now),
    outboxInsert(database, { id: `obx_${crypto.randomUUID()}`, generationId: input.generationId,
      eventType: 'start_submission', attemptId: null, notBefore: input.now, now: input.now }),
  ])
}

export async function releaseAttemptLease(
  database: Database,
  input: { readonly attemptId: string, readonly lease: Lease, readonly now: Date },
): Promise<VideoBatchResult> {
  const seconds = secondsOf(input.now)
  return commitVideoBatch(database, [
    database.update(videoAttempts).set({
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
      updatedAt: input.now,
      attemptNumber: sql`case
        when ${attemptFence(input.lease, seconds)}
        then ${videoAttempts.attemptNumber}
        else -1
      end`,
    }).where(eq(videoAttempts.id, input.attemptId)),
  ])
}

export async function closeAttemptRejected(
  database: Database,
  input: { readonly attemptId: string, readonly lease: Lease, readonly now: Date },
): Promise<VideoBatchResult> {
  const seconds = secondsOf(input.now)
  return commitVideoBatch(database, [
    database.update(videoAttempts).set({
      acceptanceStatus: 'rejected',
      providerRequestId: null,
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
      resolvedAt: input.now,
      updatedAt: input.now,
      attemptNumber: sql`case
        when ${attemptFence(input.lease, seconds)}
         and ${videoAttempts.providerRequestId} is null
         and ${videoAttempts.acceptanceStatus} in ('not_submitted', 'unknown')
         and ${videoAttempts.settlementEvent} is null
        then ${videoAttempts.attemptNumber}
        else -1
      end`,
    }).where(eq(videoAttempts.id, input.attemptId)),
  ])
}

export function settlementEvidenceUpdate(
  database: Database,
  input: {
    readonly attemptId: string
    readonly lease: Lease
    readonly event: 'submission_rejected' | 'provider_failed' | 'storage_irrecoverable' | 'recovery_confirmed_absent'
    readonly evidenceId: string
    readonly providerRequestId: string | null
    readonly now: Date
  },
) {
  const seconds = secondsOf(input.now)
  const accepted = input.event === 'provider_failed' || input.event === 'storage_irrecoverable'
  return database.update(videoAttempts).set({
    acceptanceStatus: accepted ? 'accepted' : 'rejected',
    providerRequestId: accepted ? input.providerRequestId : null,
    settlementEvent: input.event,
    settlementEvidenceId: input.evidenceId,
    resolvedAt: input.now,
    updatedAt: input.now,
    attemptNumber: sql`case
      when ${attemptFence(input.lease, seconds)}
       and (
         (${accepted ? 1 : 0} = 1 and ${videoAttempts.acceptanceStatus} = 'accepted' and ${videoAttempts.providerRequestId} = ${input.providerRequestId})
         or (${accepted ? 1 : 0} = 0 and ${videoAttempts.providerRequestId} is null and ${videoAttempts.acceptanceStatus} in ('not_submitted', 'unknown', 'rejected'))
       )
      then ${videoAttempts.attemptNumber}
      else -1
    end`,
  }).where(eq(videoAttempts.id, input.attemptId))
}

export function providerCostInsert(
  database: Database,
  input: {
    readonly id: string
    readonly attemptId: string
    readonly providerId: string
    readonly costKind: 'actual' | 'estimated' | 'unknown'
    readonly amountMicros: number | null
    readonly currency: string | null
    readonly source: string
    readonly now: Date
  },
) {
  return database.insert(videoProviderCosts).values({
    id: input.id,
    attemptId: input.attemptId,
    providerId: input.providerId,
    costKind: input.costKind,
    amountMicros: input.amountMicros,
    currency: input.currency,
    amountUnit: 'micro',
    source: input.source,
    observedAt: input.now,
    createdAt: input.now,
  })
}

export async function rememberOutputObject(
  database: Database,
  input: { readonly attemptId: string, readonly lease: Lease, readonly objectKey: string, readonly contentHash: string, readonly now: Date },
): Promise<VideoBatchResult> {
  return commitVideoBatch(database, [outputObjectStatement(database, input)])
}

export function outputObjectStatement(
  database: Database,
  input: { readonly attemptId: string, readonly lease: Lease, readonly objectKey: string, readonly contentHash: string, readonly now: Date },
) {
  const seconds = secondsOf(input.now)
  return database.update(videoAttempts).set({
    updatedAt: input.now,
    recoveryMetadata: sql`json_set(coalesce(${videoAttempts.recoveryMetadata}, '{}'), '$.outputKey', ${input.objectKey}, '$.contentHash', ${input.contentHash})`,
    attemptNumber: sql`case
      when ${attemptFence(input.lease, seconds)} and ${videoAttempts.acceptanceStatus} = 'accepted'
      then ${videoAttempts.attemptNumber}
      else -1
    end`,
  }).where(eq(videoAttempts.id, input.attemptId))
}


export async function bumpPollCount(
  database: Database,
  input: { readonly attemptId: string, readonly lease: Lease, readonly pollCount: number, readonly now: Date },
): Promise<VideoBatchResult> {
  const seconds = secondsOf(input.now)
  return commitVideoBatch(database, [
    database.update(videoAttempts).set({
      updatedAt: input.now,
      recoveryMetadata: sql`json_set(coalesce(${videoAttempts.recoveryMetadata}, '{}'), '$.pollCount', ${input.pollCount})`,
      attemptNumber: sql`case
        when ${attemptFence(input.lease, seconds)}
        then ${videoAttempts.attemptNumber}
        else -1
      end`,
    }).where(eq(videoAttempts.id, input.attemptId)),
  ])
}

export async function insertOutputAndSucceed(
  database: Database,
  input: {
    readonly userId: string
    readonly generationId: string
    readonly expectedVersion: number
    readonly attemptId: string
    readonly outboxId: string
    readonly lease: Lease
    readonly assetId: string
    readonly objectKey: string
    readonly contentType: string
    readonly byteSize: number
    readonly contentHash: string
    readonly now: Date
  },
): Promise<VideoBatchResult> {
  const seconds = secondsOf(input.now)
  return commitVideoBatch(database, [
    database.insert(videoAssets).values({
      id: input.assetId,
      userId: input.userId,
      kind: 'output_video',
      objectKey: input.objectKey,
      contentType: input.contentType,
      byteSize: input.byteSize,
      contentHash: input.contentHash,
      hashAlgorithm: 'sha256',
      status: 'available',
      createdAt: input.now,
    }),
    database.update(videoGenerations).set({
      status: 'succeeded',
      outputAssetId: input.assetId,
      terminalAt: input.now,
      updatedAt: input.now,
      statusVersion: sql`case
        when ${videoGenerations.userId} = ${input.userId}
         and ${videoGenerations.status} = 'storing'
         and ${videoGenerations.statusVersion} = ${input.expectedVersion}
         and ${input.assetId} is not null
         and exists (
           select 1 from video_attempts
           where id = ${input.attemptId}
             and generation_id = ${videoGenerations.id}
             and acceptance_status = 'accepted'
             and provider_request_id is not null
             and lease_owner = ${input.lease.owner}
             and lease_token = ${input.lease.token}
             and lease_until > ${seconds}
             and not exists (select 1 from video_attempts newer
               where newer.generation_id = video_attempts.generation_id
                 and newer.step_id = video_attempts.step_id
                 and newer.attempt_number > video_attempts.attempt_number)
         )
         and exists (
           select 1 from video_outbox
           where id = ${input.outboxId}
             and generation_id = ${videoGenerations.id}
             and event_type = 'store_output'
             and delivery_status = 'leased'
             and lease_owner = ${input.lease.owner}
             and lease_token = ${input.lease.token}
             and lease_until > ${seconds}
         )
        then ${input.expectedVersion + 1}
        else -1
      end`,
    }).where(eq(videoGenerations.id, input.generationId)),
    database.update(videoOutbox).set({
      deliveryStatus: 'delivered',
      deliveredAt: input.now,
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
      updatedAt: input.now,
      deliveryAttemptCount: sql`case
        when ${videoOutbox.generationId} = ${input.generationId}
         and ${videoOutbox.eventType} = 'store_output'
         and ${videoOutbox.deliveryStatus} = 'leased'
         and ${videoOutbox.leaseOwner} = ${input.lease.owner}
         and ${videoOutbox.leaseToken} = ${input.lease.token}
         and ${videoOutbox.leaseUntil} > ${seconds}
        then ${videoOutbox.deliveryAttemptCount}
        else -1
      end`,
    }).where(eq(videoOutbox.id, input.outboxId)),
  ])
}
