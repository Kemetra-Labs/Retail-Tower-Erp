### Fixed
- RT-1530 (RT-1484 follow-up of #749 review m4): a published Price Change Set's
  `publicationStatus` is computed at read time from each targeted Store's current time
  zone (spec 042 §3), not from the instants stored at validation. A Store time-zone
  change after publish now moves the activation of its `store_local` lines in the
  displayed status. A deleted Store no longer counts. Display only: the resolver reads
  the published events. No contract, migration or dependency change.
