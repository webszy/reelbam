import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '../src/client.ts'
import type { Database } from '../src/client.ts'
import {
  billingOrders,
  billingPrices,
  billingProducts,
  entitlementGrants,
  entitlementTransactions,
  users,
} from '../src/schema/billing.ts'
import {
  videoAttempts,
  videoAssets,
  videoCreditOperations,
  videoGenerations,
  videoOutbox,
} from '../src/schema/video.ts'
import type { CreditQuoteSnapshot } from '../src/credits/contract.ts'
import {
  canonicalizeGenerationInput,
  hashCanonicalInput,
} from '../src/credits/contract.ts'
import type { GenerationInput } from '@reelbam/video-contracts'
import type { RouteSnapshot } from '@reelbam/video-contracts/internal'

const MIGRATIONS = [
  '0000_fast_magdalene.sql',
  '0001_video_business.sql',
  '0002_provider_cost_check.sql',
  '0003_ledger_integrity.sql',
] as const

const drizzleDir = fileURLToPath(new URL('../../../drizzle', import.meta.url))

export interface LedgerHandle {
  readonly path: string
  readonly sqlite: DatabaseSync
  readonly database: Database
  close(): void
}

export function openLedgerDatabase(path: string, migrate = true): LedgerHandle {
  const sqlite = new DatabaseSync(path)
  sqlite.exec('PRAGMA journal_mode = WAL')
  sqlite.exec('PRAGMA busy_timeout = 5000')
  if (migrate) {
    sqlite.exec('PRAGMA foreign_keys = OFF')
    for (const file of MIGRATIONS) {
      const sqlText = readFileSync(join(drizzleDir, file), 'utf8')
      for (const statement of sqlText.split('--> statement-breakpoint')) {
        const trimmed = statement.trim()
        if (trimmed.length > 0) sqlite.exec(trimmed)
      }
    }
  }
  sqlite.exec('PRAGMA foreign_keys = ON')
  const database = wrapSqlite(sqlite)
  return {
    path,
    sqlite,
    database,
    close() {
      sqlite.close()
    },
  }
}

export function openExistingLedgerDatabase(path: string): LedgerHandle {
  return openLedgerDatabase(path, false)
}

/** Exercise the production Drizzle D1 driver against SQLite constraints and transactional batches.
 * This is a local D1-shaped binding, not proof of Cloudflare's deployed runtime.
 */
function wrapSqlite(sqlite: DatabaseSync): Database {
  class Statement {
    constructor(readonly query: string, readonly params: SQLInputValue[] = []) {}
    bind(...params: unknown[]) { return new Statement(this.query, bindParams(params)) }
    execute() {
      const stmt = sqlite.prepare(this.query)
      const rows = stmt.all(...this.params) as Record<string, unknown>[]
      const change = sqlite.prepare('select changes() as n').get() as { n: number }
      return { success: true, results: rows, meta: { changes: Number(change.n) } }
    }
    async all() { return this.execute() }
    async run() { return this.execute() }
    async raw() {
      const stmt = sqlite.prepare(this.query)
      const rows = stmt.all(...this.params) as Record<string, unknown>[]
      return rows.map(row => stmt.columns().map(column => row[column.name]))
    }
  }
  const binding = {
    prepare(query: string) { return new Statement(query) },
    async batch(queries: Statement[]) {
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        const results = queries.map(query => query.execute())
        sqlite.exec('COMMIT')
        return results
      }
      catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  }
  return createDatabase(binding as unknown as Parameters<typeof createDatabase>[0])
}

function bindParams(params: unknown[]): SQLInputValue[] {
  return params.map((value) => {
    if (value instanceof Date) return Math.floor(value.getTime() / 1000)
    if (typeof value === 'boolean') return value ? 1 : 0
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
      || value instanceof Uint8Array) return value
    throw new Error('UNSUPPORTED_SQLITE_BINDING')
  })
}

export function creditQuote(amount: number): CreditQuoteSnapshot {
  return {
    schemaVersion: 1,
    creditAmount: amount,
    pricingRuleId: 'rule-test',
    pricingRuleRevision: 1,
    unit: 'credit',
  }
}

export function textToVideoInput(): GenerationInput {
  return {
    modelId: 'model-1',
    mode: 'text-to-video',
    prompt: 'a reel',
    parameters: {
      durationSeconds: 5,
      resolution: '720p',
    },
  }
}

export function routeSnapshot(input: GenerationInput): RouteSnapshot {
  return {
    schemaVersion: 1,
    routeId: 'route-1',
    revision: 1,
    model: { id: input.modelId, revision: 1 },
    providerId: 'mock',
    providerModelId: 'mock-1',
    adapterVersion: '1',
    capability: {
      id: 'cap-text',
      mode: 'text-to-video',
      prompt: 'required',
      durationSeconds: [5],
      resolutions: ['720p'],
      optionalParameters: {},
    },
    input,
  }
}

export async function insertUser(database: Database, id: string, now: Date): Promise<void> {
  await database.insert(users).values({
    id,
    clerkUserId: `clerk-${id}`,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  })
}

export async function insertCatalog(database: Database, now: Date): Promise<{ productId: string, priceId: string }> {
  const productId = 'prod-credits'
  const priceId = 'price-credits'
  await database.insert(billingProducts).values({
    id: productId,
    code: 'credit_pack_test',
    name: 'Credits',
    productKind: 'credit_pack',
    active: true,
    createdAt: now,
    updatedAt: now,
  })
  await database.insert(billingPrices).values({
    id: priceId,
    productId,
    code: 'credit_pack_test_usd',
    billingType: 'one_time',
    amount: 1000,
    currency: 'USD',
    provider: 'creem',
    active: true,
    createdAt: now,
    updatedAt: now,
  })
  return { productId, priceId }
}

export async function insertPaidOrder(database: Database, input: {
  readonly id: string
  readonly userId: string
  readonly productId: string
  readonly priceId: string
  readonly amount: number
  readonly grantedQuantity: number
  readonly providerOrderId: string
  readonly now: Date
}): Promise<void> {
  await database.insert(billingOrders).values({
    id: input.id,
    userId: input.userId,
    productId: input.productId,
    priceId: input.priceId,
    status: 'paid',
    amount: input.amount,
    currency: 'USD',
    providerPaidAmount: input.amount,
    refundVersion: 0,
    productNameSnapshot: 'Credits',
    priceCodeSnapshot: 'credit_pack_test_usd',
    entitlementSnapshot: [{
      entitlement_key: 'credits',
      entitlement_type: 'consumable',
      quantity: input.grantedQuantity,
      grant_cadence: 'purchase',
      expiration_policy: 'fixed_duration',
      duration_days: 365,
    }],
    provider: 'creem',
    providerCheckoutId: `ch_${input.providerOrderId}`,
    providerOrderId: input.providerOrderId,
    createdAt: input.now,
    updatedAt: input.now,
    paidAt: input.now,
  })
}

export async function insertGrant(database: Database, input: {
  readonly id: string
  readonly userId: string
  readonly sourceType: 'order' | 'promotion' | 'admin' | 'migration' | 'subscription_cycle'
  readonly sourceId: string
  readonly granted: number
  readonly remaining: number
  readonly now: Date
  readonly expiresAt?: Date | null
  readonly createdAt?: Date
  readonly status?: 'active' | 'expired' | 'revoked'
  readonly periodKey?: string
}): Promise<void> {
  const createdAt = input.createdAt ?? input.now
  await database.insert(entitlementGrants).values({
    id: input.id,
    userId: input.userId,
    entitlementKey: 'credits',
    entitlementType: 'consumable',
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    periodKey: input.periodKey ?? 'purchase',
    grantedQuantity: input.granted,
    remainingQuantity: input.remaining,
    effectiveAt: createdAt,
    ...(input.expiresAt === undefined ? { expiresAt: new Date(input.now.getTime() + 365 * 24 * 60 * 60 * 1000) } : { expiresAt: input.expiresAt }),
    status: input.status ?? 'active',
    createdAt,
    updatedAt: input.now,
  })
}

export async function insertGrantTransaction(database: Database, input: {
  readonly id: string
  readonly userId: string
  readonly grantId: string
  readonly quantity: number
  readonly sourceType: string
  readonly sourceId: string
  readonly idempotencyKey: string
  readonly now: Date
}): Promise<void> {
  await database.insert(entitlementTransactions).values({
    id: input.id,
    userId: input.userId,
    grantId: input.grantId,
    transactionType: 'grant',
    quantity: input.quantity,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    balanceBefore: 0,
    balanceAfter: input.quantity,
    idempotencyKey: input.idempotencyKey,
    createdAt: input.now,
  })
}

export function queuedGenerationInsert(database: Database, input: {
  readonly id: string
  readonly userId: string
  readonly credits: number
  readonly now: Date
  readonly deadlineAt?: Date
  readonly idempotencyKey?: string
}) {
  const generationInput = textToVideoInput()
  const quote = creditQuote(input.credits)
  return database.insert(videoGenerations).values({
    id: input.id,
    userId: input.userId,
    idempotencyKey: input.idempotencyKey ?? `idem-${input.id}`,
    canonicalInputHash: hashCanonicalInput(generationInput),
    canonicalInput: JSON.parse(canonicalizeGenerationInput(generationInput)) as Record<string, unknown>,
    routeSnapshotVersion: 1,
    routeSnapshot: routeSnapshot(generationInput),
    quotedCredits: input.credits,
    quoteSnapshot: quote,
    mode: 'text-to-video',
    status: 'queued',
    statusVersion: 1,
    deadlineAt: input.deadlineAt ?? input.now,
    createdAt: input.now,
    updatedAt: input.now,
  })
}

export async function insertQueuedGeneration(database: Database, input: Parameters<typeof queuedGenerationInsert>[1]): Promise<void> {
  await queuedGenerationInsert(database, input)
}

export async function insertLeasedOutbox(database: Database, input: {
  readonly id: string
  readonly generationId: string
  readonly eventType: 'start_submission' | 'store_output'
  readonly now: Date
  readonly leaseOwner?: string
  readonly leaseToken?: string
}): Promise<void> {
  await database.insert(videoOutbox).values({
    id: input.id,
    generationId: input.generationId,
    eventType: input.eventType,
    payloadVersion: 1,
    payload: { kind: input.eventType },
    notBefore: input.now,
    deliveryStatus: 'leased',
    leaseOwner: input.leaseOwner ?? 'worker-1',
    leaseToken: input.leaseToken ?? 'token-1',
    leaseUntil: new Date(input.now.getTime() + 60_000),
    deliveryAttemptCount: 1,
    createdAt: input.now,
    updatedAt: input.now,
  })
}

export async function insertAttempt(database: Database, input: {
  readonly id: string
  readonly generationId: string
  readonly now: Date
  readonly leaseOwner?: string
  readonly leaseToken?: string
}): Promise<void> {
  await database.insert(videoAttempts).values({
    id: input.id,
    generationId: input.generationId,
    stepId: 'submit',
    attemptNumber: 1,
    submitKey: `submit-${input.id}`,
    providerId: 'mock',
    acceptanceStatus: 'accepted',
    providerRequestId: `req-${input.id}`,
    leaseOwner: input.leaseOwner ?? 'worker-1',
    leaseToken: input.leaseToken ?? 'token-1',
    leaseUntil: new Date(input.now.getTime() + 60_000),
    createdAt: input.now,
    updatedAt: input.now,
  })
}

export async function insertOutputAsset(database: Database, input: {
  readonly id: string
  readonly userId: string
  readonly now: Date
}): Promise<void> {
  await database.insert(videoAssets).values({
    id: input.id,
    userId: input.userId,
    kind: 'output_video',
    objectKey: `out/${input.id}.mp4`,
    contentType: 'video/mp4',
    byteSize: 1,
    contentHash: 'a'.repeat(64),
    hashAlgorithm: 'sha256',
    status: 'available',
    createdAt: input.now,
  })
}

export {
  billingOrders,
  entitlementGrants,
  entitlementTransactions,
  users,
  videoAttempts,
  videoAssets,
  videoCreditOperations,
  videoGenerations,
  videoOutbox,
}
export { billingRefundCreditSettlements } from '../src/schema/video.ts'
