### Fixed
- RT-1494: the invitation email (Arabic and English, text and HTML) said the invitation expires
  7 days "after it was sent". Expiry counts from creation, so it now says 7 days after it was
  created. Wording only: the 7-day expiry logic, API and schema are unchanged.
