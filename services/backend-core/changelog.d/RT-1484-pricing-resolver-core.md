### Added
- RT-1484 (RT-282 PR-08a): the pure Retail Pricing resolver in
  `apps/api/src/pricing/resolution/` (spec 041 §4.2-4.4). Store > Zone (the
  membership visible at `asOfRevision`, else the Book's default Zone) > Book;
  overlaps and ambiguous Zone memberships are errors; `no_price`,
  `no_price_book` and `not_representable`; Store-local bounds with the Q-2 DST
  rule. No route, contract or database change; nothing calls it yet.
