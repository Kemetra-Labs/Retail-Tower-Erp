### Changed
- RT-1453: store deletion (preview and write) reads a store's devices and last stored sale queues through a new
  `device-health` port (`readStoreDeviceFacts`, over the same read model as the fleet-health list) and its open
  Count Sessions through a new `inventory` port (`countOpenCountSessionsOfStore`, `listOpenCountSessionsOfStore`),
  both on the caller's client, instead of querying `devices`, `device_health` and `count_sessions` and importing the
  open-state list itself. The device counts (total, unretired, unsynced) are now derived from the same rows the
  preview lists. No HTTP contract change.
