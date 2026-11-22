/**
 * The worker's `catalog` port (RT-1525; RT-1453 port convention). Other worker modules read catalog
 * tables (postings, sales) through here, never with their own SQL.
 */
export {
  syncFailureCounts,
  syncFailurePresent,
  type SyncFailureConditionKey,
  type SyncFailureCount,
} from "./sync-failure-observation";
