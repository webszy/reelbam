-- Append-only migration: preserve all original grant, refund, and transaction identities.
ALTER TABLE `entitlement_transactions` ADD COLUMN `ledger_sequence` integer;--> statement-breakpoint
-- Existing rowid order is the insertion order available at this migration boundary.
-- A complete reconciliation is still required before enabling writes on an existing database.
WITH ranked AS (
  SELECT rowid AS rid, row_number() OVER (PARTITION BY grant_id ORDER BY rowid) AS seq
  FROM entitlement_transactions
)
UPDATE entitlement_transactions
SET ledger_sequence = (SELECT seq FROM ranked WHERE ranked.rid = entitlement_transactions.rowid);--> statement-breakpoint
CREATE UNIQUE INDEX `entitlement_transactions_grant_sequence_unique`
ON `entitlement_transactions` (`grant_id`, `ledger_sequence`);--> statement-breakpoint
ALTER TABLE `video_attempts` ADD COLUMN `settlement_event` text;--> statement-breakpoint
ALTER TABLE `video_attempts` ADD COLUMN `settlement_evidence_id` text;--> statement-breakpoint
-- Retain the original constraint name so the existing refund conflict classifier stays retryable.
CREATE TRIGGER `entitlement_grants_strict_quantity_insert`
BEFORE INSERT ON entitlement_grants
FOR EACH ROW
WHEN NOT CASE
  WHEN NEW.entitlement_type = 'feature' THEN NEW.granted_quantity IS NULL AND NEW.remaining_quantity IS NULL
  WHEN NEW.entitlement_type IN ('consumable', 'limit') THEN
    NEW.granted_quantity IS NOT NULL AND typeof(NEW.granted_quantity) = 'integer'
    AND NEW.remaining_quantity IS NOT NULL AND typeof(NEW.remaining_quantity) = 'integer'
    AND NEW.granted_quantity >= 0 AND NEW.remaining_quantity >= 0
    AND NEW.remaining_quantity <= NEW.granted_quantity
  ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'entitlement_grants_quantity_check: credit_grant_quantity_invalid');
END;--> statement-breakpoint
CREATE TRIGGER `entitlement_grants_strict_quantity_update`
BEFORE UPDATE ON entitlement_grants
FOR EACH ROW
WHEN NOT CASE
  WHEN NEW.entitlement_type = 'feature' THEN NEW.granted_quantity IS NULL AND NEW.remaining_quantity IS NULL
  WHEN NEW.entitlement_type IN ('consumable', 'limit') THEN
    NEW.granted_quantity IS NOT NULL AND typeof(NEW.granted_quantity) = 'integer'
    AND NEW.remaining_quantity IS NOT NULL AND typeof(NEW.remaining_quantity) = 'integer'
    AND NEW.granted_quantity >= 0 AND NEW.remaining_quantity >= 0
    AND NEW.remaining_quantity <= NEW.granted_quantity
  ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'entitlement_grants_quantity_check: credit_grant_quantity_invalid');
END;--> statement-breakpoint
-- Fail closed on invalid pre-existing quantities; never silently repair or issue credits.
UPDATE entitlement_grants SET remaining_quantity = remaining_quantity;--> statement-breakpoint
CREATE TRIGGER `entitlement_transactions_sequence_insert`
BEFORE INSERT ON entitlement_transactions
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM entitlement_transactions WHERE id = NEW.id OR idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'ledger_sequence_invalid')
  WHERE NEW.ledger_sequence IS NOT NULL AND (
    typeof(NEW.ledger_sequence) != 'integer'
    OR NEW.ledger_sequence != COALESCE((
      SELECT MAX(ledger_sequence) FROM entitlement_transactions WHERE grant_id = NEW.grant_id
    ), 0) + 1
  );
  SELECT RAISE(ABORT, 'ledger_initial_grant_invalid')
  WHERE NOT EXISTS (SELECT 1 FROM entitlement_transactions WHERE grant_id = NEW.grant_id)
    AND NOT EXISTS (
      SELECT 1 FROM entitlement_grants g WHERE g.id = NEW.grant_id AND g.user_id = NEW.user_id
        AND NEW.transaction_type = 'grant' AND NEW.quantity = g.granted_quantity
        AND NEW.balance_before = 0 AND NEW.balance_after = g.granted_quantity
        AND NEW.source_type = g.source_type AND NEW.source_id = g.source_id
    );
  SELECT RAISE(ABORT, 'ledger_chain_invalid')
  WHERE EXISTS (SELECT 1 FROM entitlement_transactions WHERE grant_id = NEW.grant_id)
    AND (NEW.transaction_type = 'grant' OR NEW.balance_before IS NOT (
      SELECT balance_after FROM entitlement_transactions WHERE grant_id = NEW.grant_id
      ORDER BY ledger_sequence DESC LIMIT 1
    ));
  SELECT RAISE(ABORT, 'ledger_chain_invalid')
  WHERE typeof(NEW.quantity) != 'integer' OR typeof(NEW.balance_before) != 'integer'
    OR typeof(NEW.balance_after) != 'integer' OR NEW.balance_before < 0 OR NEW.balance_after < 0
    OR NOT EXISTS (SELECT 1 FROM entitlement_grants g WHERE g.id = NEW.grant_id AND g.user_id = NEW.user_id);
END;--> statement-breakpoint
CREATE TRIGGER `entitlement_transactions_assign_sequence`
AFTER INSERT ON entitlement_transactions
FOR EACH ROW WHEN NEW.ledger_sequence IS NULL
BEGIN
  UPDATE entitlement_transactions
  SET ledger_sequence = COALESCE((
    SELECT MAX(ledger_sequence) FROM entitlement_transactions WHERE grant_id = NEW.grant_id
  ), 0) + 1
  WHERE rowid = NEW.rowid;
END;--> statement-breakpoint
CREATE TRIGGER `entitlement_transactions_sequence_immutable`
BEFORE UPDATE OF ledger_sequence ON entitlement_transactions
FOR EACH ROW WHEN OLD.ledger_sequence IS NOT NULL AND NEW.ledger_sequence IS NOT OLD.ledger_sequence
BEGIN
  SELECT RAISE(ABORT, 'ledger_sequence_invalid');
END;--> statement-breakpoint
CREATE TRIGGER `video_attempts_settlement_evidence_insert`
BEFORE INSERT ON video_attempts
FOR EACH ROW WHEN NOT (
  (NEW.settlement_event IS NULL AND NEW.settlement_evidence_id IS NULL)
  OR (NEW.settlement_event IS NOT NULL AND NEW.settlement_evidence_id IS NOT NULL
    AND length(trim(NEW.settlement_evidence_id)) > 0 AND NEW.resolved_at IS NOT NULL
    AND ((NEW.settlement_event IN ('submission_rejected', 'recovery_confirmed_absent')
      AND NEW.acceptance_status = 'rejected' AND NEW.provider_request_id IS NULL)
    OR (NEW.settlement_event IN ('provider_failed', 'storage_irrecoverable')
      AND NEW.acceptance_status = 'accepted' AND NEW.provider_request_id IS NOT NULL)))
)
BEGIN
  SELECT RAISE(ABORT, 'attempt_settlement_evidence_invalid');
END;--> statement-breakpoint
CREATE TRIGGER `video_attempts_settlement_evidence_update`
BEFORE UPDATE ON video_attempts
FOR EACH ROW WHEN NOT (
  (NEW.settlement_event IS NULL AND NEW.settlement_evidence_id IS NULL)
  OR (NEW.settlement_event IS NOT NULL AND NEW.settlement_evidence_id IS NOT NULL
    AND length(trim(NEW.settlement_evidence_id)) > 0 AND NEW.resolved_at IS NOT NULL
    AND ((NEW.settlement_event IN ('submission_rejected', 'recovery_confirmed_absent')
      AND NEW.acceptance_status = 'rejected' AND NEW.provider_request_id IS NULL)
    OR (NEW.settlement_event IN ('provider_failed', 'storage_irrecoverable')
      AND NEW.acceptance_status = 'accepted' AND NEW.provider_request_id IS NOT NULL)))
)
BEGIN
  SELECT RAISE(ABORT, 'attempt_settlement_evidence_invalid');
END;
