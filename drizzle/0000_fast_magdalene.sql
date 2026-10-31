CREATE TABLE `billing_customers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_customer_id` text NOT NULL,
	`email_snapshot` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "billing_customers_provider_check" CHECK("billing_customers"."provider" in ('creem'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_customers_user_provider_unique` ON `billing_customers` (`user_id`,`provider`);--> statement-breakpoint
CREATE UNIQUE INDEX `billing_customers_provider_customer_id_unique` ON `billing_customers` (`provider`,`provider_customer_id`);--> statement-breakpoint
CREATE INDEX `billing_customers_user_id_idx` ON `billing_customers` (`user_id`);--> statement-breakpoint
CREATE TABLE `billing_disputes` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_dispute_id` text NOT NULL,
	`provider_transaction_id` text,
	`status` text NOT NULL,
	`amount` integer,
	`currency` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `billing_orders`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "billing_disputes_status_check" CHECK("billing_disputes"."status" in ('opened')),
	CONSTRAINT "billing_disputes_provider_check" CHECK("billing_disputes"."provider" in ('creem')),
	CONSTRAINT "billing_disputes_amount_check" CHECK("billing_disputes"."amount" is null or "billing_disputes"."amount" > 0),
	CONSTRAINT "billing_disputes_currency_check" CHECK("billing_disputes"."currency" is null
        or (length("billing_disputes"."currency") = 3 and "billing_disputes"."currency" = upper("billing_disputes"."currency")))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_disputes_provider_dispute_id_unique` ON `billing_disputes` (`provider`,`provider_dispute_id`);--> statement-breakpoint
CREATE INDEX `billing_disputes_order_id_idx` ON `billing_disputes` (`order_id`);--> statement-breakpoint
CREATE TABLE `billing_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`product_id` text NOT NULL,
	`price_id` text NOT NULL,
	`customer_id` text,
	`subscription_id` text,
	`status` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`provider_paid_amount` integer,
	`refund_version` integer DEFAULT 0 NOT NULL,
	`product_name_snapshot` text NOT NULL,
	`price_code_snapshot` text NOT NULL,
	`entitlement_snapshot` text NOT NULL,
	`provider` text NOT NULL,
	`provider_checkout_id` text,
	`provider_checkout_url` text,
	`provider_order_id` text,
	`checkout_idempotency_key` text,
	`failure_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`paid_at` integer,
	`failed_at` integer,
	`expired_at` integer,
	`refunded_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`product_id`) REFERENCES `billing_products`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`price_id`) REFERENCES `billing_prices`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`customer_id`) REFERENCES `billing_customers`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`subscription_id`) REFERENCES `billing_subscriptions`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "billing_orders_status_check" CHECK("billing_orders"."status" in ('pending', 'paid', 'failed', 'expired', 'refunded', 'partially_refunded')),
	CONSTRAINT "billing_orders_amount_check" CHECK("billing_orders"."amount" > 0),
	CONSTRAINT "billing_orders_provider_paid_amount_check" CHECK("billing_orders"."provider_paid_amount" is null or "billing_orders"."provider_paid_amount" > 0),
	CONSTRAINT "billing_orders_refund_version_check" CHECK("billing_orders"."refund_version" >= 0),
	CONSTRAINT "billing_orders_currency_check" CHECK(length("billing_orders"."currency") = 3 and "billing_orders"."currency" = upper("billing_orders"."currency")),
	CONSTRAINT "billing_orders_provider_check" CHECK("billing_orders"."provider" in ('creem'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_orders_provider_checkout_id_unique` ON `billing_orders` (`provider`,`provider_checkout_id`) WHERE "billing_orders"."provider_checkout_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `billing_orders_provider_order_id_unique` ON `billing_orders` (`provider`,`provider_order_id`) WHERE "billing_orders"."provider_order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `billing_orders_user_checkout_idempotency_key_unique` ON `billing_orders` (`user_id`,`checkout_idempotency_key`) WHERE "billing_orders"."checkout_idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX `billing_orders_user_id_idx` ON `billing_orders` (`user_id`);--> statement-breakpoint
CREATE INDEX `billing_orders_product_id_idx` ON `billing_orders` (`product_id`);--> statement-breakpoint
CREATE INDEX `billing_orders_price_id_idx` ON `billing_orders` (`price_id`);--> statement-breakpoint
CREATE INDEX `billing_orders_customer_id_idx` ON `billing_orders` (`customer_id`);--> statement-breakpoint
CREATE INDEX `billing_orders_subscription_id_idx` ON `billing_orders` (`subscription_id`);--> statement-breakpoint
CREATE INDEX `billing_orders_status_idx` ON `billing_orders` (`status`);--> statement-breakpoint
CREATE TABLE `billing_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`code` text NOT NULL,
	`billing_type` text NOT NULL,
	`billing_interval` text,
	`interval_count` integer,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`provider` text NOT NULL,
	`provider_product_id` text,
	`provider_price_id` text,
	`active` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `billing_products`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "billing_prices_billing_type_check" CHECK("billing_prices"."billing_type" in ('one_time', 'recurring')),
	CONSTRAINT "billing_prices_interval_check" CHECK((
        ("billing_prices"."billing_type" = 'one_time'
          and "billing_prices"."billing_interval" is null
          and "billing_prices"."interval_count" is null)
        or ("billing_prices"."billing_type" = 'recurring'
          and "billing_prices"."billing_interval" in ('month', 'year')
          and "billing_prices"."interval_count" >= 1)
      )),
	CONSTRAINT "billing_prices_amount_check" CHECK("billing_prices"."amount" > 0),
	CONSTRAINT "billing_prices_currency_check" CHECK(length("billing_prices"."currency") = 3 and "billing_prices"."currency" = upper("billing_prices"."currency")),
	CONSTRAINT "billing_prices_provider_check" CHECK("billing_prices"."provider" in ('creem'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_prices_code_unique` ON `billing_prices` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `billing_prices_provider_price_id_unique` ON `billing_prices` (`provider`,`provider_price_id`) WHERE "billing_prices"."provider_price_id" is not null;--> statement-breakpoint
CREATE INDEX `billing_prices_product_id_idx` ON `billing_prices` (`product_id`);--> statement-breakpoint
CREATE TABLE `billing_products` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`product_kind` text NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "billing_products_product_kind_check" CHECK("billing_products"."product_kind" in ('credit_pack', 'subscription'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_products_code_unique` ON `billing_products` (`code`);--> statement-breakpoint
CREATE TABLE `billing_refund_credit_adjustments` (
	`id` text PRIMARY KEY NOT NULL,
	`refund_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`target_quantity` integer NOT NULL,
	`applied_quantity` integer NOT NULL,
	`shortfall_quantity` integer NOT NULL,
	`entitlement_transaction_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`refund_id`) REFERENCES `billing_refunds`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`grant_id`) REFERENCES `entitlement_grants`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`entitlement_transaction_id`) REFERENCES `entitlement_transactions`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "billing_refund_credit_adjustments_quantity_check" CHECK("billing_refund_credit_adjustments"."target_quantity" >= 0
        and "billing_refund_credit_adjustments"."applied_quantity" >= 0
        and "billing_refund_credit_adjustments"."shortfall_quantity" >= 0
        and "billing_refund_credit_adjustments"."target_quantity" = "billing_refund_credit_adjustments"."applied_quantity" + "billing_refund_credit_adjustments"."shortfall_quantity")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_refund_credit_adjustments_refund_grant_unique` ON `billing_refund_credit_adjustments` (`refund_id`,`grant_id`);--> statement-breakpoint
CREATE INDEX `billing_refund_credit_adjustments_refund_id_idx` ON `billing_refund_credit_adjustments` (`refund_id`);--> statement-breakpoint
CREATE INDEX `billing_refund_credit_adjustments_grant_id_idx` ON `billing_refund_credit_adjustments` (`grant_id`);--> statement-breakpoint
CREATE TABLE `billing_refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_refund_id` text,
	`status` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`reason_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`succeeded_at` integer,
	`failed_at` integer,
	FOREIGN KEY (`order_id`) REFERENCES `billing_orders`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "billing_refunds_status_check" CHECK("billing_refunds"."status" in ('pending', 'succeeded', 'failed', 'canceled')),
	CONSTRAINT "billing_refunds_amount_check" CHECK("billing_refunds"."amount" > 0),
	CONSTRAINT "billing_refunds_currency_check" CHECK(length("billing_refunds"."currency") = 3 and "billing_refunds"."currency" = upper("billing_refunds"."currency")),
	CONSTRAINT "billing_refunds_provider_check" CHECK("billing_refunds"."provider" in ('creem'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_refunds_provider_refund_id_unique` ON `billing_refunds` (`provider`,`provider_refund_id`) WHERE "billing_refunds"."provider_refund_id" is not null;--> statement-breakpoint
CREATE INDEX `billing_refunds_order_id_idx` ON `billing_refunds` (`order_id`);--> statement-breakpoint
CREATE INDEX `billing_refunds_status_idx` ON `billing_refunds` (`status`);--> statement-breakpoint
CREATE TABLE `billing_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`product_id` text NOT NULL,
	`price_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`status` text NOT NULL,
	`provider` text NOT NULL,
	`provider_subscription_id` text,
	`current_period_start` integer,
	`current_period_end` integer,
	`billing_interval` text NOT NULL,
	`interval_count` integer NOT NULL,
	`entitlement_snapshot` text NOT NULL,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`canceled_at` integer,
	`ended_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`product_id`) REFERENCES `billing_products`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`price_id`) REFERENCES `billing_prices`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`customer_id`) REFERENCES `billing_customers`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "billing_subscriptions_status_check" CHECK("billing_subscriptions"."status" in ('pending', 'trialing', 'active', 'past_due', 'paused', 'canceled', 'expired')),
	CONSTRAINT "billing_subscriptions_provider_check" CHECK("billing_subscriptions"."provider" in ('creem')),
	CONSTRAINT "billing_subscriptions_interval_check" CHECK("billing_subscriptions"."billing_interval" in ('month', 'year') and "billing_subscriptions"."interval_count" >= 1),
	CONSTRAINT "billing_subscriptions_period_check" CHECK((
        "billing_subscriptions"."current_period_start" is null
        or "billing_subscriptions"."current_period_end" is null
        or "billing_subscriptions"."current_period_end" > "billing_subscriptions"."current_period_start"
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_subscriptions_provider_subscription_id_unique` ON `billing_subscriptions` (`provider`,`provider_subscription_id`) WHERE "billing_subscriptions"."provider_subscription_id" is not null;--> statement-breakpoint
CREATE INDEX `billing_subscriptions_user_id_idx` ON `billing_subscriptions` (`user_id`);--> statement-breakpoint
CREATE INDEX `billing_subscriptions_product_id_idx` ON `billing_subscriptions` (`product_id`);--> statement-breakpoint
CREATE INDEX `billing_subscriptions_price_id_idx` ON `billing_subscriptions` (`price_id`);--> statement-breakpoint
CREATE INDEX `billing_subscriptions_customer_id_idx` ON `billing_subscriptions` (`customer_id`);--> statement-breakpoint
CREATE INDEX `billing_subscriptions_status_idx` ON `billing_subscriptions` (`status`);--> statement-breakpoint
CREATE TABLE `billing_webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`status` text NOT NULL,
	`payload_hash` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	`processed_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT "billing_webhook_events_provider_check" CHECK("billing_webhook_events"."provider" in ('creem')),
	CONSTRAINT "billing_webhook_events_status_check" CHECK("billing_webhook_events"."status" in ('received', 'processing', 'processed', 'failed')),
	CONSTRAINT "billing_webhook_events_attempt_count_check" CHECK("billing_webhook_events"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_webhook_events_provider_event_id_unique` ON `billing_webhook_events` (`provider`,`provider_event_id`);--> statement-breakpoint
CREATE INDEX `billing_webhook_events_status_idx` ON `billing_webhook_events` (`status`);--> statement-breakpoint
CREATE TABLE `entitlement_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`entitlement_key` text NOT NULL,
	`entitlement_type` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`period_key` text NOT NULL,
	`granted_quantity` integer,
	`remaining_quantity` integer,
	`effective_at` integer NOT NULL,
	`expires_at` integer,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "entitlement_grants_type_check" CHECK("entitlement_grants"."entitlement_type" in ('consumable', 'feature', 'limit')),
	CONSTRAINT "entitlement_grants_source_type_check" CHECK("entitlement_grants"."source_type" in ('order', 'subscription_cycle', 'admin', 'migration', 'promotion')),
	CONSTRAINT "entitlement_grants_status_check" CHECK("entitlement_grants"."status" in ('active', 'expired', 'revoked')),
	CONSTRAINT "entitlement_grants_quantity_check" CHECK((
        ("entitlement_grants"."entitlement_type" = 'feature'
          and "entitlement_grants"."granted_quantity" is null
          and "entitlement_grants"."remaining_quantity" is null)
        or ("entitlement_grants"."entitlement_type" in ('consumable', 'limit')
          and "entitlement_grants"."granted_quantity" >= 0
          and "entitlement_grants"."remaining_quantity" >= 0
          and "entitlement_grants"."remaining_quantity" <= "entitlement_grants"."granted_quantity")
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entitlement_grants_source_period_unique` ON `entitlement_grants` (`source_type`,`source_id`,`entitlement_key`,`period_key`);--> statement-breakpoint
CREATE INDEX `entitlement_grants_user_lookup_idx` ON `entitlement_grants` (`user_id`,`entitlement_key`,`status`,`expires_at`,`effective_at`);--> statement-breakpoint
CREATE INDEX `entitlement_grants_user_id_idx` ON `entitlement_grants` (`user_id`);--> statement-breakpoint
CREATE TABLE `entitlement_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`transaction_type` text NOT NULL,
	`quantity` integer NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`balance_before` integer NOT NULL,
	`balance_after` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`grant_id`) REFERENCES `entitlement_grants`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "entitlement_transactions_type_check" CHECK("entitlement_transactions"."transaction_type" in ('grant', 'consume', 'refund', 'expire', 'adjustment', 'revoke')),
	CONSTRAINT "entitlement_transactions_quantity_sign_check" CHECK((
        ("entitlement_transactions"."transaction_type" in ('grant', 'refund') and "entitlement_transactions"."quantity" > 0)
        or ("entitlement_transactions"."transaction_type" in ('consume', 'expire', 'revoke')
          and "entitlement_transactions"."quantity" < 0)
        or ("entitlement_transactions"."transaction_type" = 'adjustment' and "entitlement_transactions"."quantity" != 0)
      )),
	CONSTRAINT "entitlement_transactions_balance_check" CHECK("entitlement_transactions"."balance_after" = "entitlement_transactions"."balance_before" + "entitlement_transactions"."quantity")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entitlement_transactions_idempotency_key_unique` ON `entitlement_transactions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `entitlement_transactions_user_id_idx` ON `entitlement_transactions` (`user_id`);--> statement-breakpoint
CREATE INDEX `entitlement_transactions_grant_id_idx` ON `entitlement_transactions` (`grant_id`);--> statement-breakpoint
CREATE TABLE `product_entitlements` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`entitlement_key` text NOT NULL,
	`entitlement_type` text NOT NULL,
	`quantity` integer,
	`grant_cadence` text NOT NULL,
	`expiration_policy` text NOT NULL,
	`duration_days` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `billing_products`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "product_entitlements_type_check" CHECK("product_entitlements"."entitlement_type" in ('consumable', 'feature', 'limit')),
	CONSTRAINT "product_entitlements_quantity_check" CHECK((
        ("product_entitlements"."entitlement_type" = 'feature' and "product_entitlements"."quantity" is null)
        or ("product_entitlements"."entitlement_type" in ('consumable', 'limit')
          and "product_entitlements"."quantity" > 0)
      )),
	CONSTRAINT "product_entitlements_cadence_check" CHECK("product_entitlements"."grant_cadence" in ('purchase', 'monthly', 'subscription')),
	CONSTRAINT "product_entitlements_expiration_check" CHECK("product_entitlements"."expiration_policy" in ('fixed_duration', 'grant_period_end', 'subscription_end')),
	CONSTRAINT "product_entitlements_pattern_check" CHECK((
        ("product_entitlements"."grant_cadence" = 'purchase'
          and "product_entitlements"."expiration_policy" = 'fixed_duration'
          and "product_entitlements"."duration_days" > 0)
        or ("product_entitlements"."grant_cadence" = 'monthly'
          and "product_entitlements"."expiration_policy" = 'grant_period_end'
          and "product_entitlements"."duration_days" is null)
        or ("product_entitlements"."grant_cadence" = 'subscription'
          and "product_entitlements"."expiration_policy" = 'subscription_end'
          and "product_entitlements"."duration_days" is null)
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_entitlements_product_key_unique` ON `product_entitlements` (`product_id`,`entitlement_key`);--> statement-breakpoint
CREATE INDEX `product_entitlements_product_id_idx` ON `product_entitlements` (`product_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`clerk_user_id` text NOT NULL,
	`primary_email` text,
	`email_verified` integer DEFAULT false NOT NULL,
	`first_name` text,
	`last_name` text,
	`display_name` text,
	`username` text,
	`avatar_url` text,
	`clerk_created_at` integer,
	`clerk_updated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_clerk_user_id_unique` ON `users` (`clerk_user_id`);