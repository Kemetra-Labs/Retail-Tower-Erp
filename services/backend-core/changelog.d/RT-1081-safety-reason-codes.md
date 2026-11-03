### Changed
- RT-1081 TR-5 (owner decisions RT-972 c14943, OD-4, OD-7; breaking request
  change, acknowledged in `tools/oasdiff/breaking-ignore.txt`):
  `placeQualityHold`, `createInventoryRecall` and
  `correctTrackingIdentityExpiry` accept only `SafetyReasonCodeInput`
  (`supplier_notice`, `authority_notice`, `label_misprint`, `other`); `other`
  without a non-empty note is a 400 and writes nothing. Projections keep the
  `SafetyReasonCode` pattern, so a recorded code still reads back.
