CREATE TABLE `video_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`content_hash` text NOT NULL,
	`hash_algorithm` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "video_assets_kind_check" CHECK("video_assets"."kind" in ('image', 'reference_video', 'output_video', 'mock_fixture')),
	CONSTRAINT "video_assets_status_check" CHECK("video_assets"."status" in ('pending', 'available', 'expired', 'deleted')),
	CONSTRAINT "video_assets_byte_size_check" CHECK("video_assets"."byte_size" >= 0),
	CONSTRAINT "video_assets_hash_algorithm_check" CHECK("video_assets"."hash_algorithm" in ('sha256')),
	CONSTRAINT "video_assets_content_hash_check" CHECK(length("video_assets"."content_hash") = 64),
	CONSTRAINT "video_assets_object_key_check" CHECK(length("video_assets"."object_key") > 0),
	CONSTRAINT "video_assets_content_type_check" CHECK(length("video_assets"."content_type") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_assets_object_key_unique` ON `video_assets` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `video_assets_id_user_id_unique` ON `video_assets` (`id`,`user_id`);--> statement-breakpoint
CREATE INDEX `video_assets_user_created_idx` ON `video_assets` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `video_assets_user_status_idx` ON `video_assets` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `video_generations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`canonical_input_hash` text NOT NULL,
	`canonical_input` text NOT NULL,
	`route_snapshot_version` integer NOT NULL,
	`route_snapshot` text NOT NULL,
	`quoted_credits` integer NOT NULL,
	`quote_snapshot` text NOT NULL,
	`mode` text NOT NULL,
	`image_asset_id` text,
	`reference_video_asset_id` text,
	`status` text NOT NULL,
	`status_version` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	`output_asset_id` text,
	`error_code` text,
	`error_at` integer,
	`terminal_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "video_generations_image_owner_fk" FOREIGN KEY (`image_asset_id`,`user_id`) REFERENCES `video_assets`(`id`,`user_id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "video_generations_reference_owner_fk" FOREIGN KEY (`reference_video_asset_id`,`user_id`) REFERENCES `video_assets`(`id`,`user_id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "video_generations_output_owner_fk" FOREIGN KEY (`output_asset_id`,`user_id`) REFERENCES `video_assets`(`id`,`user_id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "video_generations_status_check" CHECK("video_generations"."status" in ('queued', 'submitting', 'submission_unknown', 'processing', 'storing', 'succeeded', 'failed', 'needs_review')),
	CONSTRAINT "video_generations_mode_check" CHECK("video_generations"."mode" in ('text-to-video', 'image-to-video', 'reference-to-video')),
	CONSTRAINT "video_generations_mode_assets_check" CHECK((
        ("video_generations"."mode" = 'text-to-video' and "video_generations"."image_asset_id" is null and "video_generations"."reference_video_asset_id" is null)
        or ("video_generations"."mode" = 'image-to-video' and "video_generations"."image_asset_id" is not null and "video_generations"."reference_video_asset_id" is null)
        or ("video_generations"."mode" = 'reference-to-video' and "video_generations"."image_asset_id" is not null and "video_generations"."reference_video_asset_id" is not null)
      )),
	CONSTRAINT "video_generations_idempotency_key_check" CHECK(length("video_generations"."idempotency_key") > 0),
	CONSTRAINT "video_generations_input_hash_check" CHECK(length("video_generations"."canonical_input_hash") = 64),
	CONSTRAINT "video_generations_route_version_check" CHECK("video_generations"."route_snapshot_version" >= 1),
	CONSTRAINT "video_generations_quoted_credits_check" CHECK("video_generations"."quoted_credits" >= 0),
	CONSTRAINT "video_generations_status_version_check" CHECK("video_generations"."status_version" >= 1),
	CONSTRAINT "video_generations_terminal_check" CHECK((
        ("video_generations"."status" in ('succeeded', 'failed') and "video_generations"."terminal_at" is not null)
        or ("video_generations"."status" not in ('succeeded', 'failed') and "video_generations"."terminal_at" is null)
      )),
	CONSTRAINT "video_generations_error_check" CHECK((
        ("video_generations"."status" in ('failed', 'needs_review') and "video_generations"."error_code" is not null and "video_generations"."error_at" is not null)
        or ("video_generations"."status" not in ('failed', 'needs_review') and "video_generations"."error_code" is null and "video_generations"."error_at" is null)
      )),
	CONSTRAINT "video_generations_output_check" CHECK("video_generations"."status" != 'succeeded' or "video_generations"."output_asset_id" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_generations_user_idempotency_key_unique` ON `video_generations` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `video_generations_user_created_idx` ON `video_generations` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `video_generations_status_deadline_idx` ON `video_generations` (`status`,`deadline_at`);--> statement-breakpoint
CREATE TABLE `video_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`generation_id` text NOT NULL,
	`step_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`submit_key` text NOT NULL,
	`provider_id` text NOT NULL,
	`provider_request_id` text,
	`request_payload_hash` text,
	`acceptance_status` text NOT NULL,
	`lease_owner` text,
	`lease_token` text,
	`lease_until` integer,
	`recovery_metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`submitted_at` integer,
	`resolved_at` integer,
	FOREIGN KEY (`generation_id`) REFERENCES `video_generations`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "video_attempts_attempt_number_check" CHECK("video_attempts"."attempt_number" >= 1),
	CONSTRAINT "video_attempts_step_id_check" CHECK(length("video_attempts"."step_id") > 0),
	CONSTRAINT "video_attempts_submit_key_check" CHECK(length("video_attempts"."submit_key") > 0),
	CONSTRAINT "video_attempts_provider_id_check" CHECK(length("video_attempts"."provider_id") > 0),
	CONSTRAINT "video_attempts_acceptance_check" CHECK("video_attempts"."acceptance_status" in ('not_submitted', 'accepted', 'rejected', 'unknown')),
	CONSTRAINT "video_attempts_request_id_check" CHECK((
        ("video_attempts"."acceptance_status" = 'accepted' and "video_attempts"."provider_request_id" is not null)
        or ("video_attempts"."acceptance_status" in ('not_submitted', 'rejected', 'unknown') and "video_attempts"."provider_request_id" is null)
      )),
	CONSTRAINT "video_attempts_payload_hash_check" CHECK("video_attempts"."request_payload_hash" is null or length("video_attempts"."request_payload_hash") = 64),
	CONSTRAINT "video_attempts_lease_check" CHECK((
        ("video_attempts"."lease_owner" is null and "video_attempts"."lease_token" is null and "video_attempts"."lease_until" is null)
        or ("video_attempts"."lease_owner" is not null and "video_attempts"."lease_token" is not null and "video_attempts"."lease_until" is not null)
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_attempts_generation_step_attempt_unique` ON `video_attempts` (`generation_id`,`step_id`,`attempt_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `video_attempts_submit_key_unique` ON `video_attempts` (`submit_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `video_attempts_provider_request_unique` ON `video_attempts` (`provider_id`,`provider_request_id`) WHERE "video_attempts"."provider_request_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `video_attempts_one_open_step_unique` ON `video_attempts` (`generation_id`,`step_id`) WHERE "video_attempts"."acceptance_status" in ('not_submitted', 'unknown', 'accepted');--> statement-breakpoint
CREATE INDEX `video_attempts_generation_acceptance_idx` ON `video_attempts` (`generation_id`,`acceptance_status`);--> statement-breakpoint
CREATE INDEX `video_attempts_lease_until_idx` ON `video_attempts` (`lease_until`);--> statement-breakpoint
CREATE TABLE `video_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`generation_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload_version` integer NOT NULL,
	`payload` text NOT NULL,
	`not_before` integer NOT NULL,
	`delivery_status` text NOT NULL,
	`lease_owner` text,
	`lease_token` text,
	`lease_until` integer,
	`delivery_attempt_count` integer DEFAULT 0 NOT NULL,
	`next_retry_at` integer,
	`last_error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`generation_id`) REFERENCES `video_generations`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "video_outbox_event_type_check" CHECK("video_outbox"."event_type" in ('start_submission', 'poll_status', 'store_output')),
	CONSTRAINT "video_outbox_payload_version_check" CHECK("video_outbox"."payload_version" >= 1),
	CONSTRAINT "video_outbox_delivery_status_check" CHECK("video_outbox"."delivery_status" in ('pending', 'leased', 'delivered', 'dead')),
	CONSTRAINT "video_outbox_attempt_count_check" CHECK("video_outbox"."delivery_attempt_count" >= 0),
	CONSTRAINT "video_outbox_lease_check" CHECK((
        ("video_outbox"."delivery_status" = 'leased' and "video_outbox"."lease_owner" is not null and "video_outbox"."lease_token" is not null and "video_outbox"."lease_until" is not null)
        or ("video_outbox"."delivery_status" != 'leased' and "video_outbox"."lease_owner" is null and "video_outbox"."lease_token" is null and "video_outbox"."lease_until" is null)
      )),
	CONSTRAINT "video_outbox_delivered_check" CHECK((
        ("video_outbox"."delivery_status" = 'delivered' and "video_outbox"."delivered_at" is not null)
        or ("video_outbox"."delivery_status" != 'delivered' and "video_outbox"."delivered_at" is null)
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_outbox_inflight_unique` ON `video_outbox` (`generation_id`,`event_type`) WHERE "video_outbox"."delivery_status" in ('pending', 'leased');--> statement-breakpoint
CREATE INDEX `video_outbox_delivery_due_idx` ON `video_outbox` (`delivery_status`,`not_before`,`next_retry_at`);--> statement-breakpoint
CREATE TABLE `video_credit_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`generation_id` text NOT NULL,
	`operation_type` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`intended_quantity` integer NOT NULL,
	`spendable_quantity` integer NOT NULL,
	`expired_quantity` integer NOT NULL,
	`clawback_quantity` integer NOT NULL,
	`forfeited_quantity` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`generation_id`) REFERENCES `video_generations`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "video_credit_operations_type_check" CHECK("video_credit_operations"."operation_type" in ('consume', 'return')),
	CONSTRAINT "video_credit_operations_status_check" CHECK("video_credit_operations"."status" in ('completed')),
	CONSTRAINT "video_credit_operations_key_check" CHECK(length("video_credit_operations"."idempotency_key") > 0),
	CONSTRAINT "video_credit_operations_quantity_check" CHECK("video_credit_operations"."intended_quantity" >= 0
        and "video_credit_operations"."spendable_quantity" >= 0
        and "video_credit_operations"."expired_quantity" >= 0
        and "video_credit_operations"."clawback_quantity" >= 0
        and "video_credit_operations"."forfeited_quantity" >= 0
        and "video_credit_operations"."intended_quantity" = "video_credit_operations"."spendable_quantity" + "video_credit_operations"."expired_quantity" + "video_credit_operations"."clawback_quantity" + "video_credit_operations"."forfeited_quantity"),
	CONSTRAINT "video_credit_operations_consume_shape_check" CHECK("video_credit_operations"."operation_type" != 'consume'
        or (
          "video_credit_operations"."expired_quantity" = 0
          and "video_credit_operations"."clawback_quantity" = 0
          and "video_credit_operations"."forfeited_quantity" = 0
          and "video_credit_operations"."spendable_quantity" = "video_credit_operations"."intended_quantity"
        ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_credit_operations_idempotency_key_unique` ON `video_credit_operations` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `video_credit_operations_generation_type_unique` ON `video_credit_operations` (`generation_id`,`operation_type`);--> statement-breakpoint
CREATE TABLE `video_provider_costs` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`cost_kind` text NOT NULL,
	`amount_micros` integer,
	`currency` text,
	`amount_unit` text NOT NULL,
	`source` text NOT NULL,
	`provider_bill_id` text,
	`observed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `video_attempts`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "video_provider_costs_kind_check" CHECK("video_provider_costs"."cost_kind" in ('estimated', 'actual', 'unknown')),
	CONSTRAINT "video_provider_costs_unit_check" CHECK("video_provider_costs"."amount_unit" in ('micro')),
	CONSTRAINT "video_provider_costs_provider_check" CHECK(length("video_provider_costs"."provider_id") > 0),
	CONSTRAINT "video_provider_costs_source_check" CHECK(length("video_provider_costs"."source") > 0),
	CONSTRAINT "video_provider_costs_bill_check" CHECK("video_provider_costs"."provider_bill_id" is null or length("video_provider_costs"."provider_bill_id") > 0),
	CONSTRAINT "video_provider_costs_amount_check" CHECK((
        ("video_provider_costs"."cost_kind" = 'unknown' and "video_provider_costs"."amount_micros" is null and "video_provider_costs"."currency" is null)
        or ("video_provider_costs"."cost_kind" in ('estimated', 'actual')
          and "video_provider_costs"."amount_micros" >= 0
          and length("video_provider_costs"."currency") = 3
          and "video_provider_costs"."currency" = upper("video_provider_costs"."currency"))
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_provider_costs_attempt_kind_unique` ON `video_provider_costs` (`attempt_id`,`cost_kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `video_provider_costs_provider_bill_unique` ON `video_provider_costs` (`provider_id`,`provider_bill_id`) WHERE "video_provider_costs"."provider_bill_id" is not null;--> statement-breakpoint
CREATE INDEX `video_provider_costs_attempt_idx` ON `video_provider_costs` (`attempt_id`);--> statement-breakpoint
CREATE TABLE `billing_refund_credit_settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`adjustment_id` text NOT NULL,
	`return_operation_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`adjustment_id`) REFERENCES `billing_refund_credit_adjustments`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`return_operation_id`) REFERENCES `video_credit_operations`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`grant_id`) REFERENCES `entitlement_grants`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "billing_refund_credit_settlements_quantity_check" CHECK("billing_refund_credit_settlements"."quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_refund_credit_settlements_adjustment_return_unique` ON `billing_refund_credit_settlements` (`adjustment_id`,`return_operation_id`);--> statement-breakpoint
CREATE INDEX `billing_refund_credit_settlements_return_idx` ON `billing_refund_credit_settlements` (`return_operation_id`);--> statement-breakpoint
CREATE INDEX `billing_refund_credit_settlements_grant_idx` ON `billing_refund_credit_settlements` (`grant_id`);
