### Changed
- RT-1439 `[GATED: contract]`: `DELETE /api/v1/stores/{store_id}` (`softDeleteStore`) now
  runs the same four deletion guards as `consoleDeleteStore` (409 `store_has_open_shift`,
  `store_has_unretired_device`, `store_device_queue_unsynced`, `store_has_open_count_session`,
  with `error.details.blockers`) and writes one `store.deleted` audit event
  (`channel: "api"`), as documented in 1.3.0-draft. A store with an open shift, a
  non-retired device, a non-zero or unknown sale queue or an open Count Session is no longer
  deletable through this route. Its roles (owner and `tenant_admin`) and the absence of a
  reason and a re-authentication are unchanged; closing that is a separate contract change.
