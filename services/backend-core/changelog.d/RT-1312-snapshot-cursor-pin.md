### Fixed
- RT-1312 (F19, RT447-F05): the catalog snapshot keeps one cursor across all its pages. The page
  token now carries the change-log head pinned on the first page, so a catalog edit during a
  multi-page walk no longer changes the cursor (the POS rejected such a walk and kept its old
  catalog for another hour). A page token issued before this change still continues at the
  current head. The token stays opaque; no contract change.
