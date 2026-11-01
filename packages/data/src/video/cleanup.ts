import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import { videoAttempts, videoGenerations } from '../schema/video.ts'
import { readAssetByKey } from './rows.ts'
import type { VideoEngineDeps } from './engine.ts'

const RETENTION_MS = 24 * 60 * 60_000

/** Only terminal generations are eligible: this engine never reopens them.
 * Pending/needs_review output is retained for recovery and human inspection. */
export async function cleanupTerminalObjects(deps: VideoEngineDeps, now: Date): Promise<void> {
  if (!deps.store.list) return
  const cutoff = new Date(now.getTime() - RETENTION_MS)
  const rows = await deps.database.select({ attempt: videoAttempts }).from(videoAttempts)
    .innerJoin(videoGenerations, eq(videoAttempts.generationId, videoGenerations.id))
    .where(and(inArray(videoGenerations.status, ['succeeded', 'failed']), lte(videoGenerations.terminalAt, cutoff)))
    .orderBy(asc(sql`coalesce(json_extract(${videoAttempts.recoveryMetadata}, '$.cleanupCheckedAtMs'), 0)`), asc(videoAttempts.id))
    .limit(deps.limits?.maintenanceLimit ?? 20)
  for (const { attempt } of rows) {
    const cursor = attempt.recoveryMetadata?.cleanupCursor
    const prefix = `private/${deps.environment}/generations/${attempt.generationId}/attempts/${attempt.id}/`
    const page = await deps.store.list(prefix, 100, typeof cursor === 'string' ? cursor : undefined)
    for (const object of page.objects) {
      if (!object.key.startsWith(prefix) || object.uploadedAtMs > cutoff.getTime()) continue
      if (!(await readAssetByKey(deps.database, object.key))) await deps.store.delete(object.key)
    }
    // Keep a durable cursor, and merge rather than replacing provider metadata.
    await deps.database.update(videoAttempts).set({
      recoveryMetadata: sql`json_set(coalesce(${videoAttempts.recoveryMetadata}, '{}'),
        '$.cleanupCursor', ${page.cursor ?? null}, '$.cleanupCheckedAtMs', ${now.getTime()})`,
    }).where(eq(videoAttempts.id, attempt.id))
  }
}
