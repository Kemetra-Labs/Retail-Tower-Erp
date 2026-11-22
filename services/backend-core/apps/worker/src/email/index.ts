/**
 * The worker's `email` port (RT-1525; RT-1453 port convention): the BullMQ worker factory contract
 * other worker modules share. Import it type-only where a runtime edge to `email/` would close a
 * module cycle (RT-1454).
 */
export { WORKER_FACTORY, type JobLike, type WorkerFactory } from "./email.worker";
