/**
 * The worker's `memberships` port (RT-1525; RT-1453 port convention). Other worker modules read
 * memberships, roles and store access through here, never with their own SQL.
 */
export { storeAlertRecipientUserIds } from "./store-alert-recipients";
