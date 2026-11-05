### Changed
- RT-1224 (RT-148 H-7): `SalesService.captureSale` is split into named steps
  (`validateSaleTotals`, `resolveStoreTimezone`, `insertSaleHeader`,
  `resolveReplay`, `insertCaptureRows`, `emitSaleCaptured`) inside the one
  capture transaction. No behaviour change: golden `payload_hash` vectors and a
  characterization matrix pin the bytes, replay answers and rows written.
