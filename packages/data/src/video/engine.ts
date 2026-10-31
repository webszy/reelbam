import { createHash } from 'node:crypto'
import type { JsonObject, RouteSnapshot } from '@reelbam/video-contracts/internal'
import { ProviderError } from '../../../video-core/src/provider.ts'
import type { ProviderAdapter, ProviderCost, ProviderSubmission } from '../../../video-core/src/provider.ts'
import type { ProviderRegistry } from '../../../video-core/src/providers/registry.ts'
import type { Database } from '../client.ts'
import { videoReturnOperationKey } from '../credits/contract.ts'
import type { LedgerBatchStatement } from '../credits/consume.ts'
import { returnCreditsForFailedGeneration } from '../credits/return.ts'
import { floorToSqliteMs } from '../credits/runtime.ts'
import { commitVideoBatch } from './batch.ts'
import {
  advanceGeneration,
  bumpPollCount,
  claimAttempt,
  claimOutbox,
  enqueueOutbox,
  insertOutputAndSucceed,
  markDispatchStarted,
  markOutboxDelivered,
  openAttempt,
  providerCostInsert,
  releaseAttemptLease,
  rememberOutputObject,
  replaceWithNextAttempt,
  saveAcceptedAttempt,
  saveUnknownAttempt,
  settlementEvidenceUpdate,
  type Lease,
} from './durable.ts'
import {
  assessDeadLetter,
  DEFAULT_LIMITS,
  finalOutputKey,
  parseVideoQueueMessage,
  tempOutputKey,
  type VideoLimits,
  type VideoObjectStore,
  type VideoQueueMessage,
} from './protocol.ts'
import {
  readAssetByKey,
  readAttempts,
  readCosts,
  readGeneration,
  readInflightOutbox,
  readOutbox,
} from './rows.ts'

type GenerationRow = NonNullable<Awaited<ReturnType<typeof readGeneration>>>
type AttemptRow = Awaited<ReturnType<typeof readAttempts>>[number]
type Outcome = 'ack' | 'retry'

export interface VideoEngineDeps {
  readonly database: Database
  readonly providers: ProviderRegistry
  readonly store: VideoObjectStore
  readonly clock: { nowMs(): number }
  readonly workerId: string
  readonly environment: 'test' | 'development' | 'production'
  readonly fixture: { readonly fixtureId: string, readonly bytes: Uint8Array, readonly contentType: string }
  readonly limits?: Partial<VideoLimits>
}

const RETRYABLE_REJECTION = new Set(['rate_limited', 'provider_unavailable', 'provider_timeout'])

export async function handleVideoMessage(
  deps: VideoEngineDeps,
  raw: unknown,
  source: 'queue' | 'dlq',
): Promise<Outcome> {
  const message = parseVideoQueueMessage(raw)
  if (!message) return 'ack'
  const now = flooredNow(deps)
  if (!now) return 'retry'
  const generation = await readGeneration(deps.database, message.generationId)
  if (!generation) return 'ack'
  if (generation.status === 'succeeded' || generation.status === 'failed') return 'ack'
  if (source === 'dlq') return handleDeadLetter(deps, message, generation, now)
  return handleQueueMessage(deps, message, generation, now)
}

async function handleQueueMessage(
  deps: VideoEngineDeps,
  message: VideoQueueMessage,
  generation: GenerationRow,
  now: Date,
): Promise<Outcome> {
  const attempts = await readAttempts(deps.database, generation.id)
  const latest = attempts.at(-1) ?? null
  if (message.attemptId && latest && message.attemptId !== latest.id) {
    const named = attempts.find(attempt => attempt.id === message.attemptId)
    if (!named || named.attemptNumber < latest.attemptNumber) return 'ack'
  }
  if (message.eventType === 'poll_status' && (generation.status === 'queued' || generation.status === 'submitting')) {
    return 'retry'
  }
  if (message.eventType === 'store_output' && generation.status !== 'storing') {
    return generation.status === 'processing' ? 'retry' : 'ack'
  }
  const lease = newLease(deps, now)
  if (generation.status === 'queued' && now >= generation.deadlineAt) {
    return settleDeadline(deps, generation, lease, now)
  }
  if (generation.status !== 'queued' && now >= generation.deadlineAt && generation.status !== 'storing') {
    return moveNeedsReview(deps, generation, 'deadline_unconfirmed', now)
  }
  if (generation.status === 'needs_review') return 'ack'
  if (generation.status === 'queued' || generation.status === 'submitting') {
    return submitStep(deps, generation, latest, lease, now)
  }
  if (generation.status === 'submission_unknown') return recoverStep(deps, generation, latest, lease, now)
  if (generation.status === 'processing') return pollStep(deps, generation, latest, lease, message, now)
  if (generation.status === 'storing') return storeStep(deps, generation, latest, lease, now)
  return 'ack'
}

async function submitStep(
  deps: VideoEngineDeps,
  generation: GenerationRow,
  latest: AttemptRow | null,
  lease: Lease,
  now: Date,
): Promise<Outcome> {
  let attempt = latest
  if (!attempt || attempt.acceptanceStatus === 'rejected') {
    const opened = await openAttempt(deps.database, {
      generationId: generation.id,
      userId: generation.userId,
      attemptId: `att_${crypto.randomUUID()}`,
      attemptNumber: attempt ? attempt.attemptNumber + 1 : 1,
      providerId: generation.routeSnapshot.providerId,
      expectedVersion: generation.statusVersion,
      lease,
      now,
    })
    if (opened === 'conflict') return 'retry'
    generation = (await readGeneration(deps.database, generation.id)) ?? generation
    attempt = (await readAttempts(deps.database, generation.id)).at(-1) ?? null
  }
  if (!attempt) return 'retry'
  if (!(await holdAttempt(deps, attempt, lease, now))) return 'retry'
  attempt = (await readAttempts(deps.database, generation.id)).find(row => row.id === attempt!.id) ?? attempt
  const phase = metaPhase(attempt.recoveryMetadata)
  if (phase === 'dispatch_started' || attempt.acceptanceStatus === 'unknown') {
    return recoverStep(deps, generation, attempt, lease, now)
  }
  if (attempt.acceptanceStatus === 'accepted' && attempt.providerRequestId) {
    const moved = await advanceGeneration(deps.database, {
      generationId: generation.id,
      userId: generation.userId,
      fromStatus: generation.status,
      toStatus: 'processing',
      expectedVersion: generation.statusVersion,
      now,
    })
    if (moved === 'conflict' && generation.status !== 'processing') return 'retry'
    await ensureEvent(deps, generation.id, 'poll_status', attempt.id, now, 0)
    await finishStart(deps, generation.id, lease, now)
    await releaseAttemptLease(deps.database, { attemptId: attempt.id, lease, now })
    return 'ack'
  }
  const adapter = adapterFor(deps, generation.routeSnapshot)
  if (!adapter) return moveNeedsReview(deps, generation, 'provider_adapter_missing', now)
  const started = await markDispatchStarted(deps.database, {
    attemptId: attempt.id,
    lease,
    submissionKey: attempt.submitKey,
    now,
  })
  if (started === 'conflict') return recoverStep(deps, generation, attempt, lease, now)
  const submission = submissionFor(generation.routeSnapshot, attempt.submitKey, now.getTime())
  let result
  try {
    result = await adapter.submit(submission)
  }
  catch (error) {
    if (error instanceof ProviderError) {
      await advanceGeneration(deps.database, {
        generationId: generation.id,
        userId: generation.userId,
        fromStatus: 'submitting',
        expectedVersion: generation.statusVersion,
        toStatus: 'submission_unknown',
        now,
      })
      await ensureEvent(deps, generation.id, 'poll_status', attempt.id, now, limits(deps).pollDelaySeconds)
      await finishStart(deps, generation.id, lease, now)
      await releaseAttemptLease(deps.database, { attemptId: attempt.id, lease, now })
      return 'ack'
    }
    throw error
  }
  if (result.kind === 'accepted') {
    return persistAccepted(deps, generation, attempt, lease, result.handle.jobId, result.handle.metadata, now, 'not_submitted')
  }
  if (result.kind === 'unknown') {
    const saved = await saveUnknownAttempt(deps.database, {
      attemptId: attempt.id,
      lease,
      metadata: result.recoveryMetadata,
      now,
    })
    if (saved === 'conflict') return 'retry'
    await advanceGeneration(deps.database, {
      generationId: generation.id,
      userId: generation.userId,
      fromStatus: 'submitting',
      expectedVersion: generation.statusVersion,
      toStatus: 'submission_unknown',
      now,
    })
    await ensureEvent(deps, generation.id, 'poll_status', attempt.id, now, limits(deps).pollDelaySeconds)
    await finishStart(deps, generation.id, lease, now)
    await releaseAttemptLease(deps.database, { attemptId: attempt.id, lease, now })
    return 'ack'
  }
  return persistRejected(deps, generation, attempt, lease, result.failure.code, now)
}

async function persistAccepted(
  deps: VideoEngineDeps,
  generation: GenerationRow,
  attempt: AttemptRow,
  lease: Lease,
  providerRequestId: string,
  metadata: JsonObject,
  now: Date,
  fromAcceptance: 'not_submitted' | 'unknown',
): Promise<Outcome> {
  const saved = await saveAcceptedAttempt(deps.database, {
    attemptId: attempt.id,
    lease,
    providerRequestId,
    metadata,
    payloadHash: payloadHash(attempt.submitKey, now.getTime(), generation.id),
    fromAcceptance,
    now,
  })
  if (saved === 'conflict') return 'retry'
  const current = await readGeneration(deps.database, generation.id)
  if (!current) return 'retry'
  if (current.status !== 'processing') {
    const moved = await advanceGeneration(deps.database, {
      generationId: current.id,
      userId: current.userId,
      fromStatus: current.status,
      toStatus: 'processing',
      expectedVersion: current.statusVersion,
      now,
    })
    if (moved === 'conflict') return 'retry'
  }
  await ensureEvent(deps, generation.id, 'poll_status', attempt.id, now, 0)
  await finishStart(deps, generation.id, lease, now)
  await releaseAttemptLease(deps.database, { attemptId: attempt.id, lease, now })
  return 'ack'
}

async function persistRejected(
  deps: VideoEngineDeps,
  generation: GenerationRow,
  attempt: AttemptRow,
  lease: Lease,
  errorCode: string,
  now: Date,
): Promise<Outcome> {
  const retryable = RETRYABLE_REJECTION.has(errorCode) && attempt.attemptNumber < limits(deps).maxSubmitAttempts
  if (retryable) {
    const nextLease = newLease(deps, now)
    const replaced = await replaceWithNextAttempt(deps.database, {
      generationId: generation.id,
      attemptId: attempt.id,
      nextAttemptId: `att_${crypto.randomUUID()}`,
      nextAttemptNumber: attempt.attemptNumber + 1,
      providerId: generation.routeSnapshot.providerId,
      lease,
      nextLease,
      now,
    })
    if (replaced === 'conflict') return 'retry'
    const next = (await readAttempts(deps.database, generation.id)).at(-1)
    if (!next) return 'retry'
    return submitStep(deps, generation, next, nextLease, now)
  }
  return settleFailure(deps, generation, attempt, lease, 'submission_rejected', errorCode, null, now)
}

async function recoverStep(
  deps: VideoEngineDeps,
  generation: GenerationRow,
  attempt: AttemptRow | null,
  lease: Lease,
  now: Date,
): Promise<Outcome> {
  if (!attempt) return moveNeedsReview(deps, generation, 'submission_unrecoverable', now)
  if (!(await holdAttempt(deps, attempt, lease, now))) return 'retry'
  if (attempt.acceptanceStatus === 'accepted' && attempt.providerRequestId) {
    if (generation.status !== 'processing') {
      const moved = await advanceGeneration(deps.database, {
        generationId: generation.id,
        userId: generation.userId,
        fromStatus: generation.status,
        toStatus: 'processing',
        expectedVersion: generation.statusVersion,
        now,
      })
      if (moved === 'conflict') return 'retry'
    }
    await ensureEvent(deps, generation.id, 'poll_status', attempt.id, now, 0)
    await finishStart(deps, generation.id, lease, now)
    await releaseAttemptLease(deps.database, { attemptId: attempt.id, lease, now })
    return 'ack'
  }
  const adapter = adapterFor(deps, generation.routeSnapshot)
  if (!adapter?.recoverSubmission) return moveNeedsReview(deps, generation, 'submission_unrecoverable', now)
  const submittedAtMs = attempt.submittedAt?.getTime() ?? metaNumber(attempt.recoveryMetadata, 'submittedAtMs') ?? now.getTime()
  const submission = submissionFor(generation.routeSnapshot, attempt.submitKey, submittedAtMs)
  const savedMetadata = providerMetadata(attempt.recoveryMetadata)
  let recovered
  if (savedMetadata && metaPhase(attempt.recoveryMetadata) !== 'dispatch_started') {
    recovered = await adapter.recoverSubmission(submission, savedMetadata)
  }
  else if (adapter.submissionIdempotency === 'deterministic_mock' && adapter.projectSubmission) {
    const projected = await adapter.projectSubmission(submission)
    if (projected.kind === 'rejected') return persistRejected(deps, generation, attempt, lease, projected.failure.code, now)
    const metadata = projected.kind === 'accepted' ? projected.handle.metadata : projected.recoveryMetadata
    recovered = await adapter.recoverSubmission(submission, metadata)
  }
  else {
    return moveNeedsReview(deps, generation, 'submission_unrecoverable', now)
  }
  if (recovered.kind === 'unknown') {
    await advanceGeneration(deps.database, {
      generationId: generation.id,
      userId: generation.userId,
      fromStatus: generation.status === 'queued' ? 'submitting' : generation.status,
      toStatus: 'submission_unknown',
      expectedVersion: generation.statusVersion,
      now,
    })
    await ensureEvent(deps, generation.id, 'poll_status', attempt.id, now, limits(deps).pollDelaySeconds)
    await releaseAttemptLease(deps.database, { attemptId: attempt.id, lease, now })
    return 'ack'
  }
  if (recovered.kind === 'not_found') {
    if (attempt.attemptNumber < limits(deps).maxSubmitAttempts) {
      const nextLease = newLease(deps, now)
      const replaced = await replaceWithNextAttempt(deps.database, {
        generationId: generation.id,
        attemptId: attempt.id,
        nextAttemptId: `att_${crypto.randomUUID()}`,
        nextAttemptNumber: attempt.attemptNumber + 1,
        providerId: generation.routeSnapshot.providerId,
        lease,
        nextLease,
        now,
      })
      if (replaced === 'conflict') return 'retry'
      const queued = await advanceGeneration(deps.database, {
        generationId: generation.id,
        userId: generation.userId,
        fromStatus: generation.status,
        toStatus: 'queued',
        expectedVersion: generation.statusVersion,
        now,
      })
      if (queued === 'conflict') return 'retry'
      await ensureEvent(deps, generation.id, 'start_submission', null, now, 0)
      return 'ack'
    }
    const reviewed = await moveNeedsReview(deps, generation, 'recovery_confirmed_absent', now)
    if (reviewed === 'retry') return reviewed
    const current = await readGeneration(deps.database, generation.id)
    if (!current || current.status !== 'needs_review') return 'ack'
    return settleFailure(deps, current, attempt, lease, 'recovery_confirmed_absent', 'recovery_confirmed_absent', null, now)
  }
  return persistAccepted(deps, generation, attempt, lease, recovered.handle.jobId, recovered.handle.metadata, now, attempt.acceptanceStatus === 'unknown' ? 'unknown' : 'not_submitted')
}

async function pollStep(
  deps: VideoEngineDeps,
  generation: GenerationRow,
  attempt: AttemptRow | null,
  lease: Lease,
  message: VideoQueueMessage,
  now: Date,
): Promise<Outcome> {
  if (!attempt?.providerRequestId) return 'retry'
  if (!(await holdAttempt(deps, attempt, lease, now))) return 'retry'
  const outbox = message.eventId ? await readOutbox(deps.database, message.eventId) : null
  if (outbox && outbox.deliveryStatus === 'pending') {
    const claimed = await claimOutbox(deps.database, outbox.id, lease, now)
    if (!claimed) return 'retry'
  }
  const adapter = adapterFor(deps, generation.routeSnapshot)
  if (!adapter) return moveNeedsReview(deps, generation, 'provider_adapter_missing', now)
  const metadata = providerMetadata(attempt.recoveryMetadata)
  if (!metadata) return moveNeedsReview(deps, generation, 'submission_unrecoverable', now)
  const polls = pollCount(attempt.recoveryMetadata)
  if (polls >= limits(deps).maxPolls) return moveNeedsReview(deps, generation, 'poll_budget_exhausted', now)
  let status
  try {
    status = await adapter.getStatus({
      providerId: attempt.providerId,
      providerModelId: generation.routeSnapshot.providerModelId,
      adapterVersion: generation.routeSnapshot.adapterVersion,
      jobId: attempt.providerRequestId,
      metadata,
    }, generation.routeSnapshot)
  }
  catch (error) {
    if (!(error instanceof ProviderError)) throw error
    await bumpPollCount(deps.database, { attemptId: attempt.id, lease, pollCount: polls + 1, now })
    await reschedulePoll(deps, generation.id, attempt.id, outbox?.id ?? null, lease, now)
    await releaseAttemptLease(deps.database, { attemptId: attempt.id, lease, now })
    return 'ack'
  }
  if (status.state === 'pending') {
    await bumpPollCount(deps.database, { attemptId: attempt.id, lease, pollCount: polls + 1, now })
    await reschedulePoll(deps, generation.id, attempt.id, outbox?.id ?? null, lease, now)
    await releaseAttemptLease(deps.database, { attemptId: attempt.id, lease, now })
    return 'ack'
  }
  if (status.state === 'failed') {
    await recordCost(deps, attempt, status.cost, now)
    return settleFailure(deps, generation, attempt, lease, 'provider_failed', status.failure.code, attempt.providerRequestId, now)
  }
  if (status.output.kind === 'remote') {
    await recordCost(deps, attempt, status.cost, now)
    return moveNeedsReview(deps, generation, 'remote_output_unsupported', now)
  }
  await recordCost(deps, attempt, status.cost, now)
  const moved = await advanceGeneration(deps.database, {
    generationId: generation.id,
    userId: generation.userId,
    fromStatus: 'processing',
    toStatus: 'storing',
    expectedVersion: generation.statusVersion,
    now,
  })
  if (moved === 'conflict') return 'retry'
  await ensureEvent(deps, generation.id, 'store_output', attempt.id, now, 0)
  if (outbox) {
    await markOutboxDelivered(deps.database, {
      outboxId: outbox.id,
      generationId: generation.id,
      eventType: 'poll_status',
      lease,
      now,
    })
  }
  await releaseAttemptLease(deps.database, { attemptId: attempt.id, lease, now })
  return 'ack'
}

async function storeStep(
  deps: VideoEngineDeps,
  generation: GenerationRow,
  attempt: AttemptRow | null,
  lease: Lease,
  now: Date,
): Promise<Outcome> {
  if (!attempt?.providerRequestId) return moveNeedsReview(deps, generation, 'storage_unrecoverable', now)
  if (!(await holdAttempt(deps, attempt, lease, now))) return 'retry'
  const outbox = await readInflightOutbox(deps.database, generation.id, 'store_output')
  if (!outbox) {
    await ensureEvent(deps, generation.id, 'store_output', attempt.id, now, 0)
    return 'retry'
  }
  const claimed = outbox.deliveryStatus === 'leased' && outbox.leaseToken === lease.token
    ? true
    : await claimOutbox(deps.database, outbox.id, lease, now)
  if (!claimed) return 'retry'
  const metadata = providerMetadata(attempt.recoveryMetadata)
  const fixtureId = typeof metadata?.fixtureId === 'string' ? metadata.fixtureId : null
  if (fixtureId !== deps.fixture.fixtureId || deps.fixture.contentType !== 'video/mp4') {
    return settleFailure(deps, generation, attempt, lease, 'storage_irrecoverable', 'storage_validation_failed', attempt.providerRequestId, now)
  }
  if (deps.fixture.bytes.byteLength === 0 || deps.fixture.bytes.byteLength > 5_000_000) {
    return settleFailure(deps, generation, attempt, lease, 'storage_irrecoverable', 'storage_validation_failed', attempt.providerRequestId, now)
  }
  const contentHash = createHash('sha256').update(deps.fixture.bytes).digest('hex')
  const finalKey = finalOutputKey(deps.environment, generation.id, attempt.id)
  const tempKey = tempOutputKey(deps.environment, generation.id, attempt.id, lease.token)
  const existing = await deps.store.head(finalKey)
  if (!existing || existing.byteSize !== deps.fixture.bytes.byteLength || existing.contentType !== 'video/mp4') {
    await deps.store.put(tempKey, deps.fixture.bytes, 'video/mp4')
    const tempHead = await deps.store.head(tempKey)
    if (!tempHead || tempHead.byteSize !== deps.fixture.bytes.byteLength || tempHead.contentType !== 'video/mp4') {
      return 'retry'
    }
    await deps.store.put(finalKey, deps.fixture.bytes, 'video/mp4')
    const finalHead = await deps.store.head(finalKey)
    if (!finalHead || finalHead.byteSize !== deps.fixture.bytes.byteLength || finalHead.contentType !== 'video/mp4') {
      return 'retry'
    }
  }
  await rememberOutputObject(deps.database, { attemptId: attempt.id, lease, objectKey: finalKey, contentHash, now })
  const assetId = `asset_${generation.id}_${attempt.id}`
  const current = await readGeneration(deps.database, generation.id)
  if (!current) return 'retry'
  if (current.status === 'succeeded' && current.outputAssetId === assetId) {
    await deleteIfUnreferenced(deps, tempKey)
    return 'ack'
  }
  const stored = await insertOutputAndSucceed(deps.database, {
    userId: generation.userId,
    generationId: generation.id,
    expectedVersion: current.statusVersion,
    attemptId: attempt.id,
    outboxId: outbox.id,
    lease,
    assetId,
    objectKey: finalKey,
    contentType: 'video/mp4',
    byteSize: deps.fixture.bytes.byteLength,
    contentHash,
    now,
  })
  if (stored === 'conflict') {
    const after = await readGeneration(deps.database, generation.id)
    if (after?.status === 'succeeded') {
      await deleteIfUnreferenced(deps, tempKey)
      return 'ack'
    }
    return 'retry'
  }
  await deleteIfUnreferenced(deps, tempKey)
  const referenced = await readAssetByKey(deps.database, finalKey)
  if (!referenced) return 'retry'
  return 'ack'
}

async function settleFailure(
  deps: VideoEngineDeps,
  generation: GenerationRow,
  attempt: AttemptRow | null,
  lease: Lease,
  event: 'submission_rejected' | 'provider_failed' | 'storage_irrecoverable' | 'recovery_confirmed_absent' | 'deadline_reached',
  errorCode: string,
  providerRequestId: string | null,
  now: Date,
): Promise<Outcome> {
  const evidenceId = `evidence:${attempt?.id ?? generation.id}:${event}`
  const composeBefore: LedgerBatchStatement[] = []
  if (attempt && event !== 'deadline_reached') {
    composeBefore.push(settlementEvidenceUpdate(deps.database, {
      attemptId: attempt.id,
      lease,
      event,
      evidenceId,
      providerRequestId,
      now,
    }))
  }
  const result = await returnCreditsForFailedGeneration(deps.database, {
    userId: generation.userId,
    generationId: generation.id,
    operationId: videoReturnOperationKey(generation.id),
    event,
    expectedVersion: generation.statusVersion,
    leaseOwner: lease.owner,
    leaseToken: lease.token,
    errorCode,
    nowMs: now.getTime(),
    ...(attempt && event !== 'deadline_reached' ? { attemptId: attempt.id, evidenceId } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
    composeBefore,
  })
  if (!result.ok && result.reason !== 'aborted') {
    const current = await readGeneration(deps.database, generation.id)
    if (current?.status === 'failed' || current?.status === 'succeeded') return 'ack'
  }
  return result.ok ? 'ack' : 'retry'
}

async function settleDeadline(deps: VideoEngineDeps, generation: GenerationRow, lease: Lease, now: Date): Promise<Outcome> {
  const outbox = await readInflightOutbox(deps.database, generation.id, 'start_submission')
  if (!outbox) return 'retry'
  const claimed = await claimOutbox(deps.database, outbox.id, lease, now)
  if (!claimed) return 'retry'
  return settleFailure(deps, generation, null, lease, 'deadline_reached', 'deadline_reached', null, now)
}

async function handleDeadLetter(
  deps: VideoEngineDeps,
  message: VideoQueueMessage,
  generation: GenerationRow,
  now: Date,
): Promise<Outcome> {
  const attempts = await readAttempts(deps.database, generation.id)
  const latest = attempts.at(-1) ?? null
  const named = message.attemptId ? attempts.find(attempt => attempt.id === message.attemptId) ?? null : null
  const decision = assessDeadLetter({
    message,
    status: generation.status,
    latestAttemptId: latest?.id ?? null,
    latestAttemptNumber: latest?.attemptNumber ?? 0,
    messageAttemptNumber: named?.attemptNumber ?? null,
    acceptanceStatus: latest?.acceptanceStatus ?? null,
    hasProviderRequestId: Boolean(latest?.providerRequestId),
  })
  if (decision.action === 'ignore') return 'ack'
  if (decision.action === 'requeue') {
    await ensureEvent(deps, generation.id, decision.eventType, latest?.id ?? null, now, 0)
    return 'ack'
  }
  return moveNeedsReview(deps, generation, decision.errorCode, now)
}

async function moveNeedsReview(deps: VideoEngineDeps, generation: GenerationRow, errorCode: string, now: Date): Promise<Outcome> {
  if (generation.status === 'needs_review' || generation.status === 'succeeded' || generation.status === 'failed') return 'ack'
  const moved = await advanceGeneration(deps.database, {
    generationId: generation.id,
    userId: generation.userId,
    fromStatus: generation.status,
    toStatus: 'needs_review',
    expectedVersion: generation.statusVersion,
    errorCode,
    now,
  })
  if (moved === 'conflict') {
    const current = await readGeneration(deps.database, generation.id)
    if (current?.status === 'succeeded' || current?.status === 'failed' || current?.status === 'needs_review') return 'ack'
    return 'retry'
  }
  return 'ack'
}

async function recordCost(deps: VideoEngineDeps, attempt: AttemptRow, cost: ProviderCost, now: Date): Promise<void> {
  const existing = await readCosts(deps.database, attempt.id)
  if (existing.length > 0) return
  const known = cost.kind === 'unknown'
    ? { costKind: 'unknown' as const, amountMicros: null, currency: null, source: 'provider' }
    : { costKind: cost.kind, amountMicros: cost.amountMicros, currency: cost.currency, source: cost.source }
  await commitVideoBatch(deps.database, [
    providerCostInsert(deps.database, {
      id: `cost_${attempt.id}_${known.costKind}`,
      attemptId: attempt.id,
      providerId: attempt.providerId,
      now,
      ...known,
    }),
  ])
}

async function reschedulePoll(
  deps: VideoEngineDeps,
  generationId: string,
  attemptId: string,
  outboxId: string | null,
  lease: Lease,
  now: Date,
): Promise<void> {
  if (outboxId) {
    await markOutboxDelivered(deps.database, {
      outboxId,
      generationId,
      eventType: 'poll_status',
      lease,
      now,
    })
  }
  await ensureEvent(deps, generationId, 'poll_status', attemptId, now, limits(deps).pollDelaySeconds)
}

async function finishStart(deps: VideoEngineDeps, generationId: string, lease: Lease, now: Date): Promise<void> {
  const outbox = await readInflightOutbox(deps.database, generationId, 'start_submission')
  if (!outbox) return
  if (outbox.leaseToken !== lease.token) {
    const claimed = await claimOutbox(deps.database, outbox.id, lease, now)
    if (!claimed) return
  }
  await markOutboxDelivered(deps.database, {
    outboxId: outbox.id,
    generationId,
    eventType: 'start_submission',
    lease,
    now,
  })
}

async function ensureEvent(
  deps: VideoEngineDeps,
  generationId: string,
  eventType: 'start_submission' | 'poll_status' | 'store_output',
  attemptId: string | null,
  now: Date,
  delaySeconds: number,
): Promise<void> {
  const existing = await readInflightOutbox(deps.database, generationId, eventType)
  if (existing) return
  const notBefore = new Date(now.getTime() + delaySeconds * 1000)
  await enqueueOutbox(deps.database, {
    id: `obx_${crypto.randomUUID()}`,
    generationId,
    eventType,
    attemptId,
    notBefore,
    now,
  })
}

async function holdAttempt(deps: VideoEngineDeps, attempt: AttemptRow, lease: Lease, now: Date): Promise<boolean> {
  if (attempt.leaseToken === lease.token && attempt.leaseUntil && attempt.leaseUntil > now) return true
  const claimed = await claimAttempt(deps.database, attempt.id, lease, now)
  return claimed
}

async function deleteIfUnreferenced(deps: VideoEngineDeps, key: string): Promise<void> {
  const asset = await readAssetByKey(deps.database, key)
  if (!asset) await deps.store.delete(key)
}

function adapterFor(deps: VideoEngineDeps, snapshot: RouteSnapshot): ProviderAdapter | null {
  if (deps.environment === 'production') return null
  try {
    return deps.providers.forSnapshot(snapshot)
  }
  catch {
    return null
  }
}

function submissionFor(snapshot: RouteSnapshot, key: string, submittedAtMs: number): ProviderSubmission {
  return { snapshot, submissionKey: key, submittedAtMs }
}

function payloadHash(key: string, submittedAtMs: number, generationId: string): string {
  return createHash('sha256').update(`${generationId}\n${key}\n${submittedAtMs}`).digest('hex')
}

function newLease(deps: VideoEngineDeps, now: Date): Lease {
  return {
    owner: deps.workerId,
    token: `lease_${crypto.randomUUID()}`,
    until: new Date(now.getTime() + limits(deps).leaseMs),
  }
}

function limits(deps: VideoEngineDeps): VideoLimits {
  return { ...DEFAULT_LIMITS, ...deps.limits }
}

function flooredNow(deps: VideoEngineDeps): Date | null {
  const floored = floorToSqliteMs(deps.clock.nowMs())
  return floored === null ? null : new Date(floored)
}

function metaPhase(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const phase = (value as Record<string, unknown>).phase
  return typeof phase === 'string' ? phase : null
}

function metaNumber(value: unknown, key: string): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const number = (value as Record<string, unknown>)[key]
  return typeof number === 'number' && Number.isSafeInteger(number) ? number : null
}

function providerMetadata(value: unknown): JsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, JsonObject[string]>
  const nested = record.providerMetadata
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested as JsonObject
  return null
}

function pollCount(value: unknown): number {
  const count = metaNumber(value, 'pollCount')
  return count ?? 0
}
