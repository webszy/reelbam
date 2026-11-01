import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import type { InternalGenerationStatus, JsonObject, RouteSnapshot } from '@reelbam/video-contracts/internal'
import type { CreditQuoteSnapshot } from '../credits/contract.ts'
import {
  billingRefundCreditAdjustments,
  entitlementGrants,
  users,
} from './billing.ts'

export const videoGenerationStatuses = [
  'queued',
  'submitting',
  'submission_unknown',
  'processing',
  'storing',
  'succeeded',
  'failed',
  'needs_review',
] as const

type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : never

const _generationStatusMatchesContract: AssertEqual<
  (typeof videoGenerationStatuses)[number],
  InternalGenerationStatus
> = true
void _generationStatusMatchesContract

export const videoAssetKinds = [
  'image',
  'reference_video',
  'output_video',
  'mock_fixture',
] as const

export const videoAssetStatuses = [
  'pending',
  'available',
  'expired',
  'deleted',
] as const

export const videoAttemptAcceptanceStatuses = [
  'not_submitted',
  'accepted',
  'rejected',
  'unknown',
] as const

export const videoOutboxEventTypes = [
  'start_submission',
  'poll_status',
  'store_output',
] as const

export const videoOutboxDeliveryStatuses = [
  'pending',
  'leased',
  'delivered',
  'dead',
] as const

export const videoCreditOperationTypes = [
  'consume',
  'return',
] as const

export const videoProviderCostKinds = [
  'estimated',
  'actual',
  'unknown',
] as const

export const videoAssets = sqliteTable(
  'video_assets',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    kind: text('kind', { enum: videoAssetKinds }).notNull(),
    objectKey: text('object_key').notNull(),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    contentHash: text('content_hash').notNull(),
    hashAlgorithm: text('hash_algorithm').notNull(),
    status: text('status', { enum: videoAssetStatuses }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
  },
  table => [
    uniqueIndex('video_assets_object_key_unique').on(table.objectKey),
    // Composite target so a generation can reference an asset only with the same owner.
    uniqueIndex('video_assets_id_user_id_unique').on(table.id, table.userId),
    index('video_assets_user_created_idx').on(table.userId, table.createdAt),
    index('video_assets_user_status_idx').on(table.userId, table.status),
    check(
      'video_assets_kind_check',
      sql`${table.kind} in ('image', 'reference_video', 'output_video', 'mock_fixture')`,
    ),
    check(
      'video_assets_status_check',
      sql`${table.status} in ('pending', 'available', 'expired', 'deleted')`,
    ),
    check('video_assets_byte_size_check', sql`${table.byteSize} >= 0`),
    check('video_assets_hash_algorithm_check', sql`${table.hashAlgorithm} in ('sha256')`),
    check('video_assets_content_hash_check', sql`length(${table.contentHash}) = 64`),
    check('video_assets_object_key_check', sql`length(${table.objectKey}) > 0`),
    check('video_assets_content_type_check', sql`length(${table.contentType}) > 0`),
  ],
)

export const videoGenerations = sqliteTable(
  'video_generations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    idempotencyKey: text('idempotency_key').notNull(),
    canonicalInputHash: text('canonical_input_hash').notNull(),
    canonicalInput: text('canonical_input', { mode: 'json' }).notNull(),
    routeSnapshotVersion: integer('route_snapshot_version').notNull(),
    routeSnapshot: text('route_snapshot', { mode: 'json' }).$type<RouteSnapshot>().notNull(),
    quotedCredits: integer('quoted_credits').notNull(),
    quoteSnapshot: text('quote_snapshot', { mode: 'json' }).$type<CreditQuoteSnapshot>().notNull(),
    mode: text('mode').notNull(),
    imageAssetId: text('image_asset_id'),
    referenceVideoAssetId: text('reference_video_asset_id'),
    status: text('status', { enum: videoGenerationStatuses }).notNull(),
    statusVersion: integer('status_version').notNull(),
    deadlineAt: integer('deadline_at', { mode: 'timestamp' }).notNull(),
    outputAssetId: text('output_asset_id'),
    errorCode: text('error_code'),
    errorAt: integer('error_at', { mode: 'timestamp' }),
    terminalAt: integer('terminal_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  table => [
    uniqueIndex('video_generations_user_idempotency_key_unique')
      .on(table.userId, table.idempotencyKey),
    index('video_generations_user_created_idx').on(table.userId, table.createdAt),
    index('video_generations_status_deadline_idx').on(table.status, table.deadlineAt),
    foreignKey({
      columns: [table.imageAssetId, table.userId],
      foreignColumns: [videoAssets.id, videoAssets.userId],
      name: 'video_generations_image_owner_fk',
    }).onDelete('restrict').onUpdate('cascade'),
    foreignKey({
      columns: [table.referenceVideoAssetId, table.userId],
      foreignColumns: [videoAssets.id, videoAssets.userId],
      name: 'video_generations_reference_owner_fk',
    }).onDelete('restrict').onUpdate('cascade'),
    foreignKey({
      columns: [table.outputAssetId, table.userId],
      foreignColumns: [videoAssets.id, videoAssets.userId],
      name: 'video_generations_output_owner_fk',
    }).onDelete('restrict').onUpdate('cascade'),
    check(
      'video_generations_status_check',
      sql`${table.status} in ('queued', 'submitting', 'submission_unknown', 'processing', 'storing', 'succeeded', 'failed', 'needs_review')`,
    ),
    check(
      'video_generations_mode_check',
      sql`${table.mode} in ('text-to-video', 'image-to-video', 'reference-to-video')`,
    ),
    check(
      'video_generations_mode_assets_check',
      sql`(
        (${table.mode} = 'text-to-video' and ${table.imageAssetId} is null and ${table.referenceVideoAssetId} is null)
        or (${table.mode} = 'image-to-video' and ${table.imageAssetId} is not null and ${table.referenceVideoAssetId} is null)
        or (${table.mode} = 'reference-to-video' and ${table.imageAssetId} is not null and ${table.referenceVideoAssetId} is not null)
      )`,
    ),
    check('video_generations_idempotency_key_check', sql`length(${table.idempotencyKey}) > 0`),
    check('video_generations_input_hash_check', sql`length(${table.canonicalInputHash}) = 64`),
    check('video_generations_route_version_check', sql`${table.routeSnapshotVersion} >= 1`),
    check('video_generations_quoted_credits_check', sql`${table.quotedCredits} >= 0`),
    check('video_generations_status_version_check', sql`${table.statusVersion} >= 1`),
    check(
      'video_generations_terminal_check',
      sql`(
        (${table.status} in ('succeeded', 'failed') and ${table.terminalAt} is not null)
        or (${table.status} not in ('succeeded', 'failed') and ${table.terminalAt} is null)
      )`,
    ),
    check(
      'video_generations_error_check',
      sql`(
        (${table.status} in ('failed', 'needs_review') and ${table.errorCode} is not null and ${table.errorAt} is not null)
        or (${table.status} not in ('failed', 'needs_review') and ${table.errorCode} is null and ${table.errorAt} is null)
      )`,
    ),
    check(
      'video_generations_output_check',
      sql`${table.status} != 'succeeded' or ${table.outputAssetId} is not null`,
    ),
  ],
)

export const videoAttempts = sqliteTable(
  'video_attempts',
  {
    id: text('id').primaryKey(),
    generationId: text('generation_id')
      .notNull()
      .references(() => videoGenerations.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    stepId: text('step_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    submitKey: text('submit_key').notNull(),
    providerId: text('provider_id').notNull(),
    providerRequestId: text('provider_request_id'),
    requestPayloadHash: text('request_payload_hash'),
    acceptanceStatus: text('acceptance_status', {
      enum: videoAttemptAcceptanceStatuses,
    }).notNull(),
    leaseOwner: text('lease_owner'),
    leaseToken: text('lease_token'),
    leaseUntil: integer('lease_until', { mode: 'timestamp' }),
    recoveryMetadata: text('recovery_metadata', { mode: 'json' }).$type<JsonObject>(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
    submittedAt: integer('submitted_at', { mode: 'timestamp' }),
    resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
    // Recorded failure observation; checked again with the lease in the return batch.
    settlementEvent: text('settlement_event'),
    settlementEvidenceId: text('settlement_evidence_id'),
  },
  table => [
    uniqueIndex('video_attempts_generation_step_attempt_unique')
      .on(table.generationId, table.stepId, table.attemptNumber),
    uniqueIndex('video_attempts_submit_key_unique').on(table.submitKey),
    uniqueIndex('video_attempts_provider_request_unique')
      .on(table.providerId, table.providerRequestId)
      .where(sql`${table.providerRequestId} is not null`),
    // A repeated queue message must attach to this row. A new attempt exists only after rejection.
    uniqueIndex('video_attempts_one_open_step_unique')
      .on(table.generationId, table.stepId)
      .where(sql`${table.acceptanceStatus} in ('not_submitted', 'unknown', 'accepted')`),
    index('video_attempts_generation_acceptance_idx')
      .on(table.generationId, table.acceptanceStatus),
    index('video_attempts_lease_until_idx').on(table.leaseUntil),
    check('video_attempts_attempt_number_check', sql`${table.attemptNumber} >= 1`),
    check('video_attempts_step_id_check', sql`length(${table.stepId}) > 0`),
    check('video_attempts_submit_key_check', sql`length(${table.submitKey}) > 0`),
    check('video_attempts_provider_id_check', sql`length(${table.providerId}) > 0`),
    check(
      'video_attempts_acceptance_check',
      sql`${table.acceptanceStatus} in ('not_submitted', 'accepted', 'rejected', 'unknown')`,
    ),
    check(
      'video_attempts_request_id_check',
      sql`(
        (${table.acceptanceStatus} = 'accepted' and ${table.providerRequestId} is not null)
        or (${table.acceptanceStatus} in ('not_submitted', 'rejected', 'unknown') and ${table.providerRequestId} is null)
      )`,
    ),
    check(
      'video_attempts_payload_hash_check',
      sql`${table.requestPayloadHash} is null or length(${table.requestPayloadHash}) = 64`,
    ),
    check(
      'video_attempts_lease_check',
      sql`(
        (${table.leaseOwner} is null and ${table.leaseToken} is null and ${table.leaseUntil} is null)
        or (${table.leaseOwner} is not null and ${table.leaseToken} is not null and ${table.leaseUntil} is not null)
      )`,
    ),
  ],
)

export const videoOutbox = sqliteTable(
  'video_outbox',
  {
    id: text('id').primaryKey(),
    generationId: text('generation_id')
      .notNull()
      .references(() => videoGenerations.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    eventType: text('event_type', { enum: videoOutboxEventTypes }).notNull(),
    payloadVersion: integer('payload_version').notNull(),
    payload: text('payload', { mode: 'json' }).$type<JsonObject>().notNull(),
    notBefore: integer('not_before', { mode: 'timestamp' }).notNull(),
    deliveryStatus: text('delivery_status', {
      enum: videoOutboxDeliveryStatuses,
    }).notNull(),
    leaseOwner: text('lease_owner'),
    leaseToken: text('lease_token'),
    leaseUntil: integer('lease_until', { mode: 'timestamp' }),
    deliveryAttemptCount: integer('delivery_attempt_count').notNull().default(0),
    nextRetryAt: integer('next_retry_at', { mode: 'timestamp' }),
    lastErrorCode: text('last_error_code'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
    deliveredAt: integer('delivered_at', { mode: 'timestamp' }),
  },
  table => [
    uniqueIndex('video_outbox_inflight_unique')
      .on(table.generationId, table.eventType)
      .where(sql`${table.deliveryStatus} in ('pending', 'leased')`),
    index('video_outbox_delivery_due_idx')
      .on(table.deliveryStatus, table.notBefore, table.nextRetryAt),
    check(
      'video_outbox_event_type_check',
      sql`${table.eventType} in ('start_submission', 'poll_status', 'store_output')`,
    ),
    check('video_outbox_payload_version_check', sql`${table.payloadVersion} >= 1`),
    check(
      'video_outbox_delivery_status_check',
      sql`${table.deliveryStatus} in ('pending', 'leased', 'delivered', 'dead')`,
    ),
    check('video_outbox_attempt_count_check', sql`${table.deliveryAttemptCount} >= 0`),
    check(
      'video_outbox_lease_check',
      sql`(
        (${table.deliveryStatus} = 'leased' and ${table.leaseOwner} is not null and ${table.leaseToken} is not null and ${table.leaseUntil} is not null)
        or (${table.deliveryStatus} != 'leased' and ${table.leaseOwner} is null and ${table.leaseToken} is null and ${table.leaseUntil} is null)
      )`,
    ),
    check(
      'video_outbox_delivered_check',
      sql`(
        (${table.deliveryStatus} = 'delivered' and ${table.deliveredAt} is not null)
        or (${table.deliveryStatus} != 'delivered' and ${table.deliveredAt} is null)
      )`,
    ),
  ],
)

export const videoCreditOperations = sqliteTable(
  'video_credit_operations',
  {
    id: text('id').primaryKey(),
    generationId: text('generation_id')
      .notNull()
      .references(() => videoGenerations.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    operationType: text('operation_type', {
      enum: videoCreditOperationTypes,
    }).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    intendedQuantity: integer('intended_quantity').notNull(),
    spendableQuantity: integer('spendable_quantity').notNull(),
    expiredQuantity: integer('expired_quantity').notNull(),
    clawbackQuantity: integer('clawback_quantity').notNull(),
    forfeitedQuantity: integer('forfeited_quantity').notNull(),
    status: text('status').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  table => [
    uniqueIndex('video_credit_operations_idempotency_key_unique').on(table.idempotencyKey),
    uniqueIndex('video_credit_operations_generation_type_unique')
      .on(table.generationId, table.operationType),
    check(
      'video_credit_operations_type_check',
      sql`${table.operationType} in ('consume', 'return')`,
    ),
    check('video_credit_operations_status_check', sql`${table.status} in ('completed')`),
    check('video_credit_operations_key_check', sql`length(${table.idempotencyKey}) > 0`),
    check(
      'video_credit_operations_quantity_check',
      sql`${table.intendedQuantity} >= 0
        and ${table.spendableQuantity} >= 0
        and ${table.expiredQuantity} >= 0
        and ${table.clawbackQuantity} >= 0
        and ${table.forfeitedQuantity} >= 0
        and ${table.intendedQuantity} = ${table.spendableQuantity} + ${table.expiredQuantity} + ${table.clawbackQuantity} + ${table.forfeitedQuantity}`,
    ),
    check(
      'video_credit_operations_consume_shape_check',
      sql`${table.operationType} != 'consume'
        or (
          ${table.expiredQuantity} = 0
          and ${table.clawbackQuantity} = 0
          and ${table.forfeitedQuantity} = 0
          and ${table.spendableQuantity} = ${table.intendedQuantity}
        )`,
    ),
  ],
)

export const videoProviderCosts = sqliteTable(
  'video_provider_costs',
  {
    id: text('id').primaryKey(),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => videoAttempts.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    providerId: text('provider_id').notNull(),
    costKind: text('cost_kind', { enum: videoProviderCostKinds }).notNull(),
    amountMicros: integer('amount_micros'),
    currency: text('currency'),
    amountUnit: text('amount_unit').notNull(),
    source: text('source').notNull(),
    providerBillId: text('provider_bill_id'),
    observedAt: integer('observed_at', { mode: 'timestamp' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  table => [
    uniqueIndex('video_provider_costs_attempt_kind_unique')
      .on(table.attemptId, table.costKind),
    uniqueIndex('video_provider_costs_provider_bill_unique')
      .on(table.providerId, table.providerBillId)
      .where(sql`${table.providerBillId} is not null`),
    index('video_provider_costs_attempt_idx').on(table.attemptId),
    check(
      'video_provider_costs_kind_check',
      sql`${table.costKind} in ('estimated', 'actual', 'unknown')`,
    ),
    check('video_provider_costs_unit_check', sql`${table.amountUnit} in ('micro')`),
    check('video_provider_costs_provider_check', sql`length(${table.providerId}) > 0`),
    check('video_provider_costs_source_check', sql`length(${table.source}) > 0`),
    check(
      'video_provider_costs_bill_check',
      sql`${table.providerBillId} is null or length(${table.providerBillId}) > 0`,
    ),
    // CASE returns 0/1. A bare comparison would be NULL when amount or currency
    // is NULL, and SQLite treats a NULL CHECK as success.
    check(
      'video_provider_costs_amount_check',
      sql`case
        when ${table.costKind} = 'unknown'
          then ${table.amountMicros} is null
           and ${table.currency} is null
        when ${table.costKind} in ('estimated', 'actual')
          then ${table.amountMicros} is not null
           and typeof(${table.amountMicros}) = 'integer'
           and ${table.amountMicros} >= 0
           and ${table.currency} is not null
           and ${table.currency} glob '[A-Z][A-Z][A-Z]'
        else 0
      end`,
    ),
  ],
)

/**
 * Links a later video return to an existing cash-refund shortfall.
 * The original adjustment row stays unchanged.
 */
export const billingRefundCreditSettlements = sqliteTable(
  'billing_refund_credit_settlements',
  {
    id: text('id').primaryKey(),
    adjustmentId: text('adjustment_id')
      .notNull()
      .references(() => billingRefundCreditAdjustments.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    returnOperationId: text('return_operation_id')
      .notNull()
      .references(() => videoCreditOperations.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    grantId: text('grant_id')
      .notNull()
      .references(() => entitlementGrants.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    quantity: integer('quantity').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  table => [
    uniqueIndex('billing_refund_credit_settlements_adjustment_return_unique')
      .on(table.adjustmentId, table.returnOperationId),
    index('billing_refund_credit_settlements_return_idx').on(table.returnOperationId),
    index('billing_refund_credit_settlements_grant_idx').on(table.grantId),
    check('billing_refund_credit_settlements_quantity_check', sql`${table.quantity} > 0`),
  ],
)
