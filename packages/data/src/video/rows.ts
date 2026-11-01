import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type { VideoOutboxEventType } from './protocol.ts'
import type { Database } from '../client.ts'
import { users } from '../schema/billing.ts'
import { videoAssets, videoAttempts, videoGenerations, videoOutbox, videoProviderCosts } from '../schema/video.ts'
import { sqliteSeconds } from '../credits/runtime.ts'

export async function readUser(database: Database, userId: string) {
  const rows = await database.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1)
  return rows[0] ?? null
}

export async function readGeneration(database: Database, generationId: string) {
  const rows = await database.select().from(videoGenerations).where(eq(videoGenerations.id, generationId)).limit(1)
  return rows[0] ?? null
}

export async function readGenerationByKey(database: Database, userId: string, idempotencyKey: string) {
  const rows = await database.select().from(videoGenerations).where(and(
    eq(videoGenerations.userId, userId),
    eq(videoGenerations.idempotencyKey, idempotencyKey),
  )).limit(1)
  return rows[0] ?? null
}

export async function readAsset(database: Database, assetId: string) {
  const rows = await database.select().from(videoAssets).where(eq(videoAssets.id, assetId)).limit(1)
  return rows[0] ?? null
}

export async function readAssetByKey(database: Database, objectKey: string) {
  const rows = await database.select().from(videoAssets).where(eq(videoAssets.objectKey, objectKey)).limit(1)
  return rows[0] ?? null
}

export async function readAttempts(database: Database, generationId: string) {
  return database.select().from(videoAttempts).where(eq(videoAttempts.generationId, generationId))
    .orderBy(asc(videoAttempts.attemptNumber))
}

export async function readOutbox(database: Database, outboxId: string) {
  const rows = await database.select().from(videoOutbox).where(eq(videoOutbox.id, outboxId)).limit(1)
  return rows[0] ?? null
}

export async function readLastOutbox(database: Database, generationId: string, eventType: VideoOutboxEventType) {
  const rows = await database.select().from(videoOutbox).where(and(
    eq(videoOutbox.generationId, generationId), eq(videoOutbox.eventType, eventType),
  )).orderBy(desc(sql`rowid`)).limit(1)
  return rows[0] ?? null
}

export async function readInflightOutbox(database: Database, generationId: string, eventType: 'start_submission' | 'poll_status' | 'store_output') {
  const rows = await database.select().from(videoOutbox).where(and(
    eq(videoOutbox.generationId, generationId),
    eq(videoOutbox.eventType, eventType),
    inArray(videoOutbox.deliveryStatus, ['pending', 'leased']),
  )).limit(1)
  return rows[0] ?? null
}

export async function readDueOutbox(database: Database, now: Date, limit: number) {
  return database.select().from(videoOutbox).where(and(
    eq(videoOutbox.deliveryStatus, 'pending'),
    lte(videoOutbox.notBefore, now),
    or(isNull(videoOutbox.nextRetryAt), lte(videoOutbox.nextRetryAt, now)),
  )).orderBy(asc(videoOutbox.updatedAt), asc(videoOutbox.id)).limit(limit)
}

export async function readExpiredOutboxLeases(database: Database, now: Date, limit: number) {
  return database.select({ id: videoOutbox.id }).from(videoOutbox).where(and(
    eq(videoOutbox.deliveryStatus, 'leased'),
    lte(videoOutbox.leaseUntil, now),
  )).limit(limit)
}

export async function readActiveGenerations(database: Database, limit: number) {
  return database.select().from(videoGenerations).where(inArray(videoGenerations.status, [
    'queued', 'submitting', 'submission_unknown', 'processing', 'storing',
  ])).orderBy(asc(videoGenerations.updatedAt), asc(videoGenerations.id)).limit(limit)
}

export async function readCosts(database: Database, attemptId: string) {
  return database.select().from(videoProviderCosts).where(eq(videoProviderCosts.attemptId, attemptId))
}

export function secondsOf(now: Date): number {
  return sqliteSeconds(now.getTime())
}
