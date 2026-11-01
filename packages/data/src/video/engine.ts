import { createHash } from 'node:crypto'
import type { JsonObject, RouteSnapshot } from '@reelbam/video-contracts/internal'
import { ProviderError } from '../../../video-core/src/provider.ts'
import type { ProviderAdapter, ProviderCost, ProviderSubmission } from '../../../video-core/src/provider.ts'
import type { ProviderRegistry } from '../../../video-core/src/providers/registry.ts'
import type { GenerationEvent } from '../../../video-core/src/state-machine.ts'
import type { Database } from '../client.ts'
import { videoReturnOperationKey } from '../credits/contract.ts'
import { returnCreditsForFailedGeneration } from '../credits/return.ts'
import { floorToSqliteMs } from '../credits/runtime.ts'
import { commitVideoBatch } from './batch.ts'
import {
  acceptedAttemptStatement, advanceGeneration, claimAttempt, claimOutbox, claimStoreOutbox,
  completeEventStatement, dispatchStartedStatement, enqueueOutbox, generationAdvanceStatement,
  generationCheckpoint, insertOutputAndSucceed, openAttempt, outboxInsert, outputObjectStatement,
  providerCostInsert, queueNextAttempt, releaseAttemptStatement, reserveAttemptWork,
  retireObsoleteOutbox, settlementEvidenceUpdate, unknownAttemptStatement, type Lease,
  startStorageStatement,
} from './durable.ts'
import {
  assessDeadLetter, DEFAULT_LIMITS, finalOutputKey, MAX_OUTPUT_BYTES, parseVideoQueueMessage,
  type VideoLimits, type VideoObjectStore, type VideoOutboxEventType, type VideoQueueMessage,
} from './protocol.ts'
import { readAttempts, readCosts, readGeneration, readInflightOutbox, readLastOutbox, readOutbox } from './rows.ts'

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
  readonly fixture: { readonly fixtureId: string, readonly bytes: Uint8Array, readonly contentType: string, readonly contentHash: string }
  readonly limits?: Partial<VideoLimits>
}

const RETRYABLE_REJECTION = new Set(['rate_limited', 'provider_unavailable', 'provider_timeout'])

export async function handleVideoMessage(
  deps: VideoEngineDeps, raw: unknown, source: 'queue' | 'dlq' | 'maintenance',
): Promise<Outcome> {
  const message = parseVideoQueueMessage(raw)
  if (!message) return 'ack'
  const generation = await readGeneration(deps.database, message.generationId)
  if (!generation) return 'ack'
  await retireObsoleteOutbox(deps.database, generation.id, nowOf(deps))
  if (stopped(generation)) return 'ack'
  const attempts = await readAttempts(deps.database, generation.id)
  const latest = attempts.at(-1) ?? null

  // DLQ never performs provider calls or settles credits, even after a deadline.
  if (source === 'dlq') return handleDeadLetter(deps, message, generation, attempts)
  const now = nowOf(deps)
  if (generation.status === 'queued' && now >= generation.deadlineAt) {
    return settleDeadline(deps, generation, latest)
  }
  if (generation.status !== 'storing' && now >= generation.deadlineAt) {
    return moveNeedsReview(deps, generation, 'deadline_unconfirmed')
  }
  if (generation.status === 'storing' && storageExpired(deps, generation, latest, now)) {
    return moveNeedsReview(deps, generation, 'storage_deadline_exceeded')
  }
  if (source === 'maintenance') return 'ack'

  // An event is durable work, not an instruction to run whatever a message says.
  const outbox = await readOutbox(deps.database, message.eventId)
  if (!outbox || outbox.generationId !== generation.id || outbox.eventType !== message.eventType) return 'ack'
  const saved = parseVideoQueueMessage(outbox.payload)
  if (!saved || saved.attemptId !== message.attemptId || saved.stepId !== message.stepId) return 'ack'
  if (outbox.deliveryStatus === 'delivered') return 'ack'
  if (outbox.notBefore > now) return 'retry'
  if (outbox.deliveryStatus === 'dead') return moveNeedsReview(deps, generation, 'outbox_delivery_exhausted')
  if (message.attemptId && message.attemptId !== latest?.id) return 'ack'
  if (message.eventType !== eventFor(generation)) return 'ack'

  const lease = newLease(deps, nowOf(deps))
  let outcome: Outcome
  if (generation.status === 'queued' || generation.status === 'submitting') {
    outcome = await submitStep(deps, generation, latest, lease)
  }
  else if (generation.status === 'submission_unknown') outcome = await recoverStep(deps, generation, latest, lease)
  else if (generation.status === 'processing') outcome = await pollStep(deps, generation, latest, lease)
  else if (generation.status === 'storing') outcome = await storeStep(deps, generation, latest, lease)
  else outcome = 'ack'
  if (outcome === 'ack') await retireObsoleteOutbox(deps.database, generation.id, nowOf(deps))
  return outcome
}

async function submitStep(deps: VideoEngineDeps, generation: GenerationRow, attempt: AttemptRow | null, lease: Lease): Promise<Outcome> {
  if (!attempt || attempt.acceptanceStatus === 'rejected') {
    if (generation.status !== 'queued') return moveNeedsReview(deps, generation, 'attempt_state_inconsistent')
    if (attempt && attempt.attemptNumber >= limits(deps).maxSubmitAttempts) return moveNeedsReview(deps, generation, 'submit_budget_exhausted')
    const id = 'att_' + crypto.randomUUID()
    const opened = await openAttempt(deps.database, {
      generationId: generation.id, userId: generation.userId, attemptId: id,
      attemptNumber: attempt ? attempt.attemptNumber + 1 : 1, providerId: generation.routeSnapshot.providerId,
      expectedVersion: generation.statusVersion, lease, now: nowOf(deps),
    })
    if (opened === 'conflict') return 'retry'
    generation = { ...generation, status: 'submitting', statusVersion: generation.statusVersion + 1 }
    attempt = (await readAttempts(deps.database, generation.id)).find(row => row.id === id) ?? null
  }
  if (!attempt || !(await claimAttempt(deps.database, attempt.id, lease, nowOf(deps)))) return 'retry'
  attempt = (await readAttempts(deps.database, generation.id)).find(row => row.id === attempt!.id) ?? null
  if (!attempt) return 'retry'

  if (generation.status === 'queued') {
    if (unresolved(attempt)) return moveNeedsReview(deps, generation, 'queued_submission_inconsistent', attempt, lease)
    const moved = await advanceGeneration(deps.database, {
      ...advanceInput(generation, attempt, lease, nowOf(deps)), event: 'start_submission',
    })
    if (moved === 'conflict') return 'retry'
    generation = { ...generation, status: 'submitting', statusVersion: generation.statusVersion + 1 }
  }
  if (attempt.acceptanceStatus === 'accepted' && attempt.providerRequestId) {
    return resumeAccepted(deps, generation, attempt, lease)
  }
  if (metaString(attempt.recoveryMetadata, 'phase') === 'dispatch_started' || attempt.acceptanceStatus === 'unknown') {
    const moved = await advanceGeneration(deps.database, {
      ...advanceInput(generation, attempt, lease, nowOf(deps)), event: 'submission_unknown',
    })
    if (moved === 'conflict') return 'retry'
    return recoverStep(deps, { ...generation, status: 'submission_unknown', statusVersion: generation.statusVersion + 1 }, attempt, lease)
  }
  const adapter = adapterFor(deps, generation.routeSnapshot)
  if (!adapter) return moveNeedsReview(deps, generation, 'provider_adapter_missing', attempt, lease)
  const now = nowOf(deps)
  if (now >= generation.deadlineAt) return moveNeedsReview(deps, generation, 'deadline_unconfirmed', attempt, lease)
  const started = await commitVideoBatch(deps.database, [
    checkpoint(deps, generation, attempt, lease, now),
    dispatchStartedStatement(deps.database, { attemptId: attempt.id, lease, submissionKey: attempt.submitKey, now }),
  ])
  if (started === 'conflict') return 'retry'
  const held = (await readAttempts(deps.database, generation.id)).find(row => row.id === attempt!.id)
  if (!held || held.leaseToken !== lease.token || !held.leaseUntil || held.leaseUntil <= nowOf(deps)) return 'retry'
  const submission = submissionFor(generation.routeSnapshot, attempt.submitKey, now.getTime())
  let result
  try {
    result = await adapter.submit(submission)
  }
  catch (error) {
    // Unexpected interruption leaves dispatch_started durable for takeover; never resubmit.
    if (!(error instanceof ProviderError)) throw error
    return persistUnknown(deps, generation, attempt, lease)
  }
  if (result.kind === 'accepted') return persistAccepted(deps, generation, attempt, lease, result.handle.jobId, result.handle.metadata, submission)
  if (result.kind === 'unknown') return persistUnknown(deps, generation, attempt, lease, result.recoveryMetadata)
  return persistRejected(deps, generation, attempt, lease, result.failure.code)
}

async function persistAccepted(
  deps: VideoEngineDeps, generation: GenerationRow, attempt: AttemptRow, lease: Lease,
  requestId: string, metadata: JsonObject, submission: ProviderSubmission,
): Promise<Outcome> {
  const now = nowOf(deps)
  // Accepted handle, legal generation edge and the next event commit together.
  const result = await commitVideoBatch(deps.database, [
    acceptedAttemptStatement(deps.database, {
      attemptId: attempt.id, lease, providerRequestId: requestId, metadata,
      payloadHash: createHash('sha256').update(JSON.stringify(submission)).digest('hex'),
      fromAcceptance: attempt.acceptanceStatus === 'unknown' ? 'unknown' : 'not_submitted', now,
    }),
    generationAdvanceStatement(deps.database, {
      ...advanceInput(generation, attempt, lease, now),
      event: generation.status === 'submitting' ? 'submission_accepted' : 'recovered_accepted',
    }),
    completeEventStatement(deps.database, generation.id, 'start_submission', now),
    ...nextEvent(deps, generation, attempt, 'poll_status', now, 0),
    releaseAttemptStatement(deps.database, attempt.id, lease, now),
  ])
  return result === 'ok' ? 'ack' : 'retry'
}

async function resumeAccepted(deps: VideoEngineDeps, generation: GenerationRow, attempt: AttemptRow, lease: Lease): Promise<Outcome> {
  const now = nowOf(deps)
  const result = await commitVideoBatch(deps.database, [
    generationAdvanceStatement(deps.database, {
      ...advanceInput(generation, attempt, lease, now),
      event: generation.status === 'submitting' ? 'submission_accepted' : 'recovered_accepted',
    }),
    completeEventStatement(deps.database, generation.id, 'start_submission', now),
    ...nextEvent(deps, generation, attempt, 'poll_status', now, 0),
    releaseAttemptStatement(deps.database, attempt.id, lease, now),
  ])
  return result === 'ok' ? 'ack' : 'retry'
}

async function persistUnknown(
  deps: VideoEngineDeps, generation: GenerationRow, attempt: AttemptRow, lease: Lease, metadata?: JsonObject,
): Promise<Outcome> {
  const now = nowOf(deps)
  const result = await commitVideoBatch(deps.database, [
    ...(metadata ? [unknownAttemptStatement(deps.database, { attemptId: attempt.id, lease, metadata, now })] : []),
    generationAdvanceStatement(deps.database, { ...advanceInput(generation, attempt, lease, now), event: 'submission_unknown' }),
    completeEventStatement(deps.database, generation.id, 'start_submission', now),
    ...nextEvent(deps, generation, attempt, 'poll_status', now, limits(deps).pollDelaySeconds),
    releaseAttemptStatement(deps.database, attempt.id, lease, now),
  ])
  return result === 'ok' ? 'ack' : 'retry'
}

async function persistRejected(deps: VideoEngineDeps, generation: GenerationRow, attempt: AttemptRow, lease: Lease, code: string): Promise<Outcome> {
  if (RETRYABLE_REJECTION.has(code) && attempt.attemptNumber < limits(deps).maxSubmitAttempts) {
    return requeueAbsent(deps, generation, attempt, lease)
  }
  // A projected rejection is an authoritative absence, not a second Submit.
  if (generation.status === 'submission_unknown') {
    const moved = await moveNeedsReview(deps, generation, 'recovery_confirmed_absent', attempt, lease)
    if (moved === 'retry') return moved
    return settleFailure(deps, { ...generation, status: 'needs_review', statusVersion: generation.statusVersion + 1 },
      attempt, lease, 'recovery_confirmed_absent', code, null)
  }
  return settleFailure(deps, generation, attempt, lease, 'submission_rejected', code, null)
}

async function requeueAbsent(deps: VideoEngineDeps, generation: GenerationRow, attempt: AttemptRow, lease: Lease): Promise<Outcome> {
  if (generation.status !== 'submitting' && generation.status !== 'submission_unknown') return 'retry'
  const result = await queueNextAttempt(deps.database, {
    generationId: generation.id, userId: generation.userId, expectedVersion: generation.statusVersion,
    fromStatus: generation.status, attemptId: attempt.id, lease, now: nowOf(deps),
  })
  return result === 'ok' ? 'ack' : 'retry'
}

async function recoverStep(deps: VideoEngineDeps, generation: GenerationRow, attempt: AttemptRow | null, lease: Lease): Promise<Outcome> {
  if (!attempt) return moveNeedsReview(deps, generation, 'submission_unrecoverable')
  if (!(await claimAttempt(deps.database, attempt.id, lease, nowOf(deps)))) return 'retry'
  if (attempt.acceptanceStatus === 'accepted' && attempt.providerRequestId) return resumeAccepted(deps, generation, attempt, lease)
  const adapter = adapterFor(deps, generation.routeSnapshot)
  if (!adapter?.recoverSubmission) return moveNeedsReview(deps, generation, 'submission_unrecoverable', attempt, lease)
  const count = metaNumber(attempt.recoveryMetadata, 'recoveryCount') ?? 0
  if (count >= limits(deps).maxPolls) return moveNeedsReview(deps, generation, 'recovery_budget_exhausted', attempt, lease)
  if (!(await reserveWork(deps, generation, attempt, lease, 'recoveryCount', count, limits(deps).maxPolls))) return 'retry'
  const submittedAt = attempt.submittedAt?.getTime() ?? metaNumber(attempt.recoveryMetadata, 'submittedAtMs')
  if (submittedAt === null) return moveNeedsReview(deps, generation, 'submission_unrecoverable', attempt, lease)
  const submission = submissionFor(generation.routeSnapshot, attempt.submitKey, submittedAt)
  let recovered
  try {
    const saved = providerMetadata(attempt.recoveryMetadata)
    if (saved && metaString(attempt.recoveryMetadata, 'phase') !== 'dispatch_started') {
      recovered = await adapter.recoverSubmission(submission, saved)
    }
    else if (adapter.submissionIdempotency === 'deterministic_mock' && adapter.projectSubmission) {
      const projected = await adapter.projectSubmission(submission)
      if (projected.kind === 'rejected') return persistRejected(deps, generation, attempt, lease, projected.failure.code)
      recovered = await adapter.recoverSubmission(submission, projected.kind === 'accepted' ? projected.handle.metadata : projected.recoveryMetadata)
    }
    else return moveNeedsReview(deps, generation, 'submission_unrecoverable', attempt, lease)
  }
  catch (error) {
    if (!(error instanceof ProviderError)) throw error
    return reschedule(deps, generation, attempt, lease, 'poll_status', count + 1)
  }
  if (recovered.kind === 'unknown') return reschedule(deps, generation, attempt, lease, 'poll_status', count + 1)
  if (recovered.kind === 'not_found') {
    if (attempt.attemptNumber < limits(deps).maxSubmitAttempts) return requeueAbsent(deps, generation, attempt, lease)
    const parked = await moveNeedsReview(deps, generation, 'recovery_confirmed_absent', attempt, lease)
    if (parked === 'retry') return parked
    return settleFailure(deps, { ...generation, status: 'needs_review', statusVersion: generation.statusVersion + 1 },
      attempt, lease, 'recovery_confirmed_absent', 'recovery_confirmed_absent', null)
  }
  return persistAccepted(deps, generation, attempt, lease, recovered.handle.jobId, recovered.handle.metadata, submission)
}

async function pollStep(deps: VideoEngineDeps, generation: GenerationRow, attempt: AttemptRow | null, lease: Lease): Promise<Outcome> {
  if (!attempt?.providerRequestId) return moveNeedsReview(deps, generation, 'submission_unrecoverable')
  if (!(await claimAttempt(deps.database, attempt.id, lease, nowOf(deps)))) return 'retry'
  const adapter = adapterFor(deps, generation.routeSnapshot)
  const metadata = providerMetadata(attempt.recoveryMetadata)
  if (!adapter || !metadata) return moveNeedsReview(deps, generation, 'provider_adapter_missing', attempt, lease)
  const count = metaNumber(attempt.recoveryMetadata, 'pollCount') ?? 0
  if (count >= limits(deps).maxPolls) return moveNeedsReview(deps, generation, 'poll_budget_exhausted', attempt, lease)
  if (!(await reserveWork(deps, generation, attempt, lease, 'pollCount', count, limits(deps).maxPolls))) return 'retry'
  let status
  try {
    status = await adapter.getStatus({
      providerId: attempt.providerId, providerModelId: generation.routeSnapshot.providerModelId,
      adapterVersion: generation.routeSnapshot.adapterVersion, jobId: attempt.providerRequestId, metadata,
    }, generation.routeSnapshot)
  }
  catch (error) {
    if (!(error instanceof ProviderError)) throw error
    return reschedule(deps, generation, attempt, lease, 'poll_status', count + 1, 'poll_call_failed')
  }
  if (status.state === 'pending') return reschedule(deps, generation, attempt, lease, 'poll_status', count + 1, 'provider_pending')
  await recordCost(deps, attempt, status.cost, nowOf(deps))
  if (status.state === 'failed') return settleFailure(deps, generation, attempt, lease, 'provider_failed', status.failure.code, attempt.providerRequestId)
  if (status.output.kind === 'remote') return moveNeedsReview(deps, generation, 'remote_output_unsupported', attempt, lease)
  if (status.output.fixtureId !== deps.fixture.fixtureId) return moveNeedsReview(deps, generation, 'fixture_mismatch', attempt, lease)
  const now = nowOf(deps)
  const result = await commitVideoBatch(deps.database, [
    startStorageStatement(deps.database, attempt.id, lease, now),
    generationAdvanceStatement(deps.database, { ...advanceInput(generation, attempt, lease, now), event: 'provider_completed' }),
    completeEventStatement(deps.database, generation.id, 'poll_status', now),
    ...nextEvent(deps, generation, attempt, 'store_output', now, 0),
    releaseAttemptStatement(deps.database, attempt.id, lease, now),
  ])
  return result === 'ok' ? 'ack' : 'retry'
}

async function storeStep(deps: VideoEngineDeps, generation: GenerationRow, attempt: AttemptRow | null, lease: Lease): Promise<Outcome> {
  if (!attempt?.providerRequestId) return moveNeedsReview(deps, generation, 'storage_unrecoverable')
  if (!(await claimAttempt(deps.database, attempt.id, lease, nowOf(deps)))) return 'retry'
  const outbox = await readInflightOutbox(deps.database, generation.id, 'store_output')
  if (!outbox) return 'retry'
  if (!(await claimStoreOutbox(deps.database, {
    generationId: generation.id, expectedVersion: generation.statusVersion,
    attemptId: attempt.id, outboxId: outbox.id, lease, now: nowOf(deps),
  }))) return 'retry'
  const count = metaNumber(attempt.recoveryMetadata, 'storageCount') ?? 0
  if (count >= limits(deps).maxStorageAttempts) return moveNeedsReview(deps, generation, 'storage_budget_exhausted', attempt, lease)
  if (!(await reserveWork(deps, generation, attempt, lease, 'storageCount', count, limits(deps).maxStorageAttempts))) return 'retry'
  const metadata = providerMetadata(attempt.recoveryMetadata)
  const hash = createHash('sha256').update(deps.fixture.bytes).digest('hex')
  if (metadata?.fixtureId !== deps.fixture.fixtureId || deps.fixture.contentType !== 'video/mp4'
    || deps.fixture.bytes.byteLength === 0 || deps.fixture.bytes.byteLength > MAX_OUTPUT_BYTES
    || hash !== deps.fixture.contentHash) {
    return settleFailure(deps, generation, attempt, lease, 'storage_irrecoverable', 'storage_validation_failed', attempt.providerRequestId)
  }
  const key = finalOutputKey(deps.environment, generation.id, attempt.id, hash)
  try {
    const existing = await deps.store.head(key)
    if (!existing) {
      await deps.store.put(key, deps.fixture.bytes, 'video/mp4', hash)
    }
    const head = existing ?? await deps.store.head(key)
    if (!head || head.byteSize !== deps.fixture.bytes.byteLength || head.contentType !== 'video/mp4' || head.contentHash !== hash) {
      return moveNeedsReview(deps, generation, 'storage_object_mismatch', attempt, lease)
    }
  }
  catch {
    if (count + 1 >= limits(deps).maxStorageAttempts) return moveNeedsReview(deps, generation, 'storage_budget_exhausted', attempt, lease)
    return reschedule(deps, generation, attempt, lease, 'store_output', count + 1)
  }
  // The object is immutable and recoverable. A failed D1 commit never triggers another Submit.
  const now = nowOf(deps)
  const remembered = await commitVideoBatch(deps.database, [
    checkpoint(deps, generation, attempt, lease, now),
    outputObjectStatement(deps.database, { attemptId: attempt.id, lease, objectKey: key, contentHash: hash, now }),
  ])
  if (remembered === 'conflict') return 'retry'
  const stored = await insertOutputAndSucceed(deps.database, {
    userId: generation.userId, generationId: generation.id, expectedVersion: generation.statusVersion,
    attemptId: attempt.id, outboxId: outbox.id, lease, assetId: 'asset_' + generation.id + '_' + attempt.id,
    objectKey: key, contentType: 'video/mp4', byteSize: deps.fixture.bytes.byteLength, contentHash: hash, now: nowOf(deps),
  })
  return stored === 'ok' ? 'ack' : 'retry'
}

async function settleFailure(
  deps: VideoEngineDeps, generation: GenerationRow, attempt: AttemptRow | null, lease: Lease,
  event: 'submission_rejected' | 'provider_failed' | 'storage_irrecoverable' | 'recovery_confirmed_absent' | 'deadline_reached',
  errorCode: string, providerRequestId: string | null,
): Promise<Outcome> {
  const now = nowOf(deps)
  const evidenceId = 'evidence:' + (attempt?.id ?? generation.id) + ':' + event
  const before = attempt && event !== 'deadline_reached'
    ? [settlementEvidenceUpdate(deps.database, { attemptId: attempt.id, lease, event, evidenceId, providerRequestId, now })] : []
  const result = await returnCreditsForFailedGeneration(deps.database, {
    userId: generation.userId, generationId: generation.id, operationId: videoReturnOperationKey(generation.id),
    event, expectedVersion: generation.statusVersion, leaseOwner: lease.owner, leaseToken: lease.token, errorCode,
    nowMs: now.getTime(), ...(attempt ? { attemptId: attempt.id, evidenceId } : {}),
    ...(providerRequestId ? { providerRequestId } : {}), composeBefore: before,
  })
  if (result.ok) {
    await retireObsoleteOutbox(deps.database, generation.id, nowOf(deps))
    return 'ack'
  }
  const current = await readGeneration(deps.database, generation.id)
  return current && stopped(current) ? 'ack' : 'retry'
}

async function settleDeadline(deps: VideoEngineDeps, generation: GenerationRow, latest: AttemptRow | null): Promise<Outcome> {
  // Defense in depth: the ledger SQL repeats this check in the atomic return batch.
  if (latest && unresolved(latest)) return moveNeedsReview(deps, generation, 'deadline_submission_unconfirmed')
  const now = nowOf(deps)
  let outbox = await readInflightOutbox(deps.database, generation.id, 'start_submission')
  if (!outbox) {
    await enqueueOutbox(deps.database, { id: 'obx_' + crypto.randomUUID(), generationId: generation.id,
      eventType: 'start_submission', attemptId: null, notBefore: now, now })
    outbox = await readInflightOutbox(deps.database, generation.id, 'start_submission')
  }
  if (!outbox) return 'retry'
  const lease = newLease(deps, nowOf(deps))
  if (!(await claimOutbox(deps.database, outbox.id, lease, nowOf(deps)))) return 'retry'
  return settleFailure(deps, generation, null, lease, 'deadline_reached', 'deadline_reached', null)
}

async function handleDeadLetter(
  deps: VideoEngineDeps, message: VideoQueueMessage, generation: GenerationRow, attempts: readonly AttemptRow[],
): Promise<Outcome> {
  const latest = attempts.at(-1) ?? null
  const named = attempts.find(row => row.id === message.attemptId)
  const decision = assessDeadLetter({
    message, status: generation.status, latestAttemptId: latest?.id ?? null,
    latestAttemptNumber: latest?.attemptNumber ?? 0, messageAttemptNumber: named?.attemptNumber ?? null,
    acceptanceStatus: latest?.acceptanceStatus ?? null, hasProviderRequestId: Boolean(latest?.providerRequestId),
  })
  if (decision.action === 'ignore') return 'ack'
  if (decision.action === 'needs_review') return moveNeedsReview(deps, generation, decision.errorCode)
  await ensureEvent(deps, generation, decision.eventType, latest?.id ?? null)
  return 'ack'
}

export async function moveNeedsReview(
  deps: VideoEngineDeps, generation: GenerationRow, errorCode: string, attempt?: AttemptRow, lease?: Lease,
): Promise<Outcome> {
  if (stopped(generation)) return 'ack'
  const now = nowOf(deps)
  const input = { generationId: generation.id, userId: generation.userId, fromStatus: generation.status,
    expectedVersion: generation.statusVersion, event: 'execution_blocked' as const, now, errorCode,
    ...(attempt && lease ? { attemptId: attempt.id, lease } : {}) }
  const result = await commitVideoBatch(deps.database, [
    generationAdvanceStatement(deps.database, input),
    completeEventStatement(deps.database, generation.id, 'start_submission', now),
    completeEventStatement(deps.database, generation.id, 'poll_status', now),
    completeEventStatement(deps.database, generation.id, 'store_output', now),
  ])
  if (result === 'ok') {
    console.info(JSON.stringify({ event: 'video_needs_review', generationId: generation.id,
      attemptId: attempt?.id, errorCode }))
    return 'ack'
  }
  const current = await readGeneration(deps.database, generation.id)
  return current && stopped(current) ? 'ack' : 'retry'
}

export async function ensureEvent(
  deps: VideoEngineDeps, generation: GenerationRow, eventType: VideoOutboxEventType, attemptId: string | null,
): Promise<void> {
  if (await readInflightOutbox(deps.database, generation.id, eventType)) return
  const last = await readLastOutbox(deps.database, generation.id, eventType)
  if (last?.deliveryStatus === 'dead') {
    if (generation.status !== 'queued') await moveNeedsReview(deps, generation, 'outbox_delivery_exhausted')
    return
  }
  const now = nowOf(deps)
  await enqueueOutbox(deps.database, { id: 'obx_' + crypto.randomUUID(), generationId: generation.id,
    eventType, attemptId, notBefore: now, now })
}

function nextEvent(deps: VideoEngineDeps, generation: GenerationRow, attempt: AttemptRow, type: VideoOutboxEventType, now: Date, delay: number) {
  return [
    completeEventStatement(deps.database, generation.id, type, now),
    outboxInsert(deps.database, { id: 'obx_' + crypto.randomUUID(), generationId: generation.id,
      eventType: type, attemptId: attempt.id, notBefore: new Date(now.getTime() + delay * 1000), now }),
  ]
}

async function reschedule(
  deps: VideoEngineDeps, generation: GenerationRow, attempt: AttemptRow, lease: Lease,
  type: 'poll_status' | 'store_output', count: number, event?: GenerationEvent,
): Promise<Outcome> {
  const now = nowOf(deps)
  const delay = Math.min(300, limits(deps).pollDelaySeconds * 2 ** Math.min(count - 1, 8))
  const result = await commitVideoBatch(deps.database, [
    generationAdvanceStatement(deps.database, { ...advanceInput(generation, attempt, lease, now),
      event: event ?? (type === 'store_output' ? 'storage_call_failed' : 'recovery_unavailable') }),
    ...nextEvent(deps, generation, attempt, type, now, delay),
    releaseAttemptStatement(deps.database, attempt.id, lease, now),
  ])
  return result === 'ok' ? 'ack' : 'retry'
}

async function reserveWork(
  deps: VideoEngineDeps, generation: GenerationRow, attempt: AttemptRow, lease: Lease,
  counter: 'pollCount' | 'recoveryCount' | 'storageCount', count: number, max: number,
): Promise<boolean> {
  const now = nowOf(deps)
  return await commitVideoBatch(deps.database, [
    checkpoint(deps, generation, attempt, lease, now),
    reserveAttemptWork(deps.database, { attemptId: attempt.id, lease, now, counter, expectedCount: count, maxCount: max }),
  ]) === 'ok'
}

async function recordCost(deps: VideoEngineDeps, attempt: AttemptRow, cost: ProviderCost, now: Date): Promise<void> {
  if ((await readCosts(deps.database, attempt.id)).some(row => row.costKind === cost.kind)) return
  const known = cost.kind === 'unknown'
    ? { costKind: 'unknown' as const, amountMicros: null, currency: null, source: 'provider' }
    : { costKind: cost.kind, amountMicros: cost.amountMicros, currency: cost.currency, source: cost.source }
  await commitVideoBatch(deps.database, [providerCostInsert(deps.database, {
    id: 'cost_' + attempt.id + '_' + known.costKind, attemptId: attempt.id, providerId: attempt.providerId, now, ...known,
  })])
}

function checkpoint(deps: VideoEngineDeps, generation: GenerationRow, attempt: AttemptRow, lease: Lease, now: Date) {
  return generationCheckpoint(deps.database, { generationId: generation.id, expectedVersion: generation.statusVersion,
    status: generation.status, attemptId: attempt.id, lease, now })
}
function advanceInput(generation: GenerationRow, attempt: AttemptRow, lease: Lease, now: Date) {
  return { generationId: generation.id, userId: generation.userId, fromStatus: generation.status,
    expectedVersion: generation.statusVersion, attemptId: attempt.id, lease, now }
}
function adapterFor(deps: VideoEngineDeps, snapshot: RouteSnapshot): ProviderAdapter | null {
  if (deps.environment === 'production') return null
  try { return deps.providers.forSnapshot(snapshot) } catch { return null }
}
function submissionFor(snapshot: RouteSnapshot, submissionKey: string, submittedAtMs: number): ProviderSubmission {
  return { snapshot, submissionKey, submittedAtMs }
}
function newLease(deps: VideoEngineDeps, now: Date): Lease {
  return { owner: deps.workerId, token: 'lease_' + crypto.randomUUID(), until: new Date(now.getTime() + limits(deps).leaseMs) }
}
function limits(deps: VideoEngineDeps): VideoLimits { return { ...DEFAULT_LIMITS, ...deps.limits } }
function nowOf(deps: VideoEngineDeps): Date {
  const ms = floorToSqliteMs(deps.clock.nowMs())
  if (ms === null) throw new Error('INVALID_VIDEO_CLOCK')
  return new Date(ms)
}
function stopped(generation: GenerationRow): boolean { return ['succeeded', 'failed', 'needs_review'].includes(generation.status) }
function unresolved(attempt: AttemptRow): boolean {
  return attempt.acceptanceStatus === 'accepted' || attempt.acceptanceStatus === 'unknown'
    || (attempt.acceptanceStatus === 'not_submitted' && (attempt.submittedAt !== null
      || metaString(attempt.recoveryMetadata, 'phase') === 'dispatch_started'))
}
export function eventFor(generation: GenerationRow): VideoOutboxEventType {
  return generation.status === 'storing' ? 'store_output'
    : generation.status === 'processing' || generation.status === 'submission_unknown' ? 'poll_status' : 'start_submission'
}
function storageExpired(deps: VideoEngineDeps, generation: GenerationRow, attempt: AttemptRow | null, now: Date): boolean {
  const started = metaNumber(attempt?.recoveryMetadata, 'storageStartedAtMs') ?? generation.updatedAt.getTime()
  return now.getTime() >= started + limits(deps).storageTimeoutMs
}
function metaNumber(value: unknown, key: string): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = (value as Record<string, unknown>)[key]
  return typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 ? item : null
}
function metaString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = (value as Record<string, unknown>)[key]
  return typeof item === 'string' ? item : null
}
function providerMetadata(value: unknown): JsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = (value as Record<string, unknown>).providerMetadata
  return item && typeof item === 'object' && !Array.isArray(item) ? item as JsonObject : null
}
