### Changed
- RT-1456 (audit A-09): the request canonical-JSON serializer moved to `common/hashing/canonical-json.ts`
  and the two undocumented copies in `count-emission` and `offer-pack` now use it. On every JSON-shaped
  value (all that either caller produces) the bytes are identical, pinned by golden vectors written
  before the change, so no stored hash changes (count posting `payloadHash`, offer Pack ETag). The three
  documented serializers stay as named variants (`canonicalJson`, `canonicalJsonPayload`,
  `canonicalRevisionJson`, the last renamed from `canonicalJson`), per RT-1214. No route, contract or
  table change.
