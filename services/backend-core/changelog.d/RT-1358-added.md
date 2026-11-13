### Added
- RT-1358 `[GATED: contract]` (RT-1352 PB-C): the ERP provisioning service on the
  0109 storage, behind the provisioner bearer. It adds:
  - the unlock trigger: the RT-1353 unlock request now also creates, in the
    same transaction, the tenant's managed connector registration and one
    `erp_provisioning_request`. A deployment with no `DEPLOYMENT_ENVIRONMENT`
    answers 503 `service_unavailable` before any write;
  - the four feed operations of `provisioning-feed.yaml` (pull, step
    acknowledgement, credential issue, outcome) and the three platform-admin
    provisioner credential routes (issue, rotate, revoke by host label), so the
    seven operations lose `x-runtime-status: contract-only`;
  - the bearer verifier: the scope `connector_provisioner` stays out of the
    shared bearer scopes. `app.is_provisioner` is set in one file only and never
    together with `app.is_platform_admin`;
  - the state machine, with a version check, a 15-minute lease (renewed only by a
    non-replayed acknowledgement), the attempt floor, a 1/5/15-minute transient
    backoff and a `capacity` hold that never fails the request;
  - the lease-bound credential issue: managed registrations only, audited with
    the request id, the secret returned once and never stored, a repeat for a
    never-presented credential rotates it, 365-day expiry (OD-5 stopgap);
  - the managed-registration guard: owners and tenant admins cannot issue,
    rotate, revoke or disable a managed registration (the same 404 as an absent
    one); platform admins can;
  - the worker's `erp-provisioning-sweep`: it reclaims expired leases and holds a
    reported `succeeded` request in `verifying` until the first heartbeat (30
    minutes at most) before recording it.

  RT-1353 changes: mark-provisioned answers 423 `provisioning_in_progress` while
  a lease is live, and cancels an open request when it succeeds. The automated
  flip to `unrestricted` is NOT built: it waits for the per-store ERP-ready gate
  (RT-1361), so a platform admin still lifts the restriction by hand.
  No migration. The Connector provisioner (RT-1359) is still to consume the feed.
