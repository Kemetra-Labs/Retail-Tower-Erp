### Added
- RT-1362 S2 `[GATED: migration]`, owner authorization on RT-1362 comments 19102 and 19107: the storage of
  overlap credential rotation, in six short migrations. 0136 adds the routed host label and trigger of a
  `credential.rotate` request and the provisioner host binding of an adopted registration (label, `provisional` or
  `confirmed`, revision); 0137 (CONCURRENTLY) allows at most one open `credential.rotate` request per registration;
  0138 (CONCURRENTLY) adds the request key the pending FK targets; 0139 adds the pending marker on `auth_tokens`
  (request id and kind), whose FK names only a `credential.rotate` request of the same tenant and registration;
  0140 and 0141 (CONCURRENTLY) add at most one current and at most one pending connector credential per
  registration. The 0021 one-unrevoked-credential index stays, so no pending credential can be written yet: a later
  change drops it once the readers handle two unrevoked credentials. Deploy the API of this change together with its
  migrations (a second manual credential issue may report the new index name). No behaviour changes.
