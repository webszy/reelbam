-- 0001 already created video_provider_costs. SQLite cannot replace a CHECK in place,
-- and that migration is not rewritten. This rebuild keeps every legal row and
-- rejects known costs whose amount or currency is NULL, non-integer, negative,
-- or not three uppercase letters. unknown/NULL and known 0 stay legal.
CREATE TABLE `video_provider_costs__strict` (
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
	CONSTRAINT "video_provider_costs_kind_check" CHECK("video_provider_costs__strict"."cost_kind" in ('estimated', 'actual', 'unknown')),
	CONSTRAINT "video_provider_costs_unit_check" CHECK("video_provider_costs__strict"."amount_unit" in ('micro')),
	CONSTRAINT "video_provider_costs_provider_check" CHECK(length("video_provider_costs__strict"."provider_id") > 0),
	CONSTRAINT "video_provider_costs_source_check" CHECK(length("video_provider_costs__strict"."source") > 0),
	CONSTRAINT "video_provider_costs_bill_check" CHECK("video_provider_costs__strict"."provider_bill_id" is null or length("video_provider_costs__strict"."provider_bill_id") > 0),
	CONSTRAINT "video_provider_costs_amount_check" CHECK(case
        when "video_provider_costs__strict"."cost_kind" = 'unknown'
          then "video_provider_costs__strict"."amount_micros" is null
           and "video_provider_costs__strict"."currency" is null
        when "video_provider_costs__strict"."cost_kind" in ('estimated', 'actual')
          then "video_provider_costs__strict"."amount_micros" is not null
           and typeof("video_provider_costs__strict"."amount_micros") = 'integer'
           and "video_provider_costs__strict"."amount_micros" >= 0
           and "video_provider_costs__strict"."currency" is not null
           and "video_provider_costs__strict"."currency" glob '[A-Z][A-Z][A-Z]'
        else 0
      end)
);--> statement-breakpoint
INSERT INTO `video_provider_costs__strict` (`id`, `attempt_id`, `provider_id`, `cost_kind`, `amount_micros`, `currency`, `amount_unit`, `source`, `provider_bill_id`, `observed_at`, `created_at`)
SELECT `id`, `attempt_id`, `provider_id`, `cost_kind`, `amount_micros`, `currency`, `amount_unit`, `source`, `provider_bill_id`, `observed_at`, `created_at`
FROM `video_provider_costs`;--> statement-breakpoint
DROP TABLE `video_provider_costs`;--> statement-breakpoint
ALTER TABLE `video_provider_costs__strict` RENAME TO `video_provider_costs`;--> statement-breakpoint
CREATE UNIQUE INDEX `video_provider_costs_attempt_kind_unique` ON `video_provider_costs` (`attempt_id`,`cost_kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `video_provider_costs_provider_bill_unique` ON `video_provider_costs` (`provider_id`,`provider_bill_id`) WHERE "video_provider_costs"."provider_bill_id" is not null;--> statement-breakpoint
CREATE INDEX `video_provider_costs_attempt_idx` ON `video_provider_costs` (`attempt_id`);--> statement-breakpoint
-- Cap is enforced inside the return batch, not by a 0-row INSERT filter.
-- RAISE(ABORT) rolls the whole D1 batch back. The writer then re-reads.
CREATE TRIGGER `billing_refund_credit_settlements_guard_insert`
BEFORE INSERT ON `billing_refund_credit_settlements`
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'settlement_grant_mismatch')
  WHERE (
    SELECT `grant_id` FROM `billing_refund_credit_adjustments` WHERE `id` = NEW.`adjustment_id`
  ) IS NOT NEW.`grant_id`;
  SELECT RAISE(ABORT, 'settlement_exceeds_shortfall')
  WHERE (
    SELECT COALESCE(SUM(`quantity`), 0)
    FROM `billing_refund_credit_settlements`
    WHERE `adjustment_id` = NEW.`adjustment_id`
  ) + NEW.`quantity` > (
    SELECT `shortfall_quantity`
    FROM `billing_refund_credit_adjustments`
    WHERE `id` = NEW.`adjustment_id`
      AND `grant_id` = NEW.`grant_id`
  );
  SELECT RAISE(ABORT, 'settlement_operation_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM `video_credit_operations`
    WHERE `id` = NEW.`return_operation_id`
      AND `operation_type` = 'return'
      AND `status` = 'completed'
  );
  SELECT RAISE(ABORT, 'settlement_clawback_mismatch')
  WHERE (
    SELECT COALESCE(SUM(`quantity`), 0)
    FROM `billing_refund_credit_settlements`
    WHERE `return_operation_id` = NEW.`return_operation_id`
      AND `grant_id` = NEW.`grant_id`
  ) + NEW.`quantity` > COALESCE((
    SELECT -`quantity`
    FROM `entitlement_transactions`
    WHERE `source_type` = 'video_generation_return_clawback'
      AND `transaction_type` = 'revoke'
      AND `grant_id` = NEW.`grant_id`
      AND `source_id` = (
        SELECT `generation_id` FROM `video_credit_operations` WHERE `id` = NEW.`return_operation_id`
      )
      AND `idempotency_key` = 'entitlement:video_generation:' || (
        SELECT `generation_id` FROM `video_credit_operations` WHERE `id` = NEW.`return_operation_id`
      ) || ':grant:' || NEW.`grant_id` || ':clawback'
  ), -1);
END;