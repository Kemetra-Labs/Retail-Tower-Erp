### Fixed
- RT-612: a NUL (`\u0000`) inside a JSON string value written to a jsonb
  column makes Postgres raise 22P05 (untranslatable_character). The API now
  answers it with the 400 `validation_error` envelope, not a 500, next to the
  22021 mapping from Kemetra/Backend-Core#846.
