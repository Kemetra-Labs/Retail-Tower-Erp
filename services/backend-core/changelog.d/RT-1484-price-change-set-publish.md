### Added
- RT-1484 `[GATED: contract]` (RT-282 PR-10b, PR-5), owner authorization on RT-1484 (comment
  17829 and the lead's decisions in comments 17875, 17881 and 17882): the runtime of
  `consoleSubmitPriceChangeSet`, `consoleApprovePriceChangeSet`, `consoleRejectPriceChangeSet`
  and `consolePublishPriceChangeSet` in `pricing/price-change-sets.yaml` 1.0.0-draft, which lose
  their `x-runtime-status: contract-only` markers (rollback stays contract-only for PR-6).
  Submit and approve check `expectedVersion`, the blocking findings and the acknowledgements, and
  approve is bound to the shown `previewHash` (409 `preview_changed`); a sensitive set (every set
  in v1, approval mode `always`) needs an approver other than its author and submitter (403
  `self_approval_forbidden`), the emergency path included. Submit, approve and publish re-check
  staleness (a later intersecting revision, or a changed target Store set): a stale set returns
  to `draft` at version + 1 and answers 409 `stale_validation`. Publish runs under the tenant's
  pricing publish lock and writes exactly one immutable Pricing Revision: the replaced events and
  memberships end, their uncovered parts are carried forward, the new events and memberships, the
  per-line record (`new_event_id`, `result_ids`) and the Store fan-out are written, and published
  sets whose rows are all ended become `superseded`; one audit row per transition. Store
  lifecycle writes (create, activation, deactivation, deletion, time-zone change) now take the
  same lock first, and a created or activated Store gets its `pricing_revision_stores` bootstrap
  row at the head revision (spec 041 data-model §2.6). No `price_history` write and no
  `pricing.revision.published` outbox event (RT-1486). No migration, grant or dependency change.
