### Changed
- RT-1444 `[GATED: contract]`: `DELETE /api/v1/stores/{store_id}`
  (`softDeleteStore`) gets the same four guards as the new store deletion (409
  `store_has_open_shift`, `store_has_unretired_device`,
  `store_device_queue_unsynced`, `store_has_open_count_session`) and a
  `store.deleted` audit event, from the RT-1439 runtime. A behaviour change on
  an existing operation: the contract documents it, the runtime is not changed
  by this entry.
