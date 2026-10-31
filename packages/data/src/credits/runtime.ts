import type { Database } from '../client.ts'

/** D1 integer timestamps are whole seconds. Sub-second input is truncated before any compare or write. */
export function floorToSqliteMs(nowMs: number): number | null {
  if (!Number.isInteger(nowMs)) return null
  return Math.floor(nowMs / 1000) * 1000
}

export function sqliteSeconds(nowMs: number): number {
  return Math.floor(nowMs / 1000)
}

/**
 * The batch threw and a re-read did not find a completed operation.
 * Callers must look the operation up again. They must not assume the write is absent
 * and must not run a second charge with a new operation id.
 */
export class LedgerCommitUnknown extends Error {
  readonly operationId: string

  constructor(operationId: string, cause: unknown) {
    super(`LEDGER_COMMIT_UNKNOWN:${operationId}`, { cause })
    this.name = 'LedgerCommitUnknown'
    this.operationId = operationId
  }
}

export type LedgerErrorClass = 'check' | 'unique' | 'unknown'

export function classifyLedgerError(error: unknown): LedgerErrorClass {
  const message = collectErrorText(error).toLowerCase()
  if (message.includes('unique constraint') || message.includes('sqlite_constraint_unique')) {
    return 'unique'
  }
  if (
    message.includes('check constraint')
    || message.includes('sqlite_constraint_check')
    || message.includes('foreign key constraint')
    || message.includes('not null constraint')
    || message.includes('settlement_grant_mismatch')
    || message.includes('settlement_exceeds_shortfall')
    || message.includes('settlement_operation_mismatch')
    || message.includes('settlement_clawback_mismatch')
    || message.includes('credit_grant_quantity_invalid')
    || message.includes('ledger_sequence_invalid')
    || message.includes('ledger_initial_grant_invalid')
    || message.includes('ledger_chain_invalid')
    || message.includes('attempt_settlement_evidence_invalid')
  ) {
    return 'check'
  }
  return 'unknown'
}

/** The batch failed a constraint. The write rolled back. Callers re-read and re-plan. */
export class LedgerAbort extends Error {
  readonly failure = 'abort_batch' as const

  constructor() {
    super('LEDGER_ABORT_BATCH')
    this.name = 'LedgerAbort'
  }
}

/**
 * Stable ledger row id. The idempotency key stays the contract key.
 * `sequence` distinguishes instructions in this operation. It is not chronological;
 * database-assigned ledger_sequence defines the persistent per-grant write order.
 */
export function videoLedgerRowId(sequence: number, idempotencyKey: string): string {
  return `etv:${String(sequence).padStart(2, '0')}:${idempotencyKey}`
}

/**
 * Run one batch. On a constraint failure, re-read once: a concurrent winner is returned,
 * otherwise the caller gets `LedgerAbort`. Any other error is `LedgerCommitUnknown`
 * unless that same re-read already shows the operation committed.
 */
export async function finishLedgerCommit<T>(
  database: Database,
  operationId: string,
  statements: readonly unknown[],
  readOutcome: (source: 'committed' | 'reread') => Promise<T | null>,
): Promise<T> {
  try {
    await commitLedgerBatch(database, statements)
  }
  catch (error) {
    let outcome: T | null
    try {
      outcome = await readOutcome('reread')
    }
    catch (readError) {
      throw new LedgerCommitUnknown(operationId, readError)
    }
    if (outcome) return outcome
    if (classifyLedgerError(error) === 'check') throw new LedgerAbort()
    throw new LedgerCommitUnknown(operationId, error)
  }
  let outcome: T | null
  try {
    outcome = await readOutcome('committed')
  }
  catch (error) {
    throw new LedgerCommitUnknown(operationId, error)
  }
  if (!outcome) {
    throw new LedgerCommitUnknown(operationId, new Error('LEDGER_OPERATION_ABSENT_AFTER_COMMIT'))
  }
  return outcome
}

function collectErrorText(error: unknown, depth = 0): string {
  if (!error || depth > 6) return ''
  if (error instanceof Error) {
    return `${error.message} ${collectErrorText(error.cause, depth + 1)}`
  }
  if (typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return ''
}

/** One D1 batch. A statement error rolls the whole batch back, including earlier writes in the list. */
export async function commitLedgerBatch(database: Database, queries: readonly unknown[]): Promise<void> {
  if (queries.length === 0) {
    throw new Error('EMPTY_LEDGER_BATCH')
  }
  await database.batch(queries as unknown as Parameters<Database['batch']>[0])
}
