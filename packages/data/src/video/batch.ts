import type { Database } from '../client.ts'
import { classifyLedgerError, commitLedgerBatch } from '../credits/runtime.ts'

export type VideoBatchResult = 'ok' | 'conflict'

/** One D1 batch. A CHECK or UNIQUE failure rolls every statement in the list back. */
export async function commitVideoBatch(database: Database, statements: readonly unknown[]): Promise<VideoBatchResult> {
  if (statements.length === 0) return 'ok'
  try {
    await commitLedgerBatch(database, statements)
    return 'ok'
  }
  catch (error) {
    const kind = classifyLedgerError(error)
    if (kind === 'check' || kind === 'unique') return 'conflict'
    throw error
  }
}
