import { eq, sql } from 'drizzle-orm'
import type { JsonObject, RouteSnapshot } from '@reelbam/video-contracts/internal'
import type { GenerationInput } from '@reelbam/video-contracts'
import type { CreditQuoteSnapshot } from '../credits/contract.ts'
import type { Database } from '../client.ts'
import { videoAssets, videoAttempts, videoGenerations, videoOutbox, videoProviderCosts } from '../schema/video.ts'
import { commitVideoBatch, type VideoBatchResult } from './batch.ts'
import { messagePayload, submitKey, VIDEO_STEP_ID, videoMessage, type VideoOutboxEventType } from './protocol.ts'
import { readOutbox, secondsOf } from './rows.ts'

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
        then ${videoAttempts.attemptNumber}
        else -1
      end`,
    }).where(eq(videoAttempts.id, attemptId)),
  ])
  return result === 'ok'
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
  const seconds = secondsOf(input.now)
  const metadata: JsonObject = {
    phase: 'dispatch_started',
    submissionKey: input.submissionKey,
    submittedAtMs: input.now.getTime(),
  }
  return commitVideoBatch(database, [
    database.update(videoAttempts).set({
      submittedAt: input.now,
      recoveryMetadata: metadata,
      updatedAt: input.now,
      attemptNumber: sql`case
        when ${videoAttempts.leaseToken} = ${input.lease.token}
         and ${videoAttempts.leaseOwner} = ${input.lease.owner}
         and ${videoAttempts.leaseUntil} > ${seconds}
         and ${videoAttempts.acceptanceStatus} = 'not_submitted'
         and ${videoAttempts.providerRequestId} is null
         and json_extract(${videoAttempts.recoveryMetadata}, '$.phase') is null
        then ${videoAttempts.attemptNumber}
        else -1
      end`,
    }).where(eq(videoAttempts.id, input.attemptId)),
  ])
}

export function attemptFence(lease: Lease, seconds: number) {
  return sql`${videoAttempts.leaseToken} = ${lease.token}
    and ${videoAttempts.leaseOwner} = ${lease.owner}
    and ${videoAttempts.leaseUntil} > ${seconds}`
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
  const seconds = secondsOf(input.now)
  const metadata: JsonObject = { phase: 'accepted', pollCount: 0, providerMetadata: input.metadata }
  return commitVideoBatch(database, [
    database.update(videoAttempts).set({
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
    }).where(eq(videoAttempts.id, input.attemptId)),
  ])
}

export async function saveUnknownAttempt(
  database: Database,
  input: { readonly attemptId: string, readonly lease: Lease, readonly metadata: JsonObject, readonly now: Date },
): Promise<VideoBatchResult> {
  const seconds = secondsOf(input.now)
  const metadata: JsonObject = { phase: 'unknown', pollCount: 0, providerMetadata: input.metadata }
  return commitVideoBatch(database, [
    database.update(videoAttempts).set({
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
    }).where(eq(videoAttempts.id, input.attemptId)),
  ])
}

export async function advanceGeneration(
  database: Database,
  input: {
    readonly generationId: string
    readonly userId: string
    readonly fromStatus: string
    readonly toStatus: 'queued' | 'submitting' | 'submission_unknown' | 'processing' | 'storing' | 'needs_review'
    readonly expectedVersion: number
    readonly now: Date
    readonly errorCode?: string | null
  },
): Promise<VideoBatchResult> {
  const errorCode = input.toStatus === 'needs_review' ? input.errorCode ?? 'needs_review' : null
  return commitVideoBatch(database, [
    database.update(videoGenerations).set({
      status: input.toStatus,
      errorCode,
      errorAt: input.toStatus === 'needs_review' ? input.now : null,
      terminalAt: null,
      updatedAt: input.now,
      statusVersion: sql`case
        when ${videoGenerations.userId} = ${input.userId}
         and ${videoGenerations.status} = ${input.fromStatus}
         and ${videoGenerations.statusVersion} = ${input.expectedVersion}
         and ${videoGenerations.status} not in ('succeeded', 'failed')
        then ${input.expectedVersion + 1}
        else -1
      end`,
    }).where(eq(videoGenerations.id, input.generationId)),
  ])
}

export async function replaceWithNextAttempt(
  database: Database,
  input: {
    readonly generationId: string
    readonly attemptId: string
    readonly nextAttemptId: string
    readonly nextAttemptNumber: number
    readonly providerId: string
    readonly lease: Lease
    readonly nextLease: Lease
    readonly now: Date
  },
): Promise<VideoBatchResult> {
  const seconds = secondsOf(input.now)
  const key = submitKey(input.generationId, input.nextAttemptNumber)
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
    database.insert(videoAttempts).values({
      id: input.nextAttemptId,
      generationId: input.generationId,
      stepId: VIDEO_STEP_ID,
      attemptNumber: input.nextAttemptNumber,
      submitKey: key,
      providerId: input.providerId,
      acceptanceStatus: 'not_submitted',
      leaseOwner: input.nextLease.owner,
      leaseToken: input.nextLease.token,
      leaseUntil: input.nextLease.until,
      createdAt: input.now,
      updatedAt: input.now,
    }),
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
  const seconds = secondsOf(input.now)
  return commitVideoBatch(database, [
    database.update(videoAttempts).set({
      updatedAt: input.now,
      recoveryMetadata: sql`json_set(coalesce(${videoAttempts.recoveryMetadata}, '{}'), '$.outputKey', ${input.objectKey}, '$.contentHash', ${input.contentHash})`,
      attemptNumber: sql`case
        when ${attemptFence(input.lease, seconds)} and ${videoAttempts.acceptanceStatus} = 'accepted'
        then ${videoAttempts.attemptNumber}
        else -1
      end`,
    }).where(eq(videoAttempts.id, input.attemptId)),
  ])
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
