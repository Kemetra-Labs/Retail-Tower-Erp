/**
 * The worker's `pos-cashier-admissions` port (RT-1551; RT-1453 port convention). Other worker modules import from here,
 * never from the files inside.
 */
export { REPLAY_PURGE_JOB_NAME } from "./replay-purge.processor";
