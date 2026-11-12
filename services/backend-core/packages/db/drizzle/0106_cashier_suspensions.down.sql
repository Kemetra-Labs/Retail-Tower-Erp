-- 0106_cashier_suspensions.down.sql - reverses 0106_cashier_suspensions.sql (RT-1138).
--
-- Drops ONLY the `cashier_suspensions` table (its policies and constraints go
-- with it). SAFETY (fail-open): dropping the table makes every suspended
-- cashier admissible again, so this refuses while any cashier is still
-- suspended. Reactivate them first (or accept the loss deliberately by
-- deleting the rows as the migration owner). Roll back the RT-1138 API first;
-- with the table gone, the suspension routes, the admission check and the
-- cashier roster return 500.

BEGIN;

DO $$
BEGIN
  IF to_regclass('cashier_suspensions') IS NOT NULL
     AND EXISTS (SELECT 1 FROM cashier_suspensions WHERE status = 'suspended') THEN
    RAISE EXCEPTION '0106 down refused: cashier_suspensions still holds suspended cashiers; reactivate them first'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

DROP TABLE IF EXISTS cashier_suspensions;

COMMIT;
