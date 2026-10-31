import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import type { EntitlementSnapshot } from './billing-values.ts'
import {
  billingDisputeStatuses,
  billingIntervals,
  billingOrderStatuses,
  billingProductKinds,
  billingProviders,
  billingRefundStatuses,
  billingSubscriptionStatuses,
  billingTypes,
  billingWebhookEventStatuses,
  entitlementGrantStatuses,
  entitlementSourceTypes,
  entitlementTransactionTypes,
  entitlementTypes,
  expirationPolicies,
  grantCadences,
} from './billing-values.ts'

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    clerkUserId: text('clerk_user_id').notNull(),
    primaryEmail: text('primary_email'),
    emailVerified: integer('email_verified', {
      mode: 'boolean',
    }).notNull().default(false),
    firstName: text('first_name'),
    lastName: text('last_name'),
    displayName: text('display_name'),
    username: text('username'),
    avatarUrl: text('avatar_url'),
    clerkCreatedAt: integer('clerk_created_at', {
      mode: 'timestamp',
    }),
    clerkUpdatedAt: integer('clerk_updated_at', {
      mode: 'timestamp',
    }),
    createdAt: integer('created_at', {
      mode: 'timestamp',
    }).notNull(),
    updatedAt: integer('updated_at', {
      mode: 'timestamp',
    }).notNull(),
    lastSeenAt: integer('last_seen_at', {
      mode: 'timestamp',
    }).notNull(),
    lastLoginAt: integer('last_login_at', {
      mode: 'timestamp',
    }),
  },
  table => [
    uniqueIndex('users_clerk_user_id_unique').on(table.clerkUserId),
  ],
)

export const billingProducts = sqliteTable(
  'billing_products',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    productKind: text('product_kind', {
      enum: billingProductKinds,
    }).notNull(),
    active: integer('active', {
      mode: 'boolean',
    }).notNull().default(false),
    metadata: text('metadata', {
      mode: 'json',
    }).$type<Record<string, unknown>>(),
    createdAt: integer('created_at', {
      mode: 'timestamp',
    }).notNull(),
    updatedAt: integer('updated_at', {
      mode: 'timestamp',
    }).notNull(),
  },
  table => [
    uniqueIndex('billing_products_code_unique').on(table.code),
    check(
      'billing_products_product_kind_check',
      sql`${table.productKind} in ('credit_pack', 'subscription')`,
    ),
  ],
)

export const billingPrices = sqliteTable(
  'billing_prices',
  {
    id: text('id').primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => billingProducts.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    code: text('code').notNull(),
    billingType: text('billing_type', {
      enum: billingTypes,
    }).notNull(),
    billingInterval: text('billing_interval', {
      enum: billingIntervals,
    }),
    intervalCount: integer('interval_count'),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    provider: text('provider', {
      enum: billingProviders,
    }).notNull(),
    providerProductId: text('provider_product_id'),
    providerPriceId: text('provider_price_id'),
    active: integer('active', {
      mode: 'boolean',
    }).notNull().default(false),
    createdAt: integer('created_at', {
      mode: 'timestamp',
    }).notNull(),
    updatedAt: integer('updated_at', {
      mode: 'timestamp',
    }).notNull(),
  },
  table => [
    uniqueIndex('billing_prices_code_unique').on(table.code),
    uniqueIndex('billing_prices_provider_price_id_unique')
      .on(table.provider, table.providerPriceId)
      .where(sql`${table.providerPriceId} is not null`),
    index('billing_prices_product_id_idx').on(table.productId),
    check(
      'billing_prices_billing_type_check',
      sql`${table.billingType} in ('one_time', 'recurring')`,
    ),
    check(
      'billing_prices_interval_check',
      sql`(
        (${table.billingType} = 'one_time'
          and ${table.billingInterval} is null
          and ${table.intervalCount} is null)
        or (${table.billingType} = 'recurring'
          and ${table.billingInterval} in ('month', 'year')
          and ${table.intervalCount} >= 1)
      )`,
    ),
    check(
      'billing_prices_amount_check',
      sql`${table.amount} > 0`,
    ),
    check(
      'billing_prices_currency_check',
      sql`length(${table.currency}) = 3 and ${table.currency} = upper(${table.currency})`,
    ),
    check(
      'billing_prices_provider_check',
      sql`${table.provider} in ('creem')`,
    ),
  ],
)

export const billingCustomers = sqliteTable(
  'billing_customers',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    provider: text('provider', {
      enum: billingProviders,
    }).notNull(),
    providerCustomerId: text('provider_customer_id').notNull(),
    emailSnapshot: text('email_snapshot'),
    createdAt: integer('created_at', {
      mode: 'timestamp',
    }).notNull(),
    updatedAt: integer('updated_at', {
      mode: 'timestamp',
    }).notNull(),
  },
  table => [
    uniqueIndex('billing_customers_user_provider_unique')
      .on(table.userId, table.provider),
    uniqueIndex('billing_customers_provider_customer_id_unique')
      .on(table.provider, table.providerCustomerId),
    index('billing_customers_user_id_idx').on(table.userId),
    check(
      'billing_customers_provider_check',
      sql`${table.provider} in ('creem')`,
    ),
  ],
)

export const productEntitlements = sqliteTable(
  'product_entitlements',
  {
    id: text('id').primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => billingProducts.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    entitlementKey: text('entitlement_key').notNull(),
    entitlementType: text('entitlement_type', {
      enum: entitlementTypes,
    }).notNull(),
    quantity: integer('quantity'),
    grantCadence: text('grant_cadence', {
      enum: grantCadences,
    }).notNull(),
    expirationPolicy: text('expiration_policy', {
      enum: expirationPolicies,
    }).notNull(),
    durationDays: integer('duration_days'),
    createdAt: integer('created_at', {
      mode: 'timestamp',
    }).notNull(),
    updatedAt: integer('updated_at', {
      mode: 'timestamp',
    }).notNull(),
  },
  table => [
    uniqueIndex('product_entitlements_product_key_unique')
      .on(table.productId, table.entitlementKey),
    index('product_entitlements_product_id_idx').on(table.productId),
    check(
      'product_entitlements_type_check',
      sql`${table.entitlementType} in ('consumable', 'feature', 'limit')`,
    ),
    check(
      'product_entitlements_quantity_check',
      sql`(
        (${table.entitlementType} = 'feature' and ${table.quantity} is null)
        or (${table.entitlementType} in ('consumable', 'limit')
          and ${table.quantity} > 0)
      )`,
    ),
    check(
      'product_entitlements_cadence_check',
      sql`${table.grantCadence} in ('purchase', 'monthly', 'subscription')`,
    ),
    check(
      'product_entitlements_expiration_check',
      sql`${table.expirationPolicy} in ('fixed_duration', 'grant_period_end', 'subscription_end')`,
    ),
    check(
      'product_entitlements_pattern_check',
      sql`(
        (${table.grantCadence} = 'purchase'
          and ${table.expirationPolicy} = 'fixed_duration'
          and ${table.durationDays} > 0)
        or (${table.grantCadence} = 'monthly'
          and ${table.expirationPolicy} = 'grant_period_end'
          and ${table.durationDays} is null)
        or (${table.grantCadence} = 'subscription'
          and ${table.expirationPolicy} = 'subscription_end'
          and ${table.durationDays} is null)
      )`,
    ),
  ],
)

export const billingSubscriptions = sqliteTable(
  'billing_subscriptions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    productId: text('product_id')
      .notNull()
      .references(() => billingProducts.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    priceId: text('price_id')
      .notNull()
      .references(() => billingPrices.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    customerId: text('customer_id')
      .notNull()
      .references(() => billingCustomers.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    status: text('status', {
      enum: billingSubscriptionStatuses,
    }).notNull(),
    provider: text('provider', {
      enum: billingProviders,
    }).notNull(),
    providerSubscriptionId: text('provider_subscription_id'),
    currentPeriodStart: integer('current_period_start', {
      mode: 'timestamp',
    }),
    currentPeriodEnd: integer('current_period_end', {
      mode: 'timestamp',
    }),
    billingInterval: text('billing_interval', {
      enum: billingIntervals,
    }).notNull(),
    intervalCount: integer('interval_count').notNull(),
    entitlementSnapshot: text('entitlement_snapshot', {
      mode: 'json',
    }).$type<EntitlementSnapshot>().notNull(),
    cancelAtPeriodEnd: integer('cancel_at_period_end', {
      mode: 'boolean',
    }).notNull().default(false),
    canceledAt: integer('canceled_at', {
      mode: 'timestamp',
    }),
    endedAt: integer('ended_at', {
      mode: 'timestamp',
    }),
    createdAt: integer('created_at', {
      mode: 'timestamp',
    }).notNull(),
    updatedAt: integer('updated_at', {
      mode: 'timestamp',
    }).notNull(),
  },
  table => [
    uniqueIndex('billing_subscriptions_provider_subscription_id_unique')
      .on(table.provider, table.providerSubscriptionId)
      .where(sql`${table.providerSubscriptionId} is not null`),
    index('billing_subscriptions_user_id_idx').on(table.userId),
    index('billing_subscriptions_product_id_idx').on(table.productId),
    index('billing_subscriptions_price_id_idx').on(table.priceId),
    index('billing_subscriptions_customer_id_idx').on(table.customerId),
    index('billing_subscriptions_status_idx').on(table.status),
    check(
      'billing_subscriptions_status_check',
      sql`${table.status} in ('pending', 'trialing', 'active', 'past_due', 'paused', 'canceled', 'expired')`,
    ),
    check(
      'billing_subscriptions_provider_check',
      sql`${table.provider} in ('creem')`,
    ),
    check(
      'billing_subscriptions_interval_check',
      sql`${table.billingInterval} in ('month', 'year') and ${table.intervalCount} >= 1`,
    ),
    check(
      'billing_subscriptions_period_check',
      sql`(
        ${table.currentPeriodStart} is null
        or ${table.currentPeriodEnd} is null
        or ${table.currentPeriodEnd} > ${table.currentPeriodStart}
      )`,
    ),
  ],
)

export const billingOrders = sqliteTable(
  'billing_orders',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    productId: text('product_id')
      .notNull()
      .references(() => billingProducts.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    priceId: text('price_id')
      .notNull()
      .references(() => billingPrices.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    // Nullable until Checkout-completed Webhook creates billing_customers.
    customerId: text('customer_id')
      .references(() => billingCustomers.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    subscriptionId: text('subscription_id')
      .references(() => billingSubscriptions.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    status: text('status', {
      enum: billingOrderStatuses,
    }).notNull(),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    /**
     * Immutable provider gross paid amount used as the refund-ratio denominator.
     * Populated once from a verified refund/paid fixture; never overwrite after set.
     * Do not fall back to catalog `amount` when the values differ.
     */
    providerPaidAmount: integer('provider_paid_amount'),
    /** Incremented for every applied refund to serialize cumulative refund math. */
    refundVersion: integer('refund_version').notNull().default(0),
    productNameSnapshot: text('product_name_snapshot').notNull(),
    priceCodeSnapshot: text('price_code_snapshot').notNull(),
    entitlementSnapshot: text('entitlement_snapshot', {
      mode: 'json',
    }).$type<EntitlementSnapshot>().notNull(),
    provider: text('provider', {
      enum: billingProviders,
    }).notNull(),
    providerCheckoutId: text('provider_checkout_id'),
    providerCheckoutUrl: text('provider_checkout_url'),
    providerOrderId: text('provider_order_id'),
    checkoutIdempotencyKey: text('checkout_idempotency_key'),
    failureCode: text('failure_code'),
    createdAt: integer('created_at', {
      mode: 'timestamp',
    }).notNull(),
    updatedAt: integer('updated_at', {
      mode: 'timestamp',
    }).notNull(),
    paidAt: integer('paid_at', {
      mode: 'timestamp',
    }),
    failedAt: integer('failed_at', {
      mode: 'timestamp',
    }),
    expiredAt: integer('expired_at', {
      mode: 'timestamp',
    }),
    refundedAt: integer('refunded_at', {
      mode: 'timestamp',
    }),
  },
  table => [
    uniqueIndex('billing_orders_provider_checkout_id_unique')
      .on(table.provider, table.providerCheckoutId)
      .where(sql`${table.providerCheckoutId} is not null`),
    uniqueIndex('billing_orders_provider_order_id_unique')
      .on(table.provider, table.providerOrderId)
      .where(sql`${table.providerOrderId} is not null`),
    // SQLite UNIQUE allows multiple NULLs; only keyed Checkout rows are unique.
    uniqueIndex('billing_orders_user_checkout_idempotency_key_unique')
      .on(table.userId, table.checkoutIdempotencyKey)
      .where(sql`${table.checkoutIdempotencyKey} is not null`),
    index('billing_orders_user_id_idx').on(table.userId),
    index('billing_orders_product_id_idx').on(table.productId),
    index('billing_orders_price_id_idx').on(table.priceId),
    index('billing_orders_customer_id_idx').on(table.customerId),
    index('billing_orders_subscription_id_idx').on(table.subscriptionId),
    index('billing_orders_status_idx').on(table.status),
    check(
      'billing_orders_status_check',
      sql`${table.status} in ('pending', 'paid', 'failed', 'expired', 'refunded', 'partially_refunded')`,
    ),
    check(
      'billing_orders_amount_check',
      sql`${table.amount} > 0`,
    ),
    check(
      'billing_orders_provider_paid_amount_check',
      sql`${table.providerPaidAmount} is null or ${table.providerPaidAmount} > 0`,
    ),
    check(
      'billing_orders_refund_version_check',
      sql`${table.refundVersion} >= 0`,
    ),
    check(
      'billing_orders_currency_check',
      sql`length(${table.currency}) = 3 and ${table.currency} = upper(${table.currency})`,
    ),
    check(
      'billing_orders_provider_check',
      sql`${table.provider} in ('creem')`,
    ),
  ],
)

export const billingRefunds = sqliteTable(
  'billing_refunds',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => billingOrders.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    provider: text('provider', {
      enum: billingProviders,
    }).notNull(),
    providerRefundId: text('provider_refund_id'),
    status: text('status', {
      enum: billingRefundStatuses,
    }).notNull(),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    reasonCode: text('reason_code'),
    createdAt: integer('created_at', {
      mode: 'timestamp',
    }).notNull(),
    updatedAt: integer('updated_at', {
      mode: 'timestamp',
    }).notNull(),
    succeededAt: integer('succeeded_at', {
      mode: 'timestamp',
    }),
    failedAt: integer('failed_at', {
      mode: 'timestamp',
    }),
  },
  table => [
    uniqueIndex('billing_refunds_provider_refund_id_unique')
      .on(table.provider, table.providerRefundId)
      .where(sql`${table.providerRefundId} is not null`),
    index('billing_refunds_order_id_idx').on(table.orderId),
    index('billing_refunds_status_idx').on(table.status),
    check(
      'billing_refunds_status_check',
      sql`${table.status} in ('pending', 'succeeded', 'failed', 'canceled')`,
    ),
    check(
      'billing_refunds_amount_check',
      sql`${table.amount} > 0`,
    ),
    check(
      'billing_refunds_currency_check',
      sql`length(${table.currency}) = 3 and ${table.currency} = upper(${table.currency})`,
    ),
    check(
      'billing_refunds_provider_check',
      sql`${table.provider} in ('creem')`,
    ),
  ],
)

export const billingWebhookEvents = sqliteTable(
  'billing_webhook_events',
  {
    id: text('id').primaryKey(),
    provider: text('provider', {
      enum: billingProviders,
    }).notNull(),
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type').notNull(),
    status: text('status', {
      enum: billingWebhookEventStatuses,
    }).notNull(),
    payloadHash: text('payload_hash').notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    errorCode: text('error_code'),
    createdAt: integer('created_at', {
      mode: 'timestamp',
    }).notNull(),
    processedAt: integer('processed_at', {
      mode: 'timestamp',
    }),
    updatedAt: integer('updated_at', {
      mode: 'timestamp',
    }).notNull(),
  },
  table => [
    uniqueIndex('billing_webhook_events_provider_event_id_unique')
      .on(table.provider, table.providerEventId),
    index('billing_webhook_events_status_idx').on(table.status),
    check(
      'billing_webhook_events_provider_check',
      sql`${table.provider} in ('creem')`,
    ),
    check(
      'billing_webhook_events_status_check',
      sql`${table.status} in ('received', 'processing', 'processed', 'failed')`,
    ),
    check(
      'billing_webhook_events_attempt_count_check',
      sql`${table.attemptCount} >= 0`,
    ),
  ],
)

export const entitlementGrants = sqliteTable(
  'entitlement_grants',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    entitlementKey: text('entitlement_key').notNull(),
    entitlementType: text('entitlement_type', {
      enum: entitlementTypes,
    }).notNull(),
    sourceType: text('source_type', {
      enum: entitlementSourceTypes,
    }).notNull(),
    sourceId: text('source_id').notNull(),
    periodKey: text('period_key').notNull(),
    grantedQuantity: integer('granted_quantity'),
    remainingQuantity: integer('remaining_quantity'),
    effectiveAt: integer('effective_at', {
      mode: 'timestamp',
    }).notNull(),
    expiresAt: integer('expires_at', {
      mode: 'timestamp',
    }),
    status: text('status', {
      enum: entitlementGrantStatuses,
    }).notNull(),
    createdAt: integer('created_at', {
      mode: 'timestamp',
    }).notNull(),
    updatedAt: integer('updated_at', {
      mode: 'timestamp',
    }).notNull(),
  },
  table => [
    uniqueIndex('entitlement_grants_source_period_unique')
      .on(
        table.sourceType,
        table.sourceId,
        table.entitlementKey,
        table.periodKey,
      ),
    index('entitlement_grants_user_lookup_idx').on(
      table.userId,
      table.entitlementKey,
      table.status,
      table.expiresAt,
      table.effectiveAt,
    ),
    index('entitlement_grants_user_id_idx').on(table.userId),
    check(
      'entitlement_grants_type_check',
      sql`${table.entitlementType} in ('consumable', 'feature', 'limit')`,
    ),
    check(
      'entitlement_grants_source_type_check',
      sql`${table.sourceType} in ('order', 'subscription_cycle', 'admin', 'migration', 'promotion')`,
    ),
    check(
      'entitlement_grants_status_check',
      sql`${table.status} in ('active', 'expired', 'revoked')`,
    ),
    check(
      'entitlement_grants_quantity_check',
      sql`(
        (${table.entitlementType} = 'feature'
          and ${table.grantedQuantity} is null
          and ${table.remainingQuantity} is null)
        or (${table.entitlementType} in ('consumable', 'limit')
          and ${table.grantedQuantity} >= 0
          and ${table.remainingQuantity} >= 0
          and ${table.remainingQuantity} <= ${table.grantedQuantity})
      )`,
    ),
  ],
)

export const entitlementTransactions = sqliteTable(
  'entitlement_transactions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    grantId: text('grant_id')
      .notNull()
      .references(() => entitlementGrants.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    transactionType: text('transaction_type', {
      enum: entitlementTransactionTypes,
    }).notNull(),
    quantity: integer('quantity').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    balanceBefore: integer('balance_before').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    // 0003 assigns a persistent per-grant sequence inside each transaction insert.
    ledgerSequence: integer('ledger_sequence'),
    createdAt: integer('created_at', {
      mode: 'timestamp',
    }).notNull(),
  },
  table => [
    uniqueIndex('entitlement_transactions_idempotency_key_unique')
      .on(table.idempotencyKey),
    uniqueIndex('entitlement_transactions_grant_sequence_unique')
      .on(table.grantId, table.ledgerSequence),
    index('entitlement_transactions_user_id_idx').on(table.userId),
    index('entitlement_transactions_grant_id_idx').on(table.grantId),
    check(
      'entitlement_transactions_type_check',
      sql`${table.transactionType} in ('grant', 'consume', 'refund', 'expire', 'adjustment', 'revoke')`,
    ),
    check(
      'entitlement_transactions_quantity_sign_check',
      sql`(
        (${table.transactionType} in ('grant', 'refund') and ${table.quantity} > 0)
        or (${table.transactionType} in ('consume', 'expire', 'revoke')
          and ${table.quantity} < 0)
        or (${table.transactionType} = 'adjustment' and ${table.quantity} != 0)
      )`,
    ),
    check(
      'entitlement_transactions_balance_check',
      sql`${table.balanceAfter} = ${table.balanceBefore} + ${table.quantity}`,
    ),
  ],
)

export const billingRefundCreditAdjustments = sqliteTable(
  'billing_refund_credit_adjustments',
  {
    id: text('id').primaryKey(),
    refundId: text('refund_id')
      .notNull()
      .references(() => billingRefunds.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    grantId: text('grant_id')
      .notNull()
      .references(() => entitlementGrants.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    targetQuantity: integer('target_quantity').notNull(),
    appliedQuantity: integer('applied_quantity').notNull(),
    shortfallQuantity: integer('shortfall_quantity').notNull(),
    entitlementTransactionId: text('entitlement_transaction_id')
      .references(() => entitlementTransactions.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    createdAt: integer('created_at', {
      mode: 'timestamp',
    }).notNull(),
    updatedAt: integer('updated_at', {
      mode: 'timestamp',
    }).notNull(),
  },
  table => [
    uniqueIndex('billing_refund_credit_adjustments_refund_grant_unique')
      .on(table.refundId, table.grantId),
    index('billing_refund_credit_adjustments_refund_id_idx').on(table.refundId),
    index('billing_refund_credit_adjustments_grant_id_idx').on(table.grantId),
    check(
      'billing_refund_credit_adjustments_quantity_check',
      sql`${table.targetQuantity} >= 0
        and ${table.appliedQuantity} >= 0
        and ${table.shortfallQuantity} >= 0
        and ${table.targetQuantity} = ${table.appliedQuantity} + ${table.shortfallQuantity}`,
    ),
  ],
)

/**
 * Opened dispute audit only (Phase 1). Not a financial reversal command.
 */
export const billingDisputes = sqliteTable(
  'billing_disputes',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => billingOrders.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    provider: text('provider', {
      enum: billingProviders,
    }).notNull(),
    providerDisputeId: text('provider_dispute_id').notNull(),
    providerTransactionId: text('provider_transaction_id'),
    status: text('status', {
      enum: billingDisputeStatuses,
    }).notNull(),
    amount: integer('amount'),
    currency: text('currency'),
    createdAt: integer('created_at', {
      mode: 'timestamp',
    }).notNull(),
    updatedAt: integer('updated_at', {
      mode: 'timestamp',
    }).notNull(),
  },
  table => [
    uniqueIndex('billing_disputes_provider_dispute_id_unique')
      .on(table.provider, table.providerDisputeId),
    index('billing_disputes_order_id_idx').on(table.orderId),
    check(
      'billing_disputes_status_check',
      sql`${table.status} in ('opened')`,
    ),
    check(
      'billing_disputes_provider_check',
      sql`${table.provider} in ('creem')`,
    ),
    check(
      'billing_disputes_amount_check',
      sql`${table.amount} is null or ${table.amount} > 0`,
    ),
    check(
      'billing_disputes_currency_check',
      sql`${table.currency} is null
        or (length(${table.currency}) = 3 and ${table.currency} = upper(${table.currency}))`,
    ),
  ],
)

