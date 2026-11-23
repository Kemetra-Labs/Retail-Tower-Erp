### Fixed
- RT-1560: the lab deploy SSM document (`deploy/lab/ssm/RT-BackendLabDeploy.yaml`) now runs all four
  Deploy step 4 catch-up scripts, adding the ERP provisioning host-label (0113) and Price Change Set
  rollback start (0128) ones, before and again after the new API starts. A rollback Change Set the
  previous API created during the deploy is no longer left with NULL `rollback_from` (409 on `validate`).
  New `catch-up-rows` and `post-start-catch-up-rows` gate lines report `host_labels_moved` and
  `rollback_sets_filled`.
