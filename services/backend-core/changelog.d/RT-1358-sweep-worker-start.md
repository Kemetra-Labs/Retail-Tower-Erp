### Fixed
- RT-1358: the worker now starts `ProvisioningSweepWorker` at bootstrap. Its scheduler registered the
  `erp-provisioning-sweep` job, but nothing consumed the queue, so expired provisioning leases were
  never reclaimed and `verifying` requests never advanced (found by RT-1400: the queue lag grew one
  second per second on the lab after the v0.14.0 deploy). A new `main.spec.ts` guard fails when any
  `RepeatableWorker` registered in `WorkerModule` is not started.
