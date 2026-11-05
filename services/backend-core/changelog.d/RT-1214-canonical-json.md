### Changed
- RT-1214: the settlement-intent request hash now uses the shared payload-hash
  serializer (`canonicalJsonPayload`) instead of a private copy. Stored bytes
  are unchanged (golden vectors). The two intentional canonical-JSON variants
  (request and entitlement content) now document why they differ.
