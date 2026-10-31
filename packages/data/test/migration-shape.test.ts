import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(join(root, path))).digest('hex')
}

const baselineSqlHash = 'd56c012e7d9b84af6fcf20a1ff0f7ec061903a13bba22bec092f9f5d5233f387'
const baselineSnapshotHash = '5040896ca8b667ed2f68c91f86f5081fc2975de76e8e57b2adcb9ae7019078a1'
const videoBusinessSqlHash = '222404c3a2ca313e7a002ab784c51be00f3b0e036fa9a4f0640f476a163a9dd3'
const videoBusinessSnapshotHash = '911bb598bf1784d093b6010d807deddf6ef74d56382bd6f4d286d2f04eb97baf'

describe('增量迁移形状', () => {
  it('0000 基线 SQL 与 snapshot 保持原字节', () => {
    assert.equal(sha256('drizzle/0000_fast_magdalene.sql'), baselineSqlHash)
    assert.equal(sha256('drizzle/meta/0000_snapshot.json'), baselineSnapshotHash)
  })

  it('0001 SQL 与 snapshot 保持已写入的字节', () => {
    assert.equal(sha256('drizzle/0001_video_business.sql'), videoBusinessSqlHash)
    assert.equal(sha256('drizzle/meta/0001_snapshot.json'), videoBusinessSnapshotHash)
  })

  it('journal 追加 0001 至 0003，不改写原有条目', () => {
    const journal = JSON.parse(read('drizzle/meta/_journal.json')) as {
      version: string
      dialect: string
      entries: Array<{ idx: number, version: string, when: number, tag: string, breakpoints: boolean }>
    }
    assert.equal(journal.version, '7')
    assert.equal(journal.dialect, 'sqlite')
    assert.deepEqual(journal.entries[0], {
      idx: 0,
      version: '6',
      when: 1789916879550,
      tag: '0000_fast_magdalene',
      breakpoints: true,
    })
    assert.deepEqual(journal.entries[1], {
      idx: 1,
      version: '6',
      when: 1793404800000,
      tag: '0001_video_business',
      breakpoints: true,
    })
    assert.deepEqual(journal.entries[2], {
      idx: 2,
      version: '6',
      when: 1793491200000,
      tag: '0002_provider_cost_check',
      breakpoints: true,
    })
    assert.deepEqual(journal.entries[3], {
      idx: 3, version: '6', when: 1793491200001, tag: '0003_ledger_integrity', breakpoints: true,
    })
    assert.equal(journal.entries.length, 4)
  })

  it('0001 只创建七张新表，不 DROP 或 ALTER', () => {
    const sql = read('drizzle/0001_video_business.sql')
    assert.equal(/\bDROP\b/i.test(sql), false)
    assert.equal(/\bALTER\b/i.test(sql), false)
    const tables = [...sql.matchAll(/CREATE TABLE `([^`]+)`/g)].map(match => match[1])
    assert.deepEqual(tables, [
      'video_assets',
      'video_generations',
      'video_attempts',
      'video_outbox',
      'video_credit_operations',
      'video_provider_costs',
      'billing_refund_credit_settlements',
    ])
    for (const existing of ['users', 'entitlement_grants', 'entitlement_transactions', 'billing_orders', 'billing_refunds', 'billing_refund_credit_adjustments']) {
      assert.equal(sql.includes(`CREATE TABLE \`${existing}\``), false)
    }
  })

  it('0001 包含幂等、归属、接单和成本去重约束', () => {
    const sql = read('drizzle/0001_video_business.sql')
    const required = [
      'CREATE UNIQUE INDEX `video_generations_user_idempotency_key_unique` ON `video_generations` (`user_id`,`idempotency_key`)',
      'CREATE UNIQUE INDEX `video_assets_id_user_id_unique` ON `video_assets` (`id`,`user_id`)',
      'CREATE UNIQUE INDEX `video_attempts_submit_key_unique` ON `video_attempts` (`submit_key`)',
      'CREATE UNIQUE INDEX `video_attempts_provider_request_unique` ON `video_attempts` (`provider_id`,`provider_request_id`) WHERE "video_attempts"."provider_request_id" is not null',
      'CREATE UNIQUE INDEX `video_attempts_one_open_step_unique` ON `video_attempts` (`generation_id`,`step_id`) WHERE "video_attempts"."acceptance_status" in (\'not_submitted\', \'unknown\', \'accepted\')',
      'CREATE UNIQUE INDEX `video_outbox_inflight_unique` ON `video_outbox` (`generation_id`,`event_type`) WHERE "video_outbox"."delivery_status" in (\'pending\', \'leased\')',
      'CREATE UNIQUE INDEX `video_credit_operations_generation_type_unique` ON `video_credit_operations` (`generation_id`,`operation_type`)',
      'CREATE UNIQUE INDEX `video_credit_operations_idempotency_key_unique` ON `video_credit_operations` (`idempotency_key`)',
      'CREATE UNIQUE INDEX `video_provider_costs_attempt_kind_unique` ON `video_provider_costs` (`attempt_id`,`cost_kind`)',
      'CREATE UNIQUE INDEX `video_provider_costs_provider_bill_unique` ON `video_provider_costs` (`provider_id`,`provider_bill_id`) WHERE "video_provider_costs"."provider_bill_id" is not null',
      'CREATE UNIQUE INDEX `billing_refund_credit_settlements_adjustment_return_unique` ON `billing_refund_credit_settlements` (`adjustment_id`,`return_operation_id`)',
      'CONSTRAINT "video_generations_image_owner_fk" FOREIGN KEY (`image_asset_id`,`user_id`) REFERENCES `video_assets`(`id`,`user_id`)',
      'CONSTRAINT "video_generations_output_owner_fk" FOREIGN KEY (`output_asset_id`,`user_id`) REFERENCES `video_assets`(`id`,`user_id`)',
      'FOREIGN KEY (`adjustment_id`) REFERENCES `billing_refund_credit_adjustments`(`id`)',
      'FOREIGN KEY (`return_operation_id`) REFERENCES `video_credit_operations`(`id`)',
      'FOREIGN KEY (`grant_id`) REFERENCES `entitlement_grants`(`id`)',
      'CONSTRAINT "video_provider_costs_amount_check" CHECK',
      'CONSTRAINT "video_attempts_request_id_check" CHECK',
      'CONSTRAINT "video_credit_operations_quantity_check" CHECK',
    ]
    for (const snippet of required) assert.equal(sql.includes(snippet), true, snippet)
    assert.equal(sql.includes('public_url'), false)
    assert.equal(sql.includes('signed_url'), false)
  })

  it('0001 snapshot 保留旧表并接上 prevId', () => {
    const previous = JSON.parse(read('drizzle/meta/0000_snapshot.json')) as {
      id: string
      tables: Record<string, unknown>
    }
    const next = JSON.parse(read('drizzle/meta/0001_snapshot.json')) as {
      id: string
      prevId: string
      version: string
      dialect: string
      tables: Record<string, unknown>
      internal: { indexes: Record<string, unknown> }
    }
    assert.equal(next.version, '6')
    assert.equal(next.dialect, 'sqlite')
    assert.equal(next.prevId, previous.id)
    assert.equal(next.id, '7c2e9a14-6b8f-4d33-a1e0-5f6b7c8d9e01')
    assert.deepEqual(next.internal.indexes, {})
    for (const [name, table] of Object.entries(previous.tables)) {
      assert.deepEqual(next.tables[name], table)
    }
    for (const name of [
      'video_assets',
      'video_generations',
      'video_attempts',
      'video_outbox',
      'video_credit_operations',
      'video_provider_costs',
      'billing_refund_credit_settlements',
    ]) {
      assert.ok(next.tables[name])
    }
    assert.equal(Object.keys(next.tables).length, Object.keys(previous.tables).length + 7)
  })

  it('0002 只收紧已知成本 CHECK，并追加 shortfall 触发器', () => {
    const sql = read('drizzle/0002_provider_cost_check.sql')
    assert.equal(sql.includes('CREATE TABLE `video_provider_costs__strict`'), true)
    assert.equal(sql.includes('DROP TABLE `video_provider_costs`'), true)
    assert.equal(sql.includes('ALTER TABLE `video_provider_costs__strict` RENAME TO `video_provider_costs`'), true)
    assert.equal(/\bDROP TABLE `(?!video_provider_costs`)/.test(sql), false)
    for (const existing of ['users', 'billing_orders', 'billing_refunds', 'billing_refund_credit_adjustments', 'entitlement_grants', 'video_generations']) {
      assert.equal(sql.includes(`CREATE TABLE \`${existing}\``), false, existing)
      assert.equal(sql.includes(`DROP TABLE \`${existing}\``), false, existing)
    }
    const required = [
      'typeof("video_provider_costs__strict"."amount_micros") = \'integer\'',
      '"video_provider_costs__strict"."amount_micros" is not null',
      '"video_provider_costs__strict"."currency" is not null',
      'glob \'[A-Z][A-Z][A-Z]\'',
      '"video_provider_costs__strict"."cost_kind" = \'unknown\'',
      '"video_provider_costs__strict"."amount_micros" is null',
      'CREATE TRIGGER `billing_refund_credit_settlements_guard_insert`',
      'RAISE(ABORT, \'settlement_exceeds_shortfall\')',
      'RAISE(ABORT, \'settlement_grant_mismatch\')',
      'RAISE(ABORT, \'settlement_clawback_mismatch\')',
      'shortfall_quantity',
      'video_generation_return_clawback',
      ':clawback',
    ]
    for (const snippet of required) assert.equal(sql.includes(snippet), true, snippet)
    assert.equal(sql.includes('UPDATE `billing_refund_credit_adjustments`'), false)
    assert.equal(sql.includes('DELETE FROM `billing_refund_credit_adjustments`'), false)
  })

  it('0002 snapshot 接上 0001，且只改已知成本 CHECK', () => {
    const previous = JSON.parse(read('drizzle/meta/0001_snapshot.json')) as {
      id: string
      tables: Record<string, { checkConstraints?: Record<string, { value: string }> }>
    }
    const next = JSON.parse(read('drizzle/meta/0002_snapshot.json')) as {
      id: string
      prevId: string
      version: string
      dialect: string
      tables: Record<string, { checkConstraints?: Record<string, { value: string }> }>
    }
    assert.equal(next.version, '6')
    assert.equal(next.dialect, 'sqlite')
    assert.equal(next.prevId, previous.id)
    assert.equal(next.id, 'a8f4c2d1-7e63-4b90-8c15-2d6f9a0b1c34')
    assert.equal(Object.keys(next.tables).length, Object.keys(previous.tables).length)
    for (const [name, table] of Object.entries(previous.tables)) {
      if (name !== 'video_provider_costs') assert.deepEqual(next.tables[name], table)
    }
    const before = previous.tables.video_provider_costs?.checkConstraints?.video_provider_costs_amount_check?.value ?? ''
    const after = next.tables.video_provider_costs?.checkConstraints?.video_provider_costs_amount_check?.value ?? ''
    assert.equal(before.includes('is not null'), false)
    assert.equal(after.includes('typeof("video_provider_costs"."amount_micros") = \'integer\''), true)
    assert.equal(after.includes('glob \'[A-Z][A-Z][A-Z]\''), true)
    assert.equal(after.includes('"video_provider_costs"."amount_micros" is not null'), true)
    assert.equal(after.includes('"video_provider_costs"."currency" is not null'), true)
    assert.equal(after.includes('cost_kind" = \'unknown\''), true)
    const previousCosts = structuredClone(previous.tables.video_provider_costs)
    const nextCosts = structuredClone(next.tables.video_provider_costs)
    if (previousCosts?.checkConstraints && nextCosts?.checkConstraints) {
      previousCosts.checkConstraints.video_provider_costs_amount_check = nextCosts.checkConstraints.video_provider_costs_amount_check!
    }
    assert.deepEqual(nextCosts, previousCosts)
  })

  it('兼容入口不再保留第二份表定义，data 不引用 server', () => {
    const schemaEntry = read('server/database/schema/index.ts')
    assert.equal(schemaEntry.includes('sqliteTable'), false)
    assert.equal(schemaEntry.includes('../../../packages/data/src/schema/index.ts'), true)
    const config = read('drizzle.config.ts')
    assert.equal(config.includes('./packages/data/src/schema/index.ts'), true)
    assert.equal(config.includes('./server/database/schema/index.ts'), false)
    const client = read('server/database/client.ts')
    assert.equal(client.includes('../../packages/data/src/client.ts'), true)
    assert.equal(client.includes('drizzle-orm/d1'), false)
    const billingTypes = read('server/types/billing.ts')
    assert.equal(billingTypes.includes('../../packages/data/src/schema/billing-values.ts'), true)
    assert.equal(billingTypes.includes('CHECKOUT_CREDIT_PACK_CONTRACTS'), true)
    for (const path of [
      'packages/data/src/client.ts',
      'packages/data/src/index.ts',
      'packages/data/src/credits/contract.ts',
      'packages/data/src/schema/index.ts',
      'packages/data/src/schema/billing.ts',
      'packages/data/src/schema/billing-values.ts',
      'packages/data/src/schema/video.ts',
    ]) {
      const source = read(path)
      assert.equal(/from\s+['"][^'"]*server\//.test(source), false, path)
      assert.equal(source.includes("from 'h3'"), false, path)
    }
  })
})

describe('P2.3 integrity migration', () => {
  it('0003 appends ledger order and attempt evidence without replacing existing tables', () => {
    const sql = read('drizzle/0003_ledger_integrity.sql')
    assert.equal(/\bDROP\s+TABLE\b/i.test(sql), false)
    for (const snippet of [
      'ADD COLUMN `ledger_sequence` integer',
      'PARTITION BY grant_id ORDER BY rowid',
      'entitlement_transactions_grant_sequence_unique',
      'credit_grant_quantity_invalid',
      'ledger_initial_grant_invalid',
      'ledger_chain_invalid',
      'entitlement_transactions_assign_sequence',
      'ADD COLUMN `settlement_event` text',
      'ADD COLUMN `settlement_evidence_id` text',
      'attempt_settlement_evidence_invalid',
    ]) assert.equal(sql.includes(snippet), true, snippet)
    const previous = JSON.parse(read('drizzle/meta/0002_snapshot.json'))
    const next = JSON.parse(read('drizzle/meta/0003_snapshot.json'))
    assert.equal(next.prevId, previous.id)
    assert.equal(next.tables.entitlement_transactions.columns.ledger_sequence.type, 'integer')
    assert.equal(next.tables.video_attempts.columns.settlement_event.type, 'text')
    assert.equal(next.tables.video_attempts.columns.settlement_evidence_id.type, 'text')
    const normalized = structuredClone(next.tables)
    delete normalized.entitlement_transactions.columns.ledger_sequence
    delete normalized.entitlement_transactions.indexes.entitlement_transactions_grant_sequence_unique
    delete normalized.video_attempts.columns.settlement_event
    delete normalized.video_attempts.columns.settlement_evidence_id
    assert.deepEqual(normalized, previous.tables)
  })
})
