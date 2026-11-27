-- 0138_erp_provisioning_request_rotation_key_idx.down.sql — reverses 0138 (RT-1362 S2). Run 0139 down first: its
-- pending FK depends on this index. One statement (see 0137 down); IF EXISTS so a rollback after a failed build
-- still completes.
DROP INDEX CONCURRENTLY IF EXISTS uq_erp_provisioning_request_rotation_key;
