# `recordReturn` commit bound (RT-1548, BR-7) and its deployment assumption

Status of the assumption for the lab and for production: **NOT VERIFIED from
the repository** (evidence below). Until it is verified, and until the bound is
live on every instance that serves `recordReturn`, the status read stays off:
leave `POS_RETURN_STATUS_READ_ENABLED` unset.

## What the bound is

`recordReturn` (`POST /api/pos/v1/sales/{saleRef}/returns`) issues **no COMMIT
later than 60 seconds after it received the request**, and a request that runs
out of budget is rolled back and records nothing (contract `pos-sales/sales.yaml`
1.28.0-draft, `recordReturn` "Late-commit bound"; RT-196 design spec section 4,
BR-7). That bound is what lets `readReturnStatusByProvenance` answer an
affirmative `not_recorded`: once a client has been quiet for its own quiet period
(the POS: 15 minutes), no request it sent has a COMMIT still to be issued.

It is a bound on **issuing** the COMMIT. How long the database takes to finish a
COMMIT it was sent is not bounded by this code; that is what the deployment
assumption below is for.

## Where it is enforced (PostgreSQL 16 has no `transaction_timeout`)

| Step | Code |
| --- | --- |
| The budget, one named constant: `RETURN_COMMIT_BUDGET_MS = 60_000` | `apps/api/src/catalog/sales/return-commit-deadline.ts` |
| The clock starts at receipt: `ReturnCommitDeadlineMiddleware` stamps a monotonic reading (`performance.now()`, injectable `DeadlineClock`) before every guard and interceptor; `ReturnCommitDeadlineModule` mounts it on `POST api/pos/v1/sales/:saleRef/returns`, `SalesModule` imports it | same file, `sales.module.ts` |
| So the budget includes authentication, the idempotency claim, the pool wait and the wait for the `sales` row lock (`lockSaleForReversal`) | `sales.controller.ts` `recordReturn` passes `commitDeadlineOf(request)` |
| Before **every** statement of the transaction, `statement_timeout` and `lock_timeout` are set (transaction-local, `set_config(..., true)`) to the budget left, floored to whole ms, or the statement is not sent when none is left (`0` would disable the timeout, so under 1 ms counts as expired). Statements are serialized so each arm is computed at its statement's turn | `CommitDeadline.guardClient` |
| Right before COMMIT, a synchronous check; a request past the deadline is rolled back, never committed | `CommitDeadline.assertOpen`, called by the `beforeCommit` hook of `runWithTenantContext` (`packages/db/src/middleware/tenant-context.ts`) |
| A cancelled statement or lock wait (`57014`, `55P03`) is the same refusal | `sale-returns.service.ts` `recordReturn`, `isDeadlineTimeoutError` |
| The refusal answers the contract's existing `SystemFailure` (500, `internal_error`, no cause returned). The `recordReturn` contract lists no 503 or 504, and none is invented. The idempotency interceptor stores successful responses only, so a retry re-runs | `ReturnDeadlineExceededError` is not an `HttpException` |

The exact guarantee is the pre-COMMIT check; the timeouts only end a wait early.
The replay and idempotency bytes are unchanged.

Known limits (also in the contract text where they matter):

- The stamp is taken by Nest middleware, after Node has accepted the connection
  and the body parser has read the (size-limited) body. The transport delay before
  receipt is not counted: the client's quiet period must cover it (contract).
- A client that disconnects does not cancel the handler. It commits only inside
  the bound, which is what BR-7 states; none commits after it.
- `recordCreditSaleReversal` (kind `return`) is outside the bound (the POS never
  returns a credit sale, RT-196 D-c). `not_recorded` makes no claim about it.

## The deployment assumption: `synchronous_commit` and the replica setting

The bound is on issuing COMMIT. If the database is configured so that a COMMIT
waits for a synchronous standby (`synchronous_commit` of `on`, `remote_write` or
`remote_apply`, with a non-empty `synchronous_standby_names`), the COMMIT can
block as long as the standby is unreachable, and cancelling that wait (a
`statement_timeout`, a client cancel) leaves the transaction **already committed
locally** (PostgreSQL documentation, "Synchronous Replication"). A timeout cannot
turn such a wait into "not committed". So the normative rollout precondition of
`readReturnStatusByProvenance` is: **no unbounded synchronous-replication commit
wait for the application role.**

### What the repository shows (searched 2026-11-22 on `origin/main` `db6bfbdde`)

| Environment | Evidence in the repo | Says about the setting |
| --- | --- | --- |
| Local dev | `docker-compose.dev.yml`: stock `postgres:16-alpine`, no `command:` or config | PostgreSQL defaults: `synchronous_commit = on`, `synchronous_standby_names` empty, so a COMMIT waits only for its own local WAL flush. Not production evidence. |
| Tests | `postgres:16-alpine` Testcontainers (`apps/api/test/_helpers/*`) | Same defaults. Not production evidence. |
| Lab (lab-02) | `.claude/skills/operating-rt-lab/SKILL.md` ("lab-02 Postgres and backups", an SSM-managed host); `deploy/lab/ssm/RT-BackendLabBackup.yaml` runs `sudo -u postgres psql` and `pg_dump -Fc` on the host | A host-installed PostgreSQL, backed up by a dump. The repo holds no `postgresql.conf`, no `synchronous_*` setting and no standby. A single node is the likely shape; **NOT VERIFIED**. |
| Production | `docker-compose.prod.yml` header: "PostgreSQL is expected to be an external managed service"; `deploy/prod.env.example`: `DATABASE_URL="<secret-manager-ref>"` | The managed service, its parameter group, its replicas and its Multi-AZ mode are not in the repo (no Terraform, CDK, CloudFormation or parameter group). **NOT VERIFIED**. |
| Application | `git grep` for `replica`, `REPLICA`, `hot_standby`, `target_session_attrs`, a read-only pool | The API and the worker use one pool per credential on the connection string they are given. No read replica is addressed from the code. |

Commands used (read-only): `git grep -n -i -E "synchronous_commit|synchronous_standby|multi_az|read replica|db_parameter_group|ParameterGroup"`,
`git ls-files | grep -E "\.tf$|cdk|cloudformation|compose"`, and reading the files
above. Nothing outside the repository was touched: no lab host, no AWS call.

### How the owner verifies it (read-only; run on each database the API uses)

These need the owner's decision to run on a lab host (SSM Run Command is a host
action, `operating-rt-lab`) and the provider console or an admin session for the
managed service. As the **application role** (the one in `DATABASE_URL`), and
once as an administrator:

```sql
SHOW synchronous_commit;
SHOW synchronous_standby_names;
SELECT application_name, state, sync_state FROM pg_stat_replication;
-- overrides that beat the server setting for the role or the database:
SELECT r.rolname, d.datname, s.setconfig
  FROM pg_db_role_setting s
  LEFT JOIN pg_roles r ON r.oid = s.setrole
  LEFT JOIN pg_database d ON d.oid = s.setdatabase;
```

Pass when, for the application role on the application database, either
`synchronous_standby_names` is empty (no synchronous standby: a COMMIT waits only
for local WAL flush) or `synchronous_commit` is `off` or `local`, and no role or
database override says otherwise. If a synchronous standby is configured, that is
an owner decision (for example a quorum `ANY n (...)` with a documented bounded
failure mode), recorded on RT-1548 before the gate is turned on.

**On a managed service the settings alone are not the evidence.** On AWS RDS or
Aurora the replication of a Multi-AZ **instance** deployment is storage-level,
not a PostgreSQL synchronous standby, so `synchronous_standby_names` reads as
empty (and `pg_stat_replication` shows no standby) while a COMMIT can still wait
for the standby's storage acknowledgement. Aurora and Multi-AZ **cluster**
deployments have their own, provider-defined commit and replica semantics. So for a
managed database the evidence is the **deployment type**, read from the console or
the API (for RDS, the instance's Multi-AZ flag and whether it belongs to a
cluster), and what the provider documents for that type about commit waits and
their failure behaviour. Record that deployment type beside the two GUC values.
Treat a Multi-AZ instance deployment as having a synchronous commit wait until the
provider's documentation for that type shows its failure mode is bounded; that is
an owner decision, recorded on RT-1548, not something the GUCs can settle. Read the
parameter group and the replica / Multi-AZ configuration, and record where each
was read.

Record the result (value, host or console, date, who) as a comment on RT-1548.

### An option this slice did not take

`SET LOCAL synchronous_commit = local` inside the `recordReturn` transaction would
remove the standby wait for this write whatever the deployment is. It was **not**
done: it changes the durability of a money-affecting write after a failover, which
is an owner decision, not a runtime detail. If the verification fails, this is the
smallest alternative to propose.

## Rollout order (the contract's ROLLOUT ORDER)

1. Deploy this runtime with `POS_RETURN_STATUS_READ_ENABLED` unset. The bound
   applies from the deploy (the middleware and the deadline are not behind a gate);
   the status route answers 404 whatever `POS_RETURNS_ENABLED` is.
2. Confirm every instance that serves `recordReturn` runs it (a rolling deploy
   leaves old instances without the bound until it completes; the flag is read per
   process, so set it only after the last instance has restarted).
3. Verify the database setting above and record it on RT-1548.
4. Set `POS_RETURN_STATUS_READ_ENABLED=true` on every API instance (`docker-compose.prod.yml` passes
   it from the host environment, default `false`; `deploy/prod.env.example` lists it). Both
   `POS_RETURNS_ENABLED` and this flag must be on; either off is the same 404, which
   a client reads as inconclusive, never as `not_recorded`.
5. Only then the POS repin and the close writer (RT-1498).

To switch the read off again, unset the flag; nothing else changes.
