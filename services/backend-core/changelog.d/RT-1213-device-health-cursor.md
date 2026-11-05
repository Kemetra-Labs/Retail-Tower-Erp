### Changed
- RT-1213: the device-health keyset cursor uses a new shared opaque-cursor codec
  (`src/common/cursor/opaque-cursor.ts`: `encodeOpaque`, `decodeOpaque` and an
  `InvalidCursorError` base). Token bytes, the tenant check, accepted ids and the 400
  `validation_error` are unchanged, pinned by a golden spec. Other cursor modules move later.
