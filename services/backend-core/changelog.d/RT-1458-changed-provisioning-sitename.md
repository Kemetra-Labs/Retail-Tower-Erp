### Changed
- RT-1458 `[GATED: contract]`, owner audit follow-up A-12: the `siteName` of the provisioning
  feed's `ProvisioningRequest` (`erpnext-connector/provisioning-feed.yaml`) is bounded to a DNS
  label (`maxLength` 63, was 128) and states the Connector provisioner's pattern
  `^t[0-9a-f]{20}[a-z0-9.-]*$`, so a value the contract allowed can no longer be one the provisioner
  refuses mid-provisioning. Backend-Core's derived name (`t` + 20 hex digits + `-` + environment,
  at most 29 characters) already satisfies both; a unit test proves it against the contract itself.
  The response is narrower, which is not breaking for the Connector. Contract `info.version` unchanged.
