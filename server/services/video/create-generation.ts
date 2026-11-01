import { ProviderRouter, RoutingError } from '../../../packages/video-core/src/router.ts'
import { validateGenerationInput, VideoValidationError } from '../../../packages/video-core/src/validation.ts'
import type { ModelRegistry } from '../../../packages/video-core/src/model-registry.ts'
import type { ProviderRegistry } from '../../../packages/video-core/src/providers/registry.ts'
import type { GenerationInput } from '../../../packages/video-contracts/src/public.ts'
import type { Database } from '../../../packages/data/src/client.ts'
import {
  canonicalizeGenerationInput,
  hashCanonicalInput,
  parseCreditQuoteSnapshot,
  videoConsumeOperationKey,
} from '../../../packages/data/src/credits/contract.ts'
import { commitConsumePlan, prepareConsumeCharge } from '../../../packages/data/src/credits/consume.ts'
import { floorToSqliteMs, LedgerCommitUnknown } from '../../../packages/data/src/credits/runtime.ts'
import { listChargeCandidates } from '../../../packages/data/src/credits/spendable.ts'
import { dispatchOutboxRow } from '../../../packages/data/src/video/dispatch.ts'
import { generationInsert, outboxInsert } from '../../../packages/data/src/video/durable.ts'
import type { VideoQueueSender } from '../../../packages/data/src/video/protocol.ts'
import { readAsset, readGenerationByKey, readUser } from '../../../packages/data/src/video/rows.ts'

export interface CreateGenerationCommand {
  /** Trusted server identity. Callers must not copy this from a client body. */
  readonly userId: string
  readonly idempotencyKey: string
  readonly input: unknown
  /** Server price snapshot. There is no separate client credit amount. */
  readonly quote: unknown
  readonly nowMs: number
  readonly deadlineAtMs: number
}

export interface CreateGenerationDeps {
  readonly models: ModelRegistry
  readonly providers: ProviderRegistry
  readonly queue?: VideoQueueSender
  readonly workerId?: string
}

export type CreateGenerationResult =
  | {
    readonly ok: true
    readonly replay: boolean
    readonly generationId: string
    readonly status: string
    readonly canonicalInputHash: string
  }
  | { readonly ok: false, readonly reason: string }

/**
 * Create one queued generation, consume credits, and write the first outbox row
 * in the same database batch. Queue delivery happens after that commit.
 * This function has no HTTP route.
 */
export async function createGeneration(
  database: Database,
  command: CreateGenerationCommand,
  deps: CreateGenerationDeps,
): Promise<CreateGenerationResult> {
  if (command.userId.trim() === '') return { ok: false, reason: 'user_not_found' }
  if (command.idempotencyKey.trim() === '' || command.idempotencyKey.length > 200) {
    return { ok: false, reason: 'invalid_input' }
  }
  // Replay depends on the original business input, never today's catalog,
  // price, asset availability, or a deadline supplied for another creation.
  let canonical: GenerationInput
  try {
    canonical = validateGenerationInput(command.input)
  }
  catch (error) {
    if (error instanceof VideoValidationError) return { ok: false, reason: 'invalid_input' }
    throw error
  }
  const canonicalHash = hashCanonicalInput(canonical)
  const existing = await readGenerationByKey(database, command.userId, command.idempotencyKey)
  if (existing) return sameOrConflict(existing.canonicalInputHash, canonicalHash, existing.id, existing.status)
  const nowMs = floorToSqliteMs(command.nowMs)
  const deadlineMs = floorToSqliteMs(command.deadlineAtMs)
  if (nowMs === null || deadlineMs === null || deadlineMs <= nowMs) return { ok: false, reason: 'invalid_deadline' }
  const quote = parseCreditQuoteSnapshot(command.quote)
  if (!quote) return { ok: false, reason: 'invalid_quote' }
  let snapshot
  try {
    snapshot = new ProviderRouter(deps.models, deps.providers).select(command.input)
  }
  catch (error) {
    if (error instanceof VideoValidationError) return { ok: false, reason: 'invalid_input' }
    if (error instanceof RoutingError) return { ok: false, reason: error.code }
    throw error
  }
  if (canonicalizeGenerationInput(canonical).length === 0) return { ok: false, reason: 'invalid_input' }

  const user = await readUser(database, command.userId)
  if (!user) return { ok: false, reason: 'user_not_found' }
  const assetError = await rejectAssets(database, command.userId, canonical)
  if (assetError) return assetError

  const now = new Date(nowMs)
  const generationId = `gen_${crypto.randomUUID()}`
  const outboxId = `obx_${crypto.randomUUID()}`
  const grants = await listChargeCandidates(database, command.userId, now)
  const prepared = prepareConsumeCharge({
    userId: command.userId,
    generationId,
    operationId: videoConsumeOperationKey(generationId),
    creditAmount: quote.creditAmount,
    nowMs,
    generation: {
      userId: command.userId,
      status: 'queued',
      statusVersion: 1,
      quotedCredits: quote.creditAmount,
      quote,
    },
    grants,
  })
  if (!prepared.ok) return { ok: false, reason: prepared.reason }

  const row = {
    id: generationId,
    userId: command.userId,
    idempotencyKey: command.idempotencyKey,
    canonicalInput: canonical,
    canonicalHash,
    route: snapshot,
    quote,
    deadlineAt: new Date(deadlineMs),
    now,
  }
  try {
    const committed = await commitConsumePlan(database, prepared.plan, {
      composeBefore: [generationInsert(database, row)],
      composeAfter: [outboxInsert(database, {
        id: outboxId,
        generationId,
        eventType: 'start_submission',
        attemptId: null,
        notBefore: now,
        now,
      })],
    })
    if (!committed.ok) {
      const raced = await readGenerationByKey(database, command.userId, command.idempotencyKey)
      if (raced) return sameOrConflict(raced.canonicalInputHash, canonicalHash, raced.id, raced.status)
      return { ok: false, reason: committed.reason }
    }
  }
  catch (error) {
    if (error instanceof LedgerCommitUnknown) {
      const raced = await readGenerationByKey(database, command.userId, command.idempotencyKey)
      if (raced) return sameOrConflict(raced.canonicalInputHash, canonicalHash, raced.id, raced.status)
      return { ok: false, reason: 'commit_unknown' }
    }
    throw error
  }

  if (deps.queue) {
    try {
      await dispatchOutboxRow({
        database,
        queue: deps.queue,
        workerId: deps.workerId ?? 'create-generation',
        nowMs,
      }, outboxId, now)
    }
    catch {
      // The outbox row remains the delivery source of truth.
    }
  }
  return { ok: true, replay: false, generationId, status: 'queued', canonicalInputHash: canonicalHash }
}

function sameOrConflict(savedHash: string, hash: string, generationId: string, status: string): CreateGenerationResult {
  if (savedHash !== hash) return { ok: false, reason: 'idempotency_conflict' }
  return { ok: true, replay: true, generationId, status, canonicalInputHash: hash }
}

async function rejectAssets(
  database: Database,
  userId: string,
  input: GenerationInput,
): Promise<CreateGenerationResult | null> {
  if (input.mode === 'text-to-video') return null
  const image = await readAsset(database, input.imageAssetId)
  const imageError = assetProblem(image, userId, 'image')
  if (imageError) return imageError
  if (input.mode === 'reference-to-video') {
    const video = await readAsset(database, input.referenceVideoAssetId)
    return assetProblem(video, userId, 'reference_video')
  }
  return null
}

function assetProblem(
  asset: { readonly userId: string, readonly kind: string, readonly status: string } | null,
  userId: string,
  kind: 'image' | 'reference_video',
): CreateGenerationResult | null {
  if (!asset || asset.userId !== userId) return { ok: false, reason: 'asset_not_owned' }
  if (asset.kind !== kind || asset.status !== 'available') return { ok: false, reason: 'asset_not_available' }
  return null
}
