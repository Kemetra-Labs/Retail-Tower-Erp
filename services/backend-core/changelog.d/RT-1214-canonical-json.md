### Changed
- RT-1214: the settlement-intent request hash now uses the shared payload-hash
  serializer (`canonicalJsonPayload`) instead of a private copy. Stored bytes
  are unchanged (golden vectors). The three canonical-JSON serializers kept on
  purpose (payload hash, idempotency request, entitlement content) now
  document why they differ and which persisted columns depend on each.
