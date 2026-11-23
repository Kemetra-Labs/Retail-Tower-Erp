### Changed
- RT-1558: `deploy/apply-domain-grants.sh` (release step 2) now requires
  `LOOKUP_DB_ROLE`, the `AUTH_LOOKUP_DATABASE_URL` role name, and passes it to every
  grant script as `-v lookup_role`. The lookup-role checks in the cashier-admission,
  shift cash-up and catalog-import grant scripts therefore run on every release and
  stop it before the API starts; the manual pre-0124 run is gone. Add
  `LOOKUP_DB_ROLE` to `deploy/grants.env` (it must differ from `DOMAIN_DB_ROLE`)
  before the first release that carries this change, or step 2 stops and grants nothing.
